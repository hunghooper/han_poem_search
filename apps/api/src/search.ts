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
import { normalize, prosodyLines, toMatchForm } from '@han/retrieval/normalize';
import { splitColophon } from '@han/retrieval/colophon';
import { hybridSearch } from '@han/retrieval/hybrid';
import { evaluateLocal } from '@han/retrieval/confidence';
import { verifyCandidate } from '@han/retrieval/verify';
import type { ModelClient } from '@han/retrieval/model-client';
import type { VectorStore } from '@han/retrieval/vector-store';
import type { Evidence } from '@han/shared/evidence';
import { StepStatus } from '@han/shared/status';
import { AggregateFlag, flag } from '@han/shared/flags';
import { verifyWithLlm, type Verdict } from '@han/agent/verify-llm';
import { runAgentWorkflow } from '@han/worker/client';
import type { AgentRunOutput } from '@han/worker/shared';
import type { AgentEventBridge } from './agent-bridge.js';
import type { Tool } from '@han/agent/tool';
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
  /** §10.2's judgement, or null when it did not run. Null is not "passed". */
  llmVerdict: { verdict: string; confidence: number; notes: string } | null;
}

export interface SearchDeps {
  db: NodePgDatabase<Record<string, never>>;
  model: ModelClient | null;
  vectors: VectorStore | null;
  /** Null when no gateway is configured — the agent step then reports UNAVAILABLE, not absent. */
  provider: LlmProvider | null;
  /** Must be a model that passed §4.5 checks 2-4. See docs/adr/002-llm-gateway.md. */
  reasoningModel: string | null;
  /** §10.2's judge. A session override wins; otherwise the environment's. */
  verifyModel: string | null;
  /**
   * Built per request from the resolved config, not once at boot: a session override that
   * names a different answer model has to reach the tool that uses it, and a tool constructed
   * at startup has already captured the environment's model for the life of the process.
   */
  makeTools: (config: RuntimeConfig) => Array<Tool<never>>;
  /** Relays the worker's workflow events into this instance's stream (§14.1). */
  bridge: AgentEventBridge;
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

/**
 * How the agent's own step ended (§5.1).
 *
 * The four outcomes below are deliberately not one. NO_RESULT means the agent looked and
 * found nothing; ERROR means it could not reason at all; SKIPPED means it never had a tool to
 * try; LOW_CONFIDENCE means it worked until the budget ran out. Reporting the last three as
 * NO_RESULT is the collapse §5 calls the most damaging mistake available, because each asks
 * for a different fix and only one of them is "the corpus does not have it".
 */
export function agentStatusOf(out: AgentRunOutput): StepStatus {
  if (out.evidence.length > 0) return StepStatus.HAS_RESULT;
  switch (out.stoppedBecause) {
    case 'model_failed':
      return StepStatus.ERROR;
    case 'no_tools_available':
      return StepStatus.SKIPPED;
    case 'budget_exhausted':
      return StepStatus.LOW_CONFIDENCE;
    default:
      return StepStatus.NO_RESULT;
  }
}

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
    // prosodyLines, not visualLines: a spreadsheet cell holds a whole couplet on one line
    // separated by 、，。 and the form check would otherwise compare ten characters against a
    // 五言 poem's five and fail a poem it matched exactly. See normalize.ts.
    const inputLines = prosodyLines(searchText)
      .map((l) => toMatchForm(l))
      .filter((l) => l.length > 0);
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
      // Flagged, not just emitted. FOUND ON REAL DATA: a 14,519-row batch ran with the agent
      // switched on and a $100 cap, the gateway was not configured, every run said so in its
      // trace — and the exported spreadsheet said nothing at all, because these branches
      // emitted an event without adding a flag to the outcome. Nobody opens 14,519 traces.
      // The file has to carry it, and `flags` is how anything reaches the file.
      allFlags.push(flag('model', StepStatus.SKIPPED));
      store.emit(runId, {
        step: 'agent',
        source: 'model',
        phase: 'completed',
        status: StepStatus.SKIPPED,
        flags: [flag('model', StepStatus.SKIPPED)],
        message: 'Agent is switched off in settings',
      });
    } else if (!deps.provider || !deps.reasoningModel) {
      // The one that matters most: the user ASKED for the agent and did not get it. Switched
      // off is a choice; unavailable is a broken expectation, and they must not look alike.
      allFlags.push(flag('model', StepStatus.UNAVAILABLE));
      store.emit(runId, {
        step: 'agent',
        source: 'model',
        phase: 'completed',
        status: StepStatus.UNAVAILABLE,
        flags: [flag('model', StepStatus.UNAVAILABLE)],
        message: 'No LLM gateway is configured — the agent could not run',
        metadata: { errorCode: 'TOOL_UNAVAILABLE' },
      });
    } else {
      store.emit(runId, { step: 'agent', source: 'model', phase: 'started', message: 'Agent took over' });

      try {
        // The loop now lives in Temporal (§9.1). Killing the worker mid-run loses nothing:
        // history is durable and a restarted worker replays and continues. The trace arrives
        // over Redis while the workflow runs, so the stream is unchanged from the caller's
        // point of view.
        const stopRelay = await deps.bridge.relay(runId);
        if (!deps.bridge.available) {
          store.emit(runId, {
            step: 'agent',
            source: 'model',
            phase: 'started',
            message: 'Agent running — live trace unavailable (no Redis), the answer will still arrive',
          });
        }

        let agentOut;
        try {
          agentOut = await runAgentWorkflow({
            runId,
            query: searchText,
            flags: allFlags,
            sources: Object.entries(result.reports).map(([source, r]) => ({
              source,
              status: r.status,
              resultCount: r.count,
              latencyMs: r.latencyMs,
            })),
            config: deps.config,
            debug: deps.debug,
          });
        } finally {
          await stopRelay();
        }

      agentPartial = agentOut.partial;
      for (const f of [...agentOut.flags, ...(agentOut.evidence.length > 0 ? ['model_has_result'] : [])]) {
        if (!allFlags.includes(f)) allFlags.push(f);
      }

      // Agent evidence goes FIRST, not last. The agent only ran because the local results were
      // judged insufficient, so leaving them ranked above what the agent found means the
      // answer reports the very candidate the confidence policy just rejected.
      const fresh = agentOut.evidence.filter((ev) => !result.evidence.some((x) => x.id === ev.id));
      result.evidence = [...fresh, ...result.evidence];

      // THE terminal agent event — exactly one, emitted here rather than inside the workflow.
      // The workflow's own terminal emit used to race this code's stopRelay() and could be
      // dropped in flight, so the reason an agent gave up was reported only sometimes.
      const agentStatus = agentStatusOf(agentOut);
      store.emit(runId, {
        step: 'agent',
        source: 'model',
        phase: agentStatus === StepStatus.ERROR ? 'failed' : 'completed',
        status: agentStatus,
        flags: agentOut.flags,
        message:
          agentOut.evidence.length > 0
            ? `Agent found ${agentOut.evidence.length} result${agentOut.evidence.length === 1 ? '' : 's'}`
            : (agentOut.stopDetail ??
              `Agent stopped — ${agentOut.stoppedBecause.replace(/_/gu, ' ')}`),
        metadata: { resultCount: agentOut.evidence.length },
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

  /**
   * §10.2 — the second model. It does not search; it reads what the run collected and says
   * whether that evidence settles the query.
   *
   * This is what tells a FINDING from a REFUSAL. `ask_model` counts any non-empty reply as a
   * result, so a researcher answering "I do not recognise this, it looks like OCR damage" —
   * honest and correct — was recorded as `model_has_result` and turned a correct `no_result`
   * into a `low_confidence` guess. Distinguishing the two means reading the text, which is a
   * job for a model, not for a flag.
   */
  let llmVerdict: Verdict | null = null;
  const judgeModel = deps.config.models.verify ?? deps.verifyModel;
  const worthJudging = allFlags.includes(AggregateFlag.MODEL_HAS_RESULT);

  if (worthJudging && deps.provider && judgeModel) {
    store.emit(runId, {
      step: 'llm_verification',
      source: 'llm_verify',
      phase: 'started',
      message: 'Checking whether the evidence actually settles it',
    });

    const judged = await verifyWithLlm(
      { query: searchText, evidence: result.evidence, flags: allFlags },
      {
        provider: deps.provider,
        model: judgeModel,
        signal: AbortSignal.timeout(60_000),
      },
    );

    if (!judged) {
      // The check did not happen. Saying so is not the same as saying it passed.
      store.emit(runId, {
        step: 'llm_verification',
        source: 'llm_verify',
        phase: 'completed',
        status: StepStatus.UNAVAILABLE,
        message: 'The verifier could not be reached — the evidence is unchecked',
      });
    } else {
      llmVerdict = judged.verdict;
      store.emit(runId, {
        step: 'llm_verification',
        source: 'llm_verify',
        phase: 'completed',
        status:
          llmVerdict.verdict === 'sufficient'
            ? StepStatus.HAS_RESULT
            : StepStatus.LOW_CONFIDENCE,
        message: `${llmVerdict.verdict} — ${llmVerdict.notes || 'no note'}`,
        metadata: {
          confidence: llmVerdict.confidence,
          model: judged.model,
          provider: judged.provider,
          ...(judged.costUsd !== null ? { costUsd: judged.costUsd } : {}),
        },
      });
    }
  }

  /**
   * The run's status, which is NOT the local layer's verdict.
   *
   * `verdict` is computed before the agent runs, so a run where the corpus found nothing and
   * the AGENT then found something reported `no_result` while carrying `model_has_result` and
   * the agent's evidence. Reported by a user from a real batch: the flag said the model had
   * found the poem and the title, author and form columns were empty, because the export
   * blanks identity for a row that says it found nothing — correctly, given the status it was
   * handed.
   *
   * Raised to LOW_CONFIDENCE, never to HAS_RESULT: a model-sourced answer has not been matched
   * against the corpus, and this system does not promote an unverified claim to a confident
   * one. LOW_CONFIDENCE is exactly "here is a candidate, look at it".
   */
  // A judged-insufficient answer is NOT a finding, whatever the flags say. This is the whole
  // point of the second model: the researcher's refusal used to arrive here as evidence.
  const judgedInsufficient = llmVerdict !== null && llmVerdict.verdict === 'insufficient';
  const foundByAgent =
    allFlags.includes(AggregateFlag.MODEL_HAS_RESULT) &&
    result.evidence.length > 0 &&
    !judgedInsufficient;
  const finalStatus =
    verdict.status === StepStatus.NO_RESULT && foundByAgent
      ? StepStatus.LOW_CONFIDENCE
      : verdict.status;

  const outcome: SearchOutcome = {
    runId,
    status: finalStatus,
    confidence: verdict.confidence,
    reason: verdict.reason,
    flags: allFlags,
    evidence: result.evidence,
    llmVerdict: llmVerdict
      ? {
          verdict: llmVerdict.verdict,
          confidence: llmVerdict.confidence,
          notes: llmVerdict.notes,
        }
      : null,
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
    finalStatus,
    finalConfidence: verdict.confidence,
    finalFlags: allFlags,
    finalAnswer: answerMessage(result.evidence[0], allFlags, agentPartial),
    evidence: result.evidence,
    totalCostUsd: 0,
    agentInvoked: !found,
  });

  store.emit(runId, {
    step: 'final_answer',
    source: 'local',
    phase: 'completed',
    status: finalStatus,
    flags: allFlags,
    message: answerMessage(result.evidence[0], allFlags, agentPartial),
    metadata: { confidence: verdict.confidence, resultCount: result.evidence.length },
  });

  return outcome;
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
