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
import { runAgent, type AgentEvent } from '@han/agent/loop';
import { initialAgentState } from '@han/agent/state';
import { runTool, type Tool } from '@han/agent/tool';
import type { LlmProvider } from '@han/llm/provider';
import type { RuntimeConfig } from '@han/shared/runtime-config';
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
  /** Null when no gateway is configured — the agent step then reports UNAVAILABLE, not absent. */
  provider: LlmProvider | null;
  /** Must be a model that passed §4.5 checks 2-4. See docs/adr/002-llm-gateway.md. */
  reasoningModel: string | null;
  /**
   * Built per request from the resolved config, not once at boot: a session override that
   * names a different answer model has to reach the tool that uses it, and a tool constructed
   * at startup has already captured the environment's model for the life of the process.
   */
  makeTools: (config: RuntimeConfig) => Array<Tool<never>>;
  debug: boolean;
  /** Committed defaults with this request's session overrides already applied. */
  config: RuntimeConfig;
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

  const result = await hybridSearch(searchText, {
    db: deps.db,
    model: deps.model,
    vectors: deps.vectors,
    fuseTopN: deps.config.retrieval.fuseTopN,
    topK: deps.config.retrieval.topK,
    rrfK: deps.config.retrieval.rrfK,
    maxWindowsPerReading: deps.config.retrieval.maxWindowsPerReading,
    maxReadings: deps.config.retrieval.maxReadings,
    sources: deps.config.retrieval.sources,
  });

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
  }, deps.config.confidence);

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
  const allFlagsSoFar = [...result.exact.flags, ...verdict.flags];

  if (top) {
    const inputLines = visualLines(searchText).map((l) => toMatchForm(l)).filter((l) => l.length > 0);
    verification = verifyCandidate(
      inputLines,
      poemLines(top.content),
      allFlagsSoFar.includes(AggregateFlag.INPUT_REORDERED),
    );
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

  // §9: the agent fires only when local retrieval could not confidently answer. Given the
  // §7.1 short-circuit this should be a minority of queries.
  let agentPartial = false;

  /**
   * Don't spend the agent on input that is not a poem fragment at all.
   *
   * MEASURED: the nonsense control 龘龘龘龘龘龘 correctly gets no_local_result, and then the
   * agent runs anyway and burns the full 60-second budget and real tokens on it. §9 does put
   * no_local_result on the agent's path, but zero lexical overlap means not one character of
   * the query appears in ANY candidate drawn from 78,455 poems — that is not a hard question,
   * it is not a question about this corpus. A Vietnamese Hán-Nôm query is unaffected: its
   * characters are ordinary ones that overlap heavily, which is exactly why it deserves the
   * agent and this does not.
   */
  const notEvenClose =
    deps.config.agent.skipWhenNoOverlap &&
    result.exact.kind === 'none' &&
    result.lexicalOverlap !== null &&
    result.lexicalOverlap === 0;

  if (!found && notEvenClose) {
    store.emit(runId, {
      step: 'agent',
      source: 'model',
      phase: 'completed',
      status: StepStatus.SKIPPED,
      message:
        'Agent skipped — the query shares no characters with anything in the corpus, so there is nothing here to reason about',
    });
  } else if (!found) {
    if (!deps.config.agent.enabled) {
      store.emit(runId, {
        step: 'agent',
        source: 'model',
        phase: 'completed',
        status: StepStatus.SKIPPED,
        message: 'Agent is switched off in settings',
      });
    } else if (!deps.provider || !deps.reasoningModel) {
      store.emit(runId, {
        step: 'agent',
        source: 'model',
        phase: 'completed',
        status: StepStatus.UNAVAILABLE,
        message: 'No LLM gateway is configured — the agent could not run',
        metadata: { errorCode: 'TOOL_UNAVAILABLE' },
      });
    } else {
      store.emit(runId, { step: 'agent', source: 'model', phase: 'started', message: 'Agent took over' });

      try {
      const agentOut = await runAgent(
        initialAgentState(
          searchText,
          allFlags,
          Object.entries(result.reports).map(([source, r]) => ({
            source,
            status: r.status,
            resultCount: r.count,
            latencyMs: r.latencyMs,
          })),
        ),
        {
          provider: deps.provider,
          model: deps.config.models.reasoning ?? deps.reasoningModel,
          tools: deps.makeTools(deps.config),
          budget: {
            maxIterations: deps.config.agent.maxIterations,
            maxToolCalls: deps.config.agent.maxToolCalls,
            maxWallClockMs: deps.config.agent.maxWallClockMs,
            maxCostUsd: deps.config.agent.maxCostUsd,
          },
          now: () => Date.now(),
          debug: deps.debug,
          signal: AbortSignal.timeout(deps.config.agent.maxWallClockMs),
          emit: (e: AgentEvent) => emitAgentEvent(store, runId, e),
        },
        runTool,
      );

      agentPartial = agentOut.partial;
      for (const f of [...agentOut.flags, ...agentOut.state.flags]) {
        if (!allFlags.includes(f)) allFlags.push(f);
      }

      // Agent evidence goes FIRST, not last. The agent only ran because the local results were
      // judged insufficient, so leaving them ranked above what the agent found means the
      // answer reports the very candidate the confidence policy just rejected — which is what
      // happened: a Vietnamese poem correctly identified by the agent was displayed as
      // 憶潼關 via bm25, the low-confidence local hit.
      const fresh = agentOut.state.evidence.filter((ev) => !result.evidence.some((x) => x.id === ev.id));
      result.evidence = [...fresh, ...result.evidence];

      store.emit(runId, {
        step: 'agent',
        source: 'model',
        phase: 'completed',
        status: agentOut.state.evidence.length > 0 ? StepStatus.HAS_RESULT : StepStatus.NO_RESULT,
        flags: agentOut.flags,
        message:
          agentOut.state.evidence.length > 0
            ? `Agent found ${agentOut.state.evidence.length} result${agentOut.state.evidence.length === 1 ? '' : 's'}`
            : `Agent stopped — ${agentOut.stoppedBecause.replace(/_/gu, ' ')}`,
        metadata: { resultCount: agentOut.state.evidence.length },
      });
      } catch (e) {
        // Belt and braces. runAgent already converts its own failures into a partial outcome,
        // but nothing may prevent this run from reaching final_answer — a run that never
        // terminates is worse than one that terminates badly, because the caller cannot tell
        // the difference between "still working" and "dead".
        const message = e instanceof Error ? e.message : String(e);
        agentPartial = true;
        store.emit(runId, {
          step: 'agent',
          source: 'model',
          phase: 'failed',
          status: StepStatus.ERROR,
          message: 'The agent failed — answering from the evidence collected so far',
          metadata: { errorCode: 'INTERNAL', errorMessage: message },
        });
      }
    }
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

  // §11: search_run.final_* is a materialized convenience. It is written from exactly the
  // values the final_answer event carries, so a fold over the log reproduces it — there is a
  // test asserting that property against the real database.
  store.finalize({
    runId,
    query: rawQuery,
    normalizedQuery: norm.textMatch,
    finalStatus: verdict.status,
    finalConfidence: verdict.confidence,
    finalFlags: allFlags,
    finalAnswer: answerMessage(result.evidence[0], allFlags, agentPartial),
    totalCostUsd: 0,
    agentInvoked: !found,
  });

  store.emit(runId, {
    step: 'final_answer',
    source: 'local',
    phase: 'completed',
    status: verdict.status,
    flags: allFlags,
    message: answerMessage(result.evidence[0], allFlags, agentPartial),
    metadata: { confidence: verdict.confidence, resultCount: result.evidence.length },
  });

  return outcome;
}

/**
 * Agent events onto the §5.2 event stream. The whole agent path must be visible — §16's Phase 3
 * criterion is not just that the fallback works but that the user can see it working.
 */
function emitAgentEvent(store: RunStore, runId: string, e: AgentEvent): void {
  const step = e.kind === 'tool_call' ? 'tool_call' : 'agent';
  store.emit(runId, {
    step,
    source: e.tool ?? 'model',
    phase: e.kind === 'budget_exhausted' ? 'failed' : 'completed',
    ...(e.status ? { status: e.status } : {}),
    flags: e.flags ?? [],
    agentIteration: e.iteration,
    message: e.message,
    metadata: {
      ...(e.latencyMs !== undefined ? { latencyMs: e.latencyMs } : {}),
      ...(e.provider ? { provider: e.provider } : {}),
      ...(e.model ? { model: e.model } : {}),
      ...(e.costUsd !== undefined && e.costUsd !== null ? { costUsd: e.costUsd } : {}),
    },
  });
}

function answerMessage(
  top: Evidence | undefined,
  flags: string[],
  partial: boolean,
): string {
  const suffix = partial ? ' (partial — the agent ran out of budget)' : '';
  // A rejected candidate is not an answer. Naming the top row when the policy already returned
  // no_local_result is §1's "silent success" — returning documents and calling it an answer.
  // The candidates stay in the evidence list for the debug view; they do not become the answer.
  if (flags.includes(AggregateFlag.NO_LOCAL_RESULT)) {
    return `No confident answer — nothing in the corpus matches${suffix}`;
  }
  if (!top) return `No confident answer${suffix}`;
  if (flags.includes(AggregateFlag.LOCAL_RESULT_FOUND)) {
    return `${top.title ?? '(untitled)'} — ${top.author ?? '(unknown)'}${suffix}`;
  }
  // Reached only via the agent: label the source, since it is not the local corpus.
  return `${top.title ?? top.content.slice(0, 30)} — via ${top.source}${suffix}`;
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
