/**
 * SearchRunState and the event fold — the spec §5.2.
 *
 * "SearchRunState must be derivable by folding the event stream." This reducer is the single
 * implementation of that fold: the frontend runs it on the live WebSocket stream, and the
 * backend runs it to rebuild state on reconnect and to verify that search_run.final_* is a
 * faithful materialization of the log (§11).
 *
 * It must stay PURE and total — no clock, no I/O, no throwing on unknown input. An event
 * stream arriving out of order or with gaps is a normal condition on reconnect, not a crash.
 */

import type { SearchEvent, SearchStep } from './events.js';
import type { TraceMsg } from './trace.js';
import { StepStatus } from './status.js';
import { isFailure } from './status.js';

export interface StepState {
  step: SearchStep;
  source: string;
  status: StepStatus;
  startedAtSeq: number | null;
  completedAtSeq: number | null;
  latencyMs: number | null;
  resultCount: number | null;
  topScore: number | null;
  confidence: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  message: string | null;
  /** The same message, still renderable in the reader's language. */
  messageTrace: TraceMsg | null;
  agentIteration: number | null;
}

export interface SearchRunState {
  runId: string | null;
  lastSeq: number;
  /** Keyed by `${step}:${source}` so two sources on the same step do not clobber each other. */
  steps: Record<string, StepState>;
  /** Insertion-ordered step keys, for rendering the trace as a sentence. */
  order: string[];
  flags: string[];
  agentIterations: number;
  totalCostUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  /** Seqs applied so far, so replay after reconnect is idempotent. */
  appliedSeqs: number[];
  finished: boolean;
}

export const stepKey = (step: SearchStep, source: string): string => `${step}:${source}`;

export const initialState = (): SearchRunState => ({
  runId: null,
  lastSeq: -1,
  steps: {},
  order: [],
  flags: [],
  agentIterations: 0,
  totalCostUsd: 0,
  totalTokensIn: 0,
  totalTokensOut: 0,
  appliedSeqs: [],
  finished: false,
});

const phaseToStatus = (e: SearchEvent): StepStatus => {
  if (e.status) return e.status;
  if (e.phase === 'started') return StepStatus.NOT_EXECUTED;
  if (e.phase === 'failed') return StepStatus.ERROR;
  return StepStatus.HAS_RESULT;
};

/**
 * Fold one event into the state. Idempotent: re-applying a seq already seen is a no-op, which
 * is what makes reconnect-with-lastSeq replay lossless AND duplicate-free (§14.1).
 */
export function reduce(state: SearchRunState, event: SearchEvent): SearchRunState {
  if (state.appliedSeqs.includes(event.seq)) return state;

  const key = stepKey(event.step, event.source);
  const prev = state.steps[key];
  const md = event.metadata;

  const next: StepState = {
    step: event.step,
    source: event.source,
    status: phaseToStatus(event),
    startedAtSeq: event.phase === 'started' ? event.seq : (prev?.startedAtSeq ?? null),
    completedAtSeq: event.phase === 'started' ? (prev?.completedAtSeq ?? null) : event.seq,
    latencyMs: md.latencyMs ?? prev?.latencyMs ?? null,
    resultCount: md.resultCount ?? prev?.resultCount ?? null,
    topScore: md.topScore ?? prev?.topScore ?? null,
    confidence: md.confidence ?? prev?.confidence ?? null,
    errorCode: md.errorCode ?? prev?.errorCode ?? null,
    errorMessage: md.errorMessage ?? prev?.errorMessage ?? null,
    message: event.message ?? prev?.message ?? null,
    messageTrace: event.messageTrace ?? prev?.messageTrace ?? null,
    agentIteration: event.agentIteration ?? prev?.agentIteration ?? null,
  };

  const order = prev ? state.order : [...state.order, key];

  const flags = event.flags.length
    ? [...state.flags, ...event.flags.filter((f) => !state.flags.includes(f))]
    : state.flags;

  return {
    runId: state.runId ?? event.runId,
    lastSeq: Math.max(state.lastSeq, event.seq),
    steps: { ...state.steps, [key]: next },
    order,
    flags,
    agentIterations: Math.max(state.agentIterations, (event.agentIteration ?? -1) + 1),
    totalCostUsd: state.totalCostUsd + (md.costUsd ?? 0),
    totalTokensIn: state.totalTokensIn + (md.tokensIn ?? 0),
    totalTokensOut: state.totalTokensOut + (md.tokensOut ?? 0),
    appliedSeqs: [...state.appliedSeqs, event.seq],
    finished: state.finished || (event.step === 'final_answer' && event.phase !== 'started'),
  };
}

export const fold = (events: readonly SearchEvent[]): SearchRunState =>
  [...events].sort((a, b) => a.seq - b.seq).reduce(reduce, initialState());

/** Did any source fail, as distinct from finding nothing? Drives "opaque failure" reporting. */
export const failedSources = (s: SearchRunState): StepState[] =>
  Object.values(s.steps).filter((st) => isFailure(st.status));
