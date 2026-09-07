/**
 * Hybrid retrieval — the spec §7.2.
 *
 *   exact_ngram + bm25 + vector  ->  RRF  ->  cross-encoder rerank  ->  top-k
 *
 * The order matters and is not the usual one. `exact_ngram` runs FIRST and can short-circuit
 * the whole pipeline (§7.1): for the dominant user story — a pasted fragment — a contiguous
 * match resolving to one work is a better answer than anything fusion could produce, and it
 * arrives in single-digit milliseconds with no model in the loop.
 *
 * Everything below the short-circuit exists for the queries exact matching cannot serve:
 * topical description, mood, paraphrase. §7.2 says to expect dense retrieval to underperform
 * on five-character classical lines and to carry topical queries instead. That is measured by
 * the eval harness, not assumed here.
 */

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Evidence } from '@han/shared/evidence';
import { StepStatus } from '@han/shared/status';
import { exactNgramSearch, type ExactMatch } from './sources/exact-ngram.js';
import { bm25Search } from './sources/bm25.js';
import { reciprocalRankFusion, type RankedList } from './fusion.js';
import type { ModelClient } from './model-client.js';
import type { VectorStore } from './vector-store.js';
import { toMatchForm } from './normalize.js';

/**
 * Share of the query's distinct characters that appear in a candidate.
 *
 * Deliberately character-level and set-based: it asks "is this candidate even about the same
 * words", not "how similar is it". Cheap, deterministic, and immune to the confident-nonsense
 * failure a cross-encoder exhibits on out-of-distribution input.
 */
export function lexicalOverlap(query: string, candidate: string): number | null {
  const q = new Set(toMatchForm(query));
  if (q.size === 0) return null;
  const c = new Set(toMatchForm(candidate));
  let shared = 0;
  for (const ch of q) if (c.has(ch)) shared += 1;
  return shared / q.size;
}

export interface SourceReport {
  status: StepStatus;
  count: number;
  latencyMs: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface HybridResult {
  exact: ExactMatch;
  evidence: Evidence[];
  /** Descending rerank scores of `evidence`, for the confidence policy. */
  rerankScores: number[];
  /** Share of the query's distinct characters present in the best candidate, 0..1. */
  lexicalOverlap: number | null;
  shortCircuited: boolean;
  reports: Record<string, SourceReport>;
}

export interface HybridOptions {
  db: NodePgDatabase<Record<string, never>>;
  model: ModelClient | null;
  vectors: VectorStore | null;
  /** Candidates into the reranker (§7.2 default 50). */
  fuseTopN?: number;
  /** Results out (§7.2 default 8). */
  topK?: number;
  /**
   * Which sources take part. exact_ngram is deliberately not listed: it is the primary
   * retriever (§7.1), and a search that cannot run it is not this system.
   */
  sources?: { bm25?: boolean; vector?: boolean; reranker?: boolean };
  /** RRF constant (§7.2). */
  rrfK?: number;
  /** Reorder fan-out limits (ADR 003). */
  maxWindowsPerReading?: number;
  maxReadings?: number;
}

const evidenceFromExact = (m: ExactMatch): Evidence[] => {
  const byWork = new Map<string, Evidence>();
  for (const h of m.hits) {
    const existing = byWork.get(h.workId);
    if (existing) {
      const lines = (existing.metadata.matchedLines as string[] | undefined) ?? [];
      if (!lines.includes(h.textDisplay)) lines.push(h.textDisplay);
      existing.metadata.matchedLines = lines;
      existing.score = lines.length;
      continue;
    }
    byWork.set(h.workId, {
      id: h.workId,
      source: 'exact',
      retrievalMethod: 'exact_ngram',
      workId: h.workId,
      title: h.title,
      author: h.author,
      dynasty: null,
      edition: h.edition,
      provenance: { dataset: h.dataset, file: h.sourceFile, commitSha: h.commitSha },
      url: null,
      content: h.poemTextDisplay,
      matchedSpan: null,
      score: 1,
      rerankScore: null,
      metadata: { matchedLines: [h.textDisplay] },
    });
  }
  return [...byWork.values()].sort((a, b) => b.score - a.score);
};

/**
 * Run one retriever, converting any failure into a report rather than an exception.
 *
 * §5.4's table applies to retrievers as much as to agent tools: a source that timed out and a
 * source that found nothing must not arrive at the confidence policy looking the same.
 */
async function runSource<T>(
  name: string,
  reports: Record<string, SourceReport>,
  fn: () => Promise<T[]>,
): Promise<T[]> {
  const started = Date.now();
  try {
    const items = await fn();
    reports[name] = {
      status: items.length > 0 ? StepStatus.HAS_RESULT : StepStatus.NO_RESULT,
      count: items.length,
      latencyMs: Date.now() - started,
    };
    return items;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    const timedOut = err.code === 'TOOL_TIMEOUT';
    reports[name] = {
      status: timedOut ? StepStatus.TIMEOUT : StepStatus.ERROR,
      count: 0,
      latencyMs: Date.now() - started,
      errorCode: err.code ?? 'INTERNAL',
      errorMessage: err.message ?? String(e),
    };
    return [];
  }
}

export async function hybridSearch(
  query: string,
  opts: HybridOptions,
): Promise<HybridResult> {
  const { db, model, vectors } = opts;
  const fuseTopN = opts.fuseTopN ?? 50;
  const topK = opts.topK ?? 8;
  const reports: Record<string, SourceReport> = {};

  // ---- exact, first and possibly last (§7.1) --------------------------------
  const exactStarted = Date.now();
  const exact = await exactNgramSearch(db, query, {
    ...(opts.maxWindowsPerReading !== undefined ? { maxWindowsPerReading: opts.maxWindowsPerReading } : {}),
    ...(opts.maxReadings !== undefined ? { maxReadings: opts.maxReadings } : {}),
  });
  reports.exact = {
    status: exact.kind === 'none' ? StepStatus.NO_RESULT : StepStatus.HAS_RESULT,
    count: exact.hits.length,
    latencyMs: Date.now() - exactStarted,
  };

  if (exact.kind === 'full' && exact.workIds.length === 1) {
    // Short-circuit. Running fusion here would spend a GPU round trip to re-derive an answer
    // we already hold with certainty, and could only demote it.
    const evidence = evidenceFromExact(exact);
    reports.bm25 = { status: StepStatus.SKIPPED, count: 0, latencyMs: 0 };
    reports.vector = { status: StepStatus.SKIPPED, count: 0, latencyMs: 0 };
    reports.reranker = { status: StepStatus.SKIPPED, count: 0, latencyMs: 0 };
    return { exact, evidence, rerankScores: [], lexicalOverlap: null, shortCircuited: true, reports };
  }

  // ---- lexical and dense, in parallel ---------------------------------------
  // A source switched off reports SKIPPED, not NO_RESULT: "we did not look" and "we looked
  // and found nothing" are the distinction §5.4 exists to preserve, and a settings toggle must
  // not be able to erase it.
  const on = { bm25: opts.sources?.bm25 !== false, vector: opts.sources?.vector !== false };
  const rerankOn = opts.sources?.reranker !== false;

  // The toggle is decided HERE, not inside runSource: runSource sets the report from what the
  // function returned, so a SKIPPED written inside it is immediately overwritten with
  // NO_RESULT — turning "we did not look" into "we looked and found nothing", which is the one
  // conflation §5.4 exists to prevent.
  const skip = (name: string) => {
    reports[name] = { status: StepStatus.SKIPPED, count: 0, latencyMs: 0 };
    return Promise.resolve([]);
  };

  const [bm25Hits, vectorHits] = await Promise.all([
    on.bm25 ? runSource('bm25', reports, () => bm25Search(db, query, fuseTopN)) : skip('bm25'),
    !on.vector
      ? skip('vector')
      : runSource('vector', reports, async () => {
      if (!model || !vectors) {
        reports.vector = {
          status: StepStatus.UNAVAILABLE,
          count: 0,
          latencyMs: 0,
          errorCode: 'TOOL_UNAVAILABLE',
          errorMessage: 'model sidecar or vector store not configured',
        };
        return [];
      }
      const [vec] = await model.embed([query]);
      if (!vec) return [];
      return vectors.search(vec, fuseTopN);
        }),
  ]);

  // ---- fuse -----------------------------------------------------------------
  const lists: Array<RankedList<Evidence>> = [];
  const exactEvidence = evidenceFromExact(exact);
  if (exactEvidence.length > 0) lists.push({ source: 'exact', items: exactEvidence });

  if (bm25Hits.length > 0) {
    lists.push({
      source: 'bm25',
      items: bm25Hits.map((h) => ({
        id: h.workId,
        source: 'bm25',
        retrievalMethod: 'bm25' as const,
        workId: h.workId,
        title: h.title,
        author: h.author,
        dynasty: null,
        edition: h.edition,
        provenance: { dataset: h.dataset, file: h.sourceFile, commitSha: h.commitSha },
        url: null,
        content: h.textDisplay,
        matchedSpan: null,
        score: h.score,
        rerankScore: null,
        metadata: {},
      })),
    });
  }

  if (vectorHits.length > 0) {
    lists.push({
      source: 'vector',
      items: vectorHits.map((h) => ({
        id: h.payload.workId,
        source: 'vector',
        retrievalMethod: 'vector' as const,
        workId: h.payload.workId,
        title: h.payload.title,
        author: h.payload.author,
        dynasty: null,
        edition: h.payload.edition,
        provenance: {
          dataset: h.payload.dataset,
          file: h.payload.sourceFile,
          commitSha: h.payload.commitSha,
        },
        url: null,
        content: h.payload.textDisplay,
        matchedSpan: null,
        score: h.score,
        rerankScore: null,
        metadata: { vectorScore: h.score },
      })),
    });
  }

  if (lists.length === 0) {
    return { exact, evidence: [], rerankScores: [], lexicalOverlap: null, shortCircuited: false, reports };
  }

  const fused = reciprocalRankFusion(
    lists,
    (e) => e.workId ?? e.id,
    // Keep the richer record: exact hits carry matchedLines, vector hits carry the payload.
    (a, b) => ({ ...b, ...a, metadata: { ...b.metadata, ...a.metadata } }),
    opts.rrfK,
  ).slice(0, fuseTopN);

  // ---- rerank ---------------------------------------------------------------
  let evidence = fused.map((f) => ({
    ...f.item,
    score: f.score,
    metadata: { ...f.item.metadata, rrfRanks: f.ranks, agreement: f.agreement },
  }));

  const rerankStarted = Date.now();
  if (!rerankOn) {
    reports.reranker = { status: StepStatus.SKIPPED, count: 0, latencyMs: 0 };
  } else if (model && evidence.length > 0) {
    try {
      const scores = await model.rerank(
        toMatchForm(query) || query,
        evidence.map((e) => e.content),
      );
      evidence = evidence
        .map((e, i) => ({ ...e, rerankScore: scores[i] ?? null }))
        .sort((a, b) => (b.rerankScore ?? -Infinity) - (a.rerankScore ?? -Infinity));
      reports.reranker = {
        status: StepStatus.HAS_RESULT,
        count: evidence.length,
        latencyMs: Date.now() - rerankStarted,
      };
    } catch (e) {
      // A reranker failure must NOT silently fall back to RRF order and be reported as a
      // successful search — the confidence policy reads rerank scores, and their absence is
      // exactly the `local_incomplete` condition.
      const err = e as { code?: string; message?: string };
      reports.reranker = {
        status: err.code === 'TOOL_TIMEOUT' ? StepStatus.TIMEOUT : StepStatus.ERROR,
        count: 0,
        latencyMs: Date.now() - rerankStarted,
        errorCode: err.code ?? 'INTERNAL',
        errorMessage: err.message ?? String(e),
      };
    }
  } else {
    reports.reranker = {
      status: StepStatus.UNAVAILABLE,
      count: 0,
      latencyMs: 0,
      errorCode: 'TOOL_UNAVAILABLE',
      errorMessage: 'model sidecar not configured',
    };
  }

  const top = evidence.slice(0, topK);
  const rerankScores = top
    .map((e) => e.rerankScore)
    .filter((s): s is number => s !== null);

  const best = top[0];
  return {
    exact,
    evidence: top,
    rerankScores,
    lexicalOverlap: best ? lexicalOverlap(query, best.content) : null,
    shortCircuited: false,
    reports,
  };
}
