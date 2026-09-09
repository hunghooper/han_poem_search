import type { SourceId, StepStatus } from './status.js';

export const flag = <S extends SourceId, T extends StepStatus>(source: S, status: T) =>
  `${source}_${status}` as `${S}_${T}`;

export const AggregateFlag = {
  LOCAL_RESULT_FOUND: 'local_result_found',
  NO_LOCAL_RESULT: 'no_local_result',
  LOCAL_LOW_CONFIDENCE: 'local_low_confidence',
  LOCAL_INCOMPLETE: 'local_incomplete',

  EXACT_FULL_MATCH: 'exact_full_match',
  EXACT_PARTIAL_MATCH: 'exact_partial_match',
  EXACT_AMBIGUOUS: 'exact_ambiguous',

  VARIANT_TEXT_DETECTED: 'variant_text_detected',
  INPUT_REORDERED: 'input_reordered',

  AGENT_BUDGET_EXHAUSTED: 'agent_budget_exhausted',
  AGENT_MODEL_FAILED: 'agent_model_failed',
  FINAL_ANSWER_UNCITED: 'final_answer_uncited',
  LLM_FAILOVER: 'llm_failover',
  USAGE_UNAVAILABLE: 'usage_unavailable',
  MODEL_HAS_RESULT: 'model_has_result',
} as const;

export type AggregateFlag = (typeof AggregateFlag)[keyof typeof AggregateFlag];

export const ALL_AGGREGATE_FLAGS: readonly AggregateFlag[] = Object.values(AggregateFlag);

export const isAggregateFlag = (s: string): s is AggregateFlag =>
  (ALL_AGGREGATE_FLAGS as readonly string[]).includes(s);
