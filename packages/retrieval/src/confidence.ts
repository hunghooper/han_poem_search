/**
 * Confidence policy — the spec §8.
 *
 * A single pure function, so it is testable and tunable without touching the pipeline.
 * Thresholds live in config, never in code.
 *
 * §7.4 insists on three separate questions, and this function keeps them separate:
 *   1. Candidate existence — did the index return rows?
 *   2. Candidate relevance — did the reranker score any above the floor?
 *   3. Final confidence   — is this enough to answer THIS question?
 *
 * `candidateCount = 20` with `top1 = 0.11` is LOW_CONFIDENCE, not a successful search. There
 * is a test asserting that, and CONTRIBUTING.md forbids weakening it.
 */

import { StepStatus } from '@han/shared/status';
import { AggregateFlag } from '@han/shared/flags';
import type { ExactMatchKind } from './sources/exact-ngram.js';

export type QueryIntent = 'fragment_lookup' | 'topical' | 'metadata' | 'interpretation';

export interface ConfidenceThresholds {
  /** Rerank score at or above which a candidate is worth verifying. */
  verifyFloor: number;
  /** Rerank score below which candidates are treated as noise. */
  noiseFloor: number;
  /** Windows that must agree for a partial exact match to count. */
  minAgreeingWindows: number;
}

/**
 * PROVISIONAL AND UNCALIBRATED — the spec §8 says to ship these labelled as such and
 * set them properly with the offline eval harness in Phase 5. They are not tuned. Do not
 * present them as tuned, and do not change them without a calibration run recorded in an ADR.
 */
export const PROVISIONAL_THRESHOLDS: ConfidenceThresholds = {
  verifyFloor: 0.6,
  noiseFloor: 0.35,
  minAgreeingWindows: 2,
};

export interface EvaluateInput {
  intent: QueryIntent;
  exactMatch: { kind: ExactMatchKind; workIds: string[]; windowsMatched: number };
  candidateCount: number;
  /** Descending. Empty in Phase 1 — the reranker arrives in Phase 2. */
  rerankScores: number[];
}

export interface EvaluateOutput {
  status: StepStatus;
  flags: string[];
  confidence: number;
  reason: string;
}

export function evaluateLocal(
  input: EvaluateInput,
  thresholds: ConfidenceThresholds = PROVISIONAL_THRESHOLDS,
): EvaluateOutput {
  const { exactMatch: em } = input;
  const top1 = input.rerankScores[0] ?? null;

  if (em.kind === 'full' && em.workIds.length === 1) {
    return {
      status: StepStatus.HAS_RESULT,
      flags: [AggregateFlag.LOCAL_RESULT_FOUND, AggregateFlag.EXACT_FULL_MATCH],
      confidence: 1,
      reason: 'exact contiguous match resolving to a single work',
    };
  }

  if (em.kind === 'full' || em.kind === 'ambiguous') {
    return {
      status: StepStatus.HAS_RESULT,
      flags: [AggregateFlag.LOCAL_RESULT_FOUND, AggregateFlag.EXACT_AMBIGUOUS],
      confidence: 0.9,
      reason: `exact match resolving to ${em.workIds.length} works — candidates passed forward, not guessed between`,
    };
  }

  if (em.kind === 'partial' && em.windowsMatched >= thresholds.minAgreeingWindows) {
    return {
      status: StepStatus.HAS_RESULT,
      flags: [AggregateFlag.LOCAL_RESULT_FOUND, AggregateFlag.EXACT_PARTIAL_MATCH],
      confidence: 0.85,
      reason: `${em.windowsMatched} windows agree on the same work`,
    };
  }

  // No exact match. Everything below depends on the semantic layer, which is Phase 2 — with
  // no rerank scores the honest answer is "nothing found", not a low-confidence guess.
  if (input.candidateCount === 0) {
    return {
      status: StepStatus.NO_RESULT,
      flags: [AggregateFlag.NO_LOCAL_RESULT],
      confidence: 0,
      reason: 'no candidates returned by any local retriever',
    };
  }

  if (top1 === null) {
    return {
      status: StepStatus.LOW_CONFIDENCE,
      flags: [AggregateFlag.LOCAL_LOW_CONFIDENCE, AggregateFlag.LOCAL_INCOMPLETE],
      confidence: 0.3,
      reason: `${input.candidateCount} candidates exist but none has been scored — reranker not available`,
    };
  }

  if (top1 < thresholds.noiseFloor) {
    return {
      status: StepStatus.NO_RESULT,
      flags: [AggregateFlag.NO_LOCAL_RESULT],
      confidence: 0,
      reason: `top rerank score ${top1.toFixed(2)} is below the noise floor ${thresholds.noiseFloor}`,
    };
  }

  return {
    status: StepStatus.LOW_CONFIDENCE,
    flags: [AggregateFlag.LOCAL_LOW_CONFIDENCE],
    confidence: 0.5,
    reason:
      top1 >= thresholds.verifyFloor
        ? `top rerank score ${top1.toFixed(2)} clears the verify floor but no exact match — requires verification`
        : `top rerank score ${top1.toFixed(2)} sits between the noise and verify floors`,
  };
}
