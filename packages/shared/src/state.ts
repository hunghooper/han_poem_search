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
  messageTrace: TraceMsg | null;
  agentIteration: number | null;
}

export interface SearchRunState {
  runId: string | null;
  lastSeq: number;
  steps: Record<string, StepState>;
  order: string[];
  flags: string[];
  agentIterations: number;
  totalCostUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
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

export const failedSources = (s: SearchRunState): StepState[] =>
  Object.values(s.steps).filter((st) => isFailure(st.status));
