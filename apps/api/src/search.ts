import { msg, TRACE_CODES, type TraceMsg } from '@han/shared/trace';
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
import { proposeAddition } from './corpus-add.js';
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
  llmVerdict: { verdict: string; confidence: number; notes: string } | null;
}

export interface SearchDeps {
  db: NodePgDatabase<Record<string, never>>;
  model: ModelClient | null;
  vectors: VectorStore | null;
  provider: LlmProvider | null;
  reasoningModel: string | null;
  verifyModel: string | null;
  makeTools: (config: RuntimeConfig) => Array<Tool<never>>;
  bridge: AgentEventBridge;
  debug: boolean;
  config: RuntimeConfig;
}

const poemLines = (textDisplay: string): string[] =>
  textDisplay
    .split(/[\n，。！？；]/u)
    .map((s) => toMatchForm(s))
    .filter((s) => s.length > 0);

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
    messageTrace: msg('trace.readingQuery'),
    metadata: { query: rawQuery },
  });

  const colophon = splitColophon(rawQuery);
  const searchText = colophon.body.length > 0 ? colophon.body.join('\n') : rawQuery;

  if (colophon.colophonLines.length > 0) {
    store.emit(runId, {
      step: 'query_understanding',
      source: 'query',
      phase: 'completed',
      status: StepStatus.HAS_RESULT,
      message: `Set aside an inscription: ${colophon.colophonLines.join(' · ')}${colophon.cyclicalDate ? ` (${colophon.cyclicalDate})` : ''}`,
      messageTrace: msg(colophon.cyclicalDate ? 'trace.colophonDated' : 'trace.colophon', {
        lines: colophon.colophonLines.join(' · '),
        ...(colophon.cyclicalDate ? { date: colophon.cyclicalDate } : {}),
      }),
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
    messageTrace: msg('trace.normalised', { n: norm.textMatch.length }),
    metadata: { query: rawQuery, normalizedQuery: norm.textMatch },
  });

  store.emit(runId, {
    step: 'local_search',
    source: 'local',
    phase: 'started',
    message: 'Searching the corpus',
    messageTrace: msg('trace.searching'),
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
    const step =
      source === 'reranker'
        ? 'reranker'
        : source === 'exact'
          ? 'exact'
          : source === 'bm25'
            ? 'bm25'
            : 'vector';
    store.emit(runId, {
      step: step as 'exact' | 'bm25' | 'vector' | 'reranker',
      source,
      phase:
        report.status === StepStatus.ERROR || report.status === StepStatus.TIMEOUT
          ? 'failed'
          : 'completed',
      status: report.status,
      flags: source === 'exact' ? result.exact.flags : [],
      message: describeSource(source, report.status, report.count, result.shortCircuited),
      messageTrace: describeSourceTrace(source, report.status, report.count, result.shortCircuited),
      metadata: {
        latencyMs: report.latencyMs,
        resultCount: report.count,
        ...(report.errorCode
          ? { errorCode: report.errorCode, errorMessage: report.errorMessage }
          : {}),
      },
    });
  }

  const verdict = evaluateLocal(
    {
      intent: 'fragment_lookup',
      exactMatch: {
        kind: result.exact.kind,
        workIds: result.exact.workIds,
        windowsMatched: result.exact.windowsMatched,
      },
      candidateCount: result.evidence.length,
      rerankScores: result.rerankScores,
      lexicalOverlap: result.lexicalOverlap,
    },
    deps.config.confidence,
  );

  store.emit(runId, {
    step: 'local_evaluation',
    source: 'local',
    phase: 'completed',
    status: verdict.status,
    flags: verdict.flags,
    message: verdict.reason,
    messageTrace: verdict.trace,
    metadata: {
      confidence: verdict.confidence,
      resultCount: result.evidence.length,
      ...(result.rerankScores[0] !== undefined ? { topScore: result.rerankScores[0] } : {}),
    },
  });

  let verification: ReturnType<typeof verifyCandidate> | null = null;

  const allFlags = [...new Set([...result.exact.flags, ...verdict.flags])];
  const found = allFlags.includes(AggregateFlag.LOCAL_RESULT_FOUND);

  let agentPartial = false;

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
      messageTrace: msg('trace.agent.skippedNoOverlap'),
    });
  } else if (!found) {
    if (!deps.config.agent.enabled) {
      allFlags.push(flag('model', StepStatus.SKIPPED));
      store.emit(runId, {
        step: 'agent',
        source: 'model',
        phase: 'completed',
        status: StepStatus.SKIPPED,
        flags: [flag('model', StepStatus.SKIPPED)],
        message: 'Agent is switched off in settings',
        messageTrace: msg('trace.agent.off'),
      });
    } else if (!deps.provider || !deps.reasoningModel) {
      allFlags.push(flag('model', StepStatus.UNAVAILABLE));
      store.emit(runId, {
        step: 'agent',
        source: 'model',
        phase: 'completed',
        status: StepStatus.UNAVAILABLE,
        flags: [flag('model', StepStatus.UNAVAILABLE)],
        message: 'No LLM gateway is configured — the agent could not run',
        messageTrace: msg('trace.agent.noGateway'),
        metadata: { errorCode: 'TOOL_UNAVAILABLE' },
      });
    } else {
      store.emit(runId, {
        step: 'agent',
        source: 'model',
        phase: 'started',
        message: 'Agent took over',
        messageTrace: msg('trace.agent.tookOver'),
      });

      try {
        const stopRelay = await deps.bridge.relay(runId);
        if (!deps.bridge.available) {
          store.emit(runId, {
            step: 'agent',
            source: 'model',
            phase: 'started',
            message:
              'Agent running — live trace unavailable (no Redis), the answer will still arrive',
            messageTrace: msg('trace.agent.noRelay'),
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
        for (const f of [
          ...agentOut.flags,
          ...(agentOut.evidence.length > 0 ? ['model_has_result'] : []),
        ]) {
          if (!allFlags.includes(f)) allFlags.push(f);
        }

        const fresh = agentOut.evidence.filter(
          (ev) => !result.evidence.some((x) => x.id === ev.id),
        );
        result.evidence = [...fresh, ...result.evidence];

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
          messageTrace:
            agentOut.evidence.length > 0
              ? msg('trace.agent.found', { n: agentOut.evidence.length })
              : msg('trace.agent.stopped', {
                  reason: agentOut.stopDetail ?? agentOut.stoppedBecause.replace(/_/gu, ' '),
                }),
          metadata: { resultCount: agentOut.evidence.length },
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        agentPartial = true;
        store.emit(runId, {
          step: 'agent',
          source: 'model',
          phase: 'failed',
          status: StepStatus.ERROR,
          message: 'The agent failed — answering from the evidence collected so far',
          messageTrace: msg('trace.agent.failed'),
          metadata: { errorCode: 'INTERNAL', errorMessage: message },
        });
      }
    }
  }

  const top = result.evidence[0];

  if (top) {
    const inputLines = prosodyLines(searchText)
      .map((l) => toMatchForm(l))
      .filter((l) => l.length > 0);
    verification = verifyCandidate(
      inputLines,
      poemLines(top.content),
      allFlags.includes(AggregateFlag.INPUT_REORDERED),
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
      messageTrace: verification.summaryTrace,
      metadata: { resultCount: verification.checks.length },
    });
  } else {
    store.emit(runId, {
      step: 'rule_verification',
      source: 'rule_verify',
      phase: 'completed',
      status: StepStatus.NOT_EXECUTED,
      message: 'Nothing to verify — no candidate',
      messageTrace: msg('trace.nothingToVerify'),
    });
  }

  for (const f of verification?.flags ?? []) {
    if (!allFlags.includes(f)) allFlags.push(f);
  }

  let llmVerdict: Verdict | null = null;
  const judgeModel = deps.config.models.verify ?? deps.verifyModel;
  const worthJudging = allFlags.includes(AggregateFlag.MODEL_HAS_RESULT);

  if (worthJudging && deps.provider && judgeModel) {
    store.emit(runId, {
      step: 'llm_verification',
      source: 'llm_verify',
      phase: 'started',
      message: 'Checking whether the evidence actually settles it',
      messageTrace: msg('trace.judge.checking'),
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
      store.emit(runId, {
        step: 'llm_verification',
        source: 'llm_verify',
        phase: 'completed',
        status: StepStatus.UNAVAILABLE,
        message: 'The verifier could not be reached — the evidence is unchecked',
        messageTrace: msg('trace.judge.unreachable'),
      });
    } else {
      llmVerdict = judged.verdict;

      if (judged.verdict.propose) {
        const outcome = await proposeAddition(deps.db, judged.verdict.propose, {
          runId,
          verdict: judged.verdict.verdict,
          localFoundNothing: !found,
          evidence: result.evidence.map((e) => ({ source: e.source, url: e.url })),
        });
        store.emit(runId, {
          step: 'llm_verification',
          source: 'llm_verify',
          phase: 'completed',
          status: outcome.proposed ? StepStatus.HAS_RESULT : StepStatus.SKIPPED,
          message: outcome.proposed
            ? `Proposed "${judged.verdict.propose.title}" for the corpus — awaiting review`
            : `Proposal declined — ${outcome.reason ?? 'no reason given'}`,
          messageTrace: outcome.proposed
            ? msg('trace.judge.proposed', { title: judged.verdict.propose.title })
            : msg('trace.judge.declined', {}, outcome.reasonTrace ? [outcome.reasonTrace] : []),
        });
      }
      store.emit(runId, {
        step: 'llm_verification',
        source: 'llm_verify',
        phase: 'completed',
        status:
          llmVerdict.verdict === 'sufficient' ? StepStatus.HAS_RESULT : StepStatus.LOW_CONFIDENCE,
        message: `${llmVerdict.verdict} — ${llmVerdict.notes || 'no note'}`,
        messageTrace: msg(`trace.judge.${llmVerdict.verdict}`, {
          notes: llmVerdict.notes || '',
        }),
        metadata: {
          confidence: llmVerdict.confidence,
          model: judged.model,
          provider: judged.provider,
          ...(judged.costUsd !== null ? { costUsd: judged.costUsd } : {}),
        },
      });
    }
  }

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
  store.setOutcome(runId, outcome);

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
    messageTrace: answerTrace(result.evidence[0], allFlags, agentPartial),
    metadata: { confidence: verdict.confidence, resultCount: result.evidence.length },
  });

  return outcome;
}

function answerMessage(top: Evidence | undefined, flags: string[], partial: boolean): string {
  const suffix = partial ? ' (partial — the agent ran out of budget)' : '';
  if (flags.includes(AggregateFlag.NO_LOCAL_RESULT)) {
    return `No confident answer — nothing in the corpus matches${suffix}`;
  }
  if (!top) return `No confident answer${suffix}`;
  if (flags.includes(AggregateFlag.LOCAL_RESULT_FOUND)) {
    return `${top.title ?? '(untitled)'} — ${top.author ?? '(unknown)'}${suffix}`;
  }
  return `${top.title ?? top.content.slice(0, 30)} — via ${top.source}${suffix}`;
}

function answerTrace(top: Evidence | undefined, flags: string[], partial: boolean): TraceMsg {
  const suffix = partial ? [msg('trace.answer.partialSuffix')] : undefined;
  if (flags.includes(AggregateFlag.NO_LOCAL_RESULT)) {
    return msg('trace.answer.nothingMatches', {}, suffix);
  }
  if (!top) return msg('trace.answer.none', {}, suffix);
  if (flags.includes(AggregateFlag.LOCAL_RESULT_FOUND)) {
    return msg(
      'trace.answer.local',
      { title: top.title ?? '(untitled)', author: top.author ?? '(unknown)' },
      suffix,
    );
  }
  return msg(
    'trace.answer.outside',
    { title: top.title ?? top.content.slice(0, 30), source: top.source },
    suffix,
  );
}

function describeSourceTrace(
  source: string,
  status: StepStatus,
  count: number,
  shortCircuited: boolean,
): TraceMsg {
  if (status === StepStatus.SKIPPED) {
    return msg(shortCircuited ? 'trace.src.skippedShort' : 'trace.src.skipped');
  }
  if (status === StepStatus.UNAVAILABLE) return msg('trace.src.unavailable');
  if (status === StepStatus.TIMEOUT) return msg('trace.src.timeout');
  if (status === StepStatus.ERROR) return msg('trace.src.failed');
  const code = `trace.srcName.${source}`;
  const known = (TRACE_CODES as readonly string[]).includes(code);
  const parts = known ? [msg(code)] : undefined;
  const raw: Record<string, string | number> = known ? {} : { source };
  return count === 0
    ? msg(known ? 'trace.src.none' : 'trace.src.noneRaw', raw, parts)
    : msg(known ? 'trace.src.count' : 'trace.src.countRaw', { ...raw, n: count }, parts);
}

function describeSource(
  source: string,
  status: StepStatus,
  count: number,
  shortCircuited: boolean,
): string {
  if (status === StepStatus.SKIPPED) {
    return shortCircuited ? 'Skipped — the exact match already resolved it' : 'Skipped';
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
  return count === 0
    ? `${name} — nothing found`
    : `${name} — ${count} result${count === 1 ? '' : 's'}`;
}
