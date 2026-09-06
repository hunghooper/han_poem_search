/**
 * The Phase 1 search pipeline: normalize -> exact_ngram -> evaluate -> answer.
 *
 * Every stage emits started/completed events. The fast path (§7.1) completes without any LLM
 * call; the agent arrives in Phase 3 and slots in after local_evaluation.
 */

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { normalize } from '@han/retrieval/normalize';
import { exactNgramSearch } from '@han/retrieval/sources/exact-ngram';
import { evaluateLocal } from '@han/retrieval/confidence';
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
}

/** Group line hits into one Evidence per work, so the UI shows poems and not fragments. */
function toEvidence(hits: Awaited<ReturnType<typeof exactNgramSearch>>['hits']): Evidence[] {
  const byWork = new Map<string, Evidence>();
  for (const h of hits) {
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
      // Provenance is required on local results (§3.1 item 4) — the dataset is crawled, and
      // this is what lets a result say "what this dataset says", pinned to a commit.
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
}

export async function runSearch(
  db: NodePgDatabase<Record<string, never>>,
  store: RunStore,
  runId: string,
  query: string,
): Promise<SearchOutcome> {
  store.emit(runId, {
    step: 'query_understanding',
    source: 'query',
    phase: 'started',
    message: 'Reading your query',
    metadata: { query },
  });

  const norm = normalize(query);
  store.emit(runId, {
    step: 'normalization',
    source: 'query',
    phase: 'completed',
    status: StepStatus.HAS_RESULT,
    message: `Normalised to ${norm.textMatch.length} characters`,
    metadata: { query, normalizedQuery: norm.textMatch },
  });

  store.emit(runId, {
    step: 'exact',
    source: 'exact',
    phase: 'started',
    message: 'Looking for an exact match in the corpus',
  });

  let exact: Awaited<ReturnType<typeof exactNgramSearch>>;
  try {
    exact = await exactNgramSearch(db, query);
  } catch (e) {
    // A retriever that fails must say so. Reporting this as "found nothing" is the opaque
    // failure §1 calls unacceptable — the user would be told the poem is not in the corpus.
    const message = e instanceof Error ? e.message : String(e);
    store.emit(runId, {
      step: 'exact',
      source: 'exact',
      phase: 'failed',
      status: StepStatus.ERROR,
      message: 'The exact-match index failed',
      metadata: { errorCode: 'INDEX_QUERY_FAILED', errorMessage: message },
    });
    return {
      runId,
      status: StepStatus.ERROR,
      confidence: 0,
      reason: `exact_ngram failed: ${message}`,
      flags: ['exact_error'],
      evidence: [],
    };
  }

  const evidence = toEvidence(exact.hits);
  store.emit(runId, {
    step: 'exact',
    source: 'exact',
    phase: 'completed',
    status: exact.kind === 'none' ? StepStatus.NO_RESULT : StepStatus.HAS_RESULT,
    flags: exact.flags,
    message:
      exact.kind === 'none'
        ? 'No exact match in the corpus'
        : `Exact match — longest run ${exact.longestRun} characters across ${exact.windowsMatched} windows`,
    metadata: { latencyMs: exact.latencyMs, resultCount: evidence.length, topScore: exact.longestRun },
  });

  const verdict = evaluateLocal({
    intent: 'fragment_lookup',
    exactMatch: { kind: exact.kind, workIds: exact.workIds, windowsMatched: exact.windowsMatched },
    candidateCount: exact.hits.length,
    rerankScores: [],
  });

  store.emit(runId, {
    step: 'local_evaluation',
    source: 'local',
    phase: 'completed',
    status: verdict.status,
    flags: verdict.flags,
    message: verdict.reason,
    metadata: { confidence: verdict.confidence, resultCount: evidence.length },
  });

  const allFlags = [...new Set([...exact.flags, ...verdict.flags])];

  // Phase 1 has no semantic layer and no agent. Saying so explicitly is the difference between
  // "not in the corpus" and "we only looked one way" (§1, failure mode 2).
  if (!allFlags.includes(AggregateFlag.LOCAL_RESULT_FOUND)) {
    store.emit(runId, {
      step: 'vector',
      source: 'vector',
      phase: 'completed',
      status: StepStatus.NOT_EXECUTED,
      message: 'Semantic search is not available yet (Phase 2)',
    });
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
    evidence,
  };
  // Settle the result BEFORE emitting final_answer. The event is the client's signal to fetch,
  // so emitting first opens a window where the answer is announced but not yet readable — a
  // race that shows up as an empty answer panel on a successful run.
  store.setOutcome(runId, outcome);

  store.emit(runId, {
    step: 'final_answer',
    source: 'local',
    phase: 'completed',
    status: verdict.status,
    flags: allFlags,
    message:
      evidence[0] && allFlags.includes(AggregateFlag.LOCAL_RESULT_FOUND)
        ? `${evidence[0].title ?? '(untitled)'} — ${evidence[0].author ?? '(unknown)'}`
        : 'No confident answer from the local corpus',
    metadata: { confidence: verdict.confidence, resultCount: evidence.length },
  });

  return outcome;
}
