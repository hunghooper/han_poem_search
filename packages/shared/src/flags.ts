/**
 * Flags — the spec §5.1. FROZEN CONTRACT.
 *
 * There are exactly two kinds of flag, and conflating them is why the brief contains
 * both `local_has_result` (derivable) and `local_result_found` (not derivable):
 *
 *   1. DERIVED flags — mechanically `${source}_${status}`. Never written by hand.
 *      e.g. flag('thivien', StepStatus.HAS_RESULT) -> 'thivien_has_result'
 *
 *   2. AGGREGATE flags — conclusions the confidence policy (§8) draws across sources.
 *      They are hand-registered here because no source/status pair produces them.
 *      e.g. 'local_result_found' is emitted when exact OR fused evidence clears the bar,
 *      which is a judgement, not a status.
 *
 * Nothing outside this module may construct a flag from a string literal.
 */

import type { SourceId, StepStatus } from './status.js';

export const flag = <S extends SourceId, T extends StepStatus>(source: S, status: T) =>
  `${source}_${status}` as `${S}_${T}`;

/**
 * Aggregate flags from the confidence policy (§8) and the query/reorder stages (§6, §7.3).
 * Adding one here is step 2 of "Extension point 2" in CONTRIBUTING.md.
 */
export const AggregateFlag = {
  // Confidence policy outcomes (§8)
  LOCAL_RESULT_FOUND: 'local_result_found',
  NO_LOCAL_RESULT: 'no_local_result',
  LOCAL_LOW_CONFIDENCE: 'local_low_confidence',
  LOCAL_INCOMPLETE: 'local_incomplete',

  // Exact-match outcomes (§7.1, §7.3)
  EXACT_FULL_MATCH: 'exact_full_match',
  EXACT_PARTIAL_MATCH: 'exact_partial_match',
  EXACT_AMBIGUOUS: 'exact_ambiguous',

  // Input-condition observations (§6, §7.3)
  VARIANT_TEXT_DETECTED: 'variant_text_detected',
  INPUT_REORDERED: 'input_reordered',

  // Budget and answer-quality observations (§12, §10.3)
  AGENT_BUDGET_EXHAUSTED: 'agent_budget_exhausted',
  FINAL_ANSWER_UNCITED: 'final_answer_uncited',
  LLM_FAILOVER: 'llm_failover',
  USAGE_UNAVAILABLE: 'usage_unavailable',
  MODEL_HAS_RESULT: 'model_has_result',
} as const;

export type AggregateFlag = (typeof AggregateFlag)[keyof typeof AggregateFlag];

export const ALL_AGGREGATE_FLAGS: readonly AggregateFlag[] = Object.values(AggregateFlag);

export const isAggregateFlag = (s: string): s is AggregateFlag =>
  (ALL_AGGREGATE_FLAGS as readonly string[]).includes(s);
