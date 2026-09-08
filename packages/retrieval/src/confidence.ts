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
  /**
   * Minimum share of the query's characters that must appear in a candidate before any rerank
   * score is believed.
   *
   * MEASURED FAILURE. Reranker scores are not calibrated relevance probabilities. The nonsense
   * control 龘龘龘龘龘龘 was scored 0.99 against 韓愈《駑驥》 — a poem sharing not one character
   * with it. Trusting the score alone produced exactly the outcome §16 forbids: an answer
   * assembled from irrelevant top-k. A cross-encoder given out-of-distribution input returns a
   * confident number, not an admission of ignorance, so something deterministic has to bound
   * it. Character overlap is cheap, has no failure mode of its own, and cannot be fooled.
   */
  minLexicalOverlap: number;
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
  minLexicalOverlap: 0.15,
};

export interface EvaluateInput {
  intent: QueryIntent;
  exactMatch: { kind: ExactMatchKind; workIds: string[]; windowsMatched: number };
  candidateCount: number;
  /** Descending. Empty when the reranker was unavailable or timed out. */
  rerankScores: number[];
  /**
   * Share of the query's distinct characters present in the best candidate, 0..1.
   * Null when it could not be computed — treated as "unknown", never as "fine".
   */
  lexicalOverlap?: number | null;
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

  /**
   * The overlap gate, applied BEFORE the exact short-circuit rather than only after it.
   *
   * §7.1 lets five contiguous characters resolving to one work answer at confidence 1.0. That
   * is right when five characters is most of what the user pasted and wrong when it is a
   * ninth of it — measured on a real batch, 10.8% of exact matches returned a poem sharing
   * under 40% of the query's characters, and the worst shared 15%.
   *
   * The floor is the SAME 0.15 the reranker path already uses (ADR 008), not a new number:
   * the question both paths ask is identical — "is this candidate even about the same words"
   * — and a second threshold for one question is a second thing nobody calibrated. On the
   * measured distribution it rejects 0.9% of exact matches, all of them from the far tail.
   */
  const overlapNow = input.lexicalOverlap;
  const belowFloor =
    overlapNow !== null &&
    overlapNow !== undefined &&
    overlapNow < thresholds.minLexicalOverlap;

  if (em.kind !== 'none' && belowFloor) {
    return {
      status: StepStatus.NO_RESULT,
      flags: [AggregateFlag.NO_LOCAL_RESULT],
      confidence: 0,
      reason: `an exact run matched, but the work it resolves to shares only ${(overlapNow * 100).toFixed(0)}% of the query's characters — below the ${(thresholds.minLexicalOverlap * 100).toFixed(0)}% floor, so the run is a coincidence rather than the poem`,
    };
  }

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

  // Deterministic gate BEFORE the score is read. A candidate that shares almost nothing with
  // the query is not a low-confidence answer; it is not an answer.
  const overlap = input.lexicalOverlap;
  if (overlap !== null && overlap !== undefined && overlap < thresholds.minLexicalOverlap) {
    return {
      status: StepStatus.NO_RESULT,
      flags: [AggregateFlag.NO_LOCAL_RESULT],
      confidence: 0,
      reason: `candidates exist but the best shares only ${(overlap * 100).toFixed(0)}% of the query's characters — below the ${(thresholds.minLexicalOverlap * 100).toFixed(0)}% floor, so the rerank score of ${top1.toFixed(2)} is not believed`,
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
