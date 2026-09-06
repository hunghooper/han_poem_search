/**
 * Step status and source identifiers — the spec §5.1. FROZEN CONTRACT.
 *
 * The distinction between these values *is* the product. Collapsing any of them into
 * NO_RESULT is the most damaging mistake available in this codebase: a timeout and an
 * empty result mean opposite things to the agent.
 */

export const StepStatus = {
  HAS_RESULT: 'has_result',
  NO_RESULT: 'no_result', // ran fine, found nothing
  LOW_CONFIDENCE: 'low_confidence', // candidates exist, none relevant enough
  ERROR: 'error',
  TIMEOUT: 'timeout',
  UNAVAILABLE: 'unavailable',
  SKIPPED: 'skipped',
  NOT_EXECUTED: 'not_executed',
} as const;

export type StepStatus = (typeof StepStatus)[keyof typeof StepStatus];

export const ALL_STEP_STATUSES: readonly StepStatus[] = Object.values(StepStatus);

/** Statuses that mean "this source produced usable evidence". */
export const isProductive = (s: StepStatus): boolean => s === StepStatus.HAS_RESULT;

/** Statuses that mean "this source failed", as distinct from "found nothing". */
export const isFailure = (s: StepStatus): boolean =>
  s === StepStatus.ERROR || s === StepStatus.TIMEOUT || s === StepStatus.UNAVAILABLE;

export type SourceId =
  | 'query'
  | 'exact'
  | 'bm25'
  | 'vector'
  | 'hybrid'
  | 'reranker'
  | 'local'
  | 'model'
  | 'google'
  | 'chinese_web'
  | 'thivien'
  | 'ctext'
  | 'souyun'
  | 'rule_verify'
  | 'llm_verify'
  | `api_${string}`;

/** Source ids that are enumerable at build time (excludes the `api_${string}` template). */
export const KNOWN_SOURCE_IDS = [
  'query',
  'exact',
  'bm25',
  'vector',
  'hybrid',
  'reranker',
  'local',
  'model',
  'google',
  'chinese_web',
  'thivien',
  'ctext',
  'souyun',
  'rule_verify',
  'llm_verify',
] as const satisfies readonly SourceId[];
