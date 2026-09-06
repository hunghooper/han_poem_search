/**
 * The search pipeline — the spec §7, §8, §10.
 *
 *   colophon split -> exact -> (short circuit?) -> bm25 + vector -> RRF -> rerank
 *                  -> confidence policy -> rule verification -> answer
 *
 * Every stage emits started/completed events. A stage that does not emit is a stage the user
 * cannot see, including when it fails — which is §1's second unacceptable failure mode.
 */

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { normalize, toMatchForm, visualLines } from '@han/retrieval/normalize';
import { splitColophon } from '@han/retrieval/colophon';
import { hybridSearch } from '@han/retrieval/hybrid';
import { evaluateLocal } from '@han/retrieval/confidence';
import { verifyCandidate } from '@han/retrieval/verify';
import type { ModelClient } from '@han/retrieval/model-client';
import type { VectorStore } from '@han/retrieval/vector-store';
import type { Evidence } from '@han/shared/evidence';
import { StepStatus } from '@han/shared/status';
import { AggregateFlag } from '@han/shared/flags';
import type { RunStore } from './events.js';

export interface SearchOutcome {
  runId: string;
  status: StepStatus;
  confidence: number;
  reason: string;
  flags: string[];
  evidence: Evidence[];
  colophon: { lines: string[]; cyclicalDate: string | null } | null;
  verification: ReturnType<typeof verifyCandidate> | null;
}

export interface SearchDeps {
  db: NodePgDatabase<Record<string, never>>;
  model: ModelClient | null;
  vectors: VectorStore | null;
}

/** 句 of a poem's display text, in match form — what the verifier needs. */
const poemLines = (textDisplay: string): string[] =>
  textDisplay
    .split(/[\n，。！？；]/u)
    .map((s) => toMatchForm(s))
    .filter((s) => s.length > 0);

export async function runSearch(
  deps: SearchDeps,
  store: RunStore,
  runId: string,
  rawQuery: string,
): Promise<SearchOutcome> {
  store.emit(runId, {
    step: 'query_understanding',
    source: 'query',
    phase: 'started',
    message: 'Reading your query',
    metadata: { query: rawQuery },
  });

  // ---- 落款 ---------------------------------------------------------------
  // A transcription of a scroll ends with a signature block. Feeding it to the fragment
  // matcher wastes the query budget and, worse, lets a poet's name match unrelated poems.
  const colophon = splitColophon(rawQuery);
  const searchText = colophon.body.length > 0 ? colophon.body.join('\n') : rawQuery;

  if (colophon.colophonLines.length > 0) {
    store.emit(runId, {
      step: 'query_understanding',
      source: 'query',
      phase: 'completed',
      status: StepStatus.HAS_RESULT,
      message: `Set aside an inscription: ${colophon.colophonLines.join(' · ')}${colophon.cyclicalDate ? ` (${colophon.cyclicalDate})` : ''}`,
      metadata: { query: rawQuery, normalizedQuery: toMatchForm(searchText) },
    });
  }

  const norm = normalize(searchText);
  store.emit(runId, {
    step: 'normalization',
    source: 'query',
    phase: 'completed',
    status: StepStatus.HAS_RESULT,
    message: `Normalised to ${norm.textMatch.length} characters`,
    metadata: { query: rawQuery, normalizedQuery: norm.textMatch },
  });

  // ---- retrieval ----------------------------------------------------------
  store.emit(runId, {
    step: 'local_search',
    source: 'local',
    phase: 'started',
    message: 'Searching the corpus',
  });

  const result = await hybridSearch(searchText, deps);

  for (const [source, report] of Object.entries(result.reports)) {
    const step = source === 'reranker' ? 'reranker' : source === 'exact' ? 'exact' : source === 'bm25' ? 'bm25' : 'vector';
    store.emit(runId, {
      step: step as 'exact' | 'bm25' | 'vector' | 'reranker',
      source,
      phase: report.status === StepStatus.ERROR || report.status === StepStatus.TIMEOUT ? 'failed' : 'completed',
      status: report.status,
      flags: source === 'exact' ? result.exact.flags : [],
      message: describeSource(source, report.status, report.count, result.shortCircuited),
      metadata: {
        latencyMs: report.latencyMs,
        resultCount: report.count,
        ...(report.errorCode ? { errorCode: report.errorCode, errorMessage: report.errorMessage } : {}),
      },
    });
  }

  // ---- confidence (§8) ----------------------------------------------------
  const verdict = evaluateLocal({
    intent: 'fragment_lookup',
    exactMatch: {
      kind: result.exact.kind,
      workIds: result.exact.workIds,
      windowsMatched: result.exact.windowsMatched,
    },
    candidateCount: result.evidence.length,
    rerankScores: result.rerankScores,
    lexicalOverlap: result.lexicalOverlap,
  });

  store.emit(runId, {
    step: 'local_evaluation',
    source: 'local',
    phase: 'completed',
    status: verdict.status,
    flags: verdict.flags,
    message: verdict.reason,
    metadata: {
      confidence: verdict.confidence,
      resultCount: result.evidence.length,
      ...(result.rerankScores[0] !== undefined ? { topScore: result.rerankScores[0] } : {}),
    },
  });

  // ---- rule verification (§10.1) ------------------------------------------
  // Rules first, deterministic and free. The LLM verifier (§10.2) arrives in Phase 4 and only
  // sees what the rules could not decide.
  let verification: ReturnType<typeof verifyCandidate> | null = null;
  const top = result.evidence[0];

  if (top) {
    const inputLines = visualLines(searchText).map((l) => toMatchForm(l)).filter((l) => l.length > 0);
    verification = verifyCandidate(inputLines, poemLines(top.content));
    store.emit(runId, {
      step: 'rule_verification',
      source: 'rule_verify',
      phase: 'completed',
      status:
        verification.outcome === 'pass'
          ? StepStatus.HAS_RESULT
          : verification.outcome === 'fail'
            ? StepStatus.LOW_CONFIDENCE
            : StepStatus.SKIPPED,
      flags: verification.flags,
      message: verification.summary,
      metadata: { resultCount: verification.checks.length },
    });
  } else {
    store.emit(runId, {
      step: 'rule_verification',
      source: 'rule_verify',
      phase: 'completed',
      status: StepStatus.NOT_EXECUTED,
      message: 'Nothing to verify — no candidate',
    });
  }

  const allFlags = [...new Set([...result.exact.flags, ...verdict.flags, ...(verification?.flags ?? [])])];
  const found = allFlags.includes(AggregateFlag.LOCAL_RESULT_FOUND);

  if (!found) {
    store.emit(runId, {
      step: 'agent',
      source: 'model',
      phase: 'completed',
      status: StepStatus.NOT_EXECUTED,
      message: 'Agent fallback is not available yet (Phase 3)',
    });
  }

  const outcome: SearchOutcome = {
    runId,
    status: verdict.status,
    confidence: verdict.confidence,
    reason: verdict.reason,
    flags: allFlags,
    evidence: result.evidence,
    colophon:
      colophon.colophonLines.length > 0
        ? { lines: colophon.colophonLines, cyclicalDate: colophon.cyclicalDate }
        : null,
    verification,
  };
  // Settle before announcing: final_answer is the client's signal to fetch, so emitting first
  // opens a window where the answer is announced but not yet readable.
  store.setOutcome(runId, outcome);

  store.emit(runId, {
    step: 'final_answer',
    source: 'local',
    phase: 'completed',
    status: verdict.status,
    flags: allFlags,
    message:
      top && found
        ? `${top.title ?? '(untitled)'} — ${top.author ?? '(unknown)'}`
        : 'No confident answer from the local corpus',
    metadata: { confidence: verdict.confidence, resultCount: result.evidence.length },
  });

  return outcome;
}

function describeSource(
  source: string,
  status: StepStatus,
  count: number,
  shortCircuited: boolean,
): string {
  if (status === StepStatus.SKIPPED) {
    return shortCircuited
      ? 'Skipped — the exact match already resolved it'
      : 'Skipped';
  }
  if (status === StepStatus.UNAVAILABLE) return 'Not available — the model service is not running';
  if (status === StepStatus.TIMEOUT) return 'Timed out';
  if (status === StepStatus.ERROR) return 'Failed';
  const label: Record<string, string> = {
    exact: 'Exact match',
    bm25: 'Keyword search',
    vector: 'Semantic search',
    reranker: 'Re-ranked candidates',
  };
  const name = label[source] ?? source;
  return count === 0 ? `${name} — nothing found` : `${name} — ${count} result${count === 1 ? '' : 's'}`;
}
