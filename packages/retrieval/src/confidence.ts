import { msg, type TraceMsg } from '@han/shared/trace';
import { StepStatus } from '@han/shared/status';
import { AggregateFlag } from '@han/shared/flags';
import type { ExactMatchKind } from './sources/exact-ngram.js';

export type QueryIntent = 'fragment_lookup' | 'topical' | 'metadata' | 'interpretation';

export interface ConfidenceThresholds {
  verifyFloor: number;
  noiseFloor: number;
  minAgreeingWindows: number;
  minLexicalOverlap: number;
}

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
  rerankScores: number[];
  lexicalOverlap?: number | null;
}

export interface EvaluateOutput {
  status: StepStatus;
  flags: string[];
  confidence: number;
  reason: string;
  trace: TraceMsg;
}

export function evaluateLocal(
  input: EvaluateInput,
  thresholds: ConfidenceThresholds = PROVISIONAL_THRESHOLDS,
): EvaluateOutput {
  const { exactMatch: em } = input;
  const top1 = input.rerankScores[0] ?? null;

  const overlapNow = input.lexicalOverlap;
  const belowFloor =
    overlapNow !== null && overlapNow !== undefined && overlapNow < thresholds.minLexicalOverlap;

  if (em.kind !== 'none' && belowFloor) {
    return {
      status: StepStatus.NO_RESULT,
      flags: [AggregateFlag.NO_LOCAL_RESULT],
      confidence: 0,
      reason: `an exact run matched, but the work it resolves to shares only ${(overlapNow * 100).toFixed(0)}% of the query's characters — below the ${(thresholds.minLexicalOverlap * 100).toFixed(0)}% floor, so the run is a coincidence rather than the poem`,
      trace: msg('trace.conf.exactBelowFloor', {
        pct: (overlapNow * 100).toFixed(0),
        floor: (thresholds.minLexicalOverlap * 100).toFixed(0),
      }),
    };
  }

  if (em.kind === 'full' && em.workIds.length === 1) {
    return {
      status: StepStatus.HAS_RESULT,
      flags: [AggregateFlag.LOCAL_RESULT_FOUND, AggregateFlag.EXACT_FULL_MATCH],
      confidence: 1,
      reason: 'exact contiguous match resolving to a single work',
      trace: msg('trace.conf.exactSingle'),
    };
  }

  if (em.kind === 'full' || em.kind === 'ambiguous') {
    return {
      status: StepStatus.HAS_RESULT,
      flags: [AggregateFlag.LOCAL_RESULT_FOUND, AggregateFlag.EXACT_AMBIGUOUS],
      confidence: 0.9,
      reason: `exact match resolving to ${em.workIds.length} works — candidates passed forward, not guessed between`,
      trace: msg('trace.conf.exactAmbiguous', { n: em.workIds.length }),
    };
  }

  if (em.kind === 'partial' && em.windowsMatched >= thresholds.minAgreeingWindows) {
    return {
      status: StepStatus.HAS_RESULT,
      flags: [AggregateFlag.LOCAL_RESULT_FOUND, AggregateFlag.EXACT_PARTIAL_MATCH],
      confidence: 0.85,
      reason: `${em.windowsMatched} windows agree on the same work`,
      trace: msg('trace.conf.windowsAgree', { n: em.windowsMatched }),
    };
  }

  if (input.candidateCount === 0) {
    return {
      status: StepStatus.NO_RESULT,
      flags: [AggregateFlag.NO_LOCAL_RESULT],
      confidence: 0,
      reason: 'no candidates returned by any local retriever',
      trace: msg('trace.conf.noCandidates'),
    };
  }

  if (top1 === null) {
    return {
      status: StepStatus.LOW_CONFIDENCE,
      flags: [AggregateFlag.LOCAL_LOW_CONFIDENCE, AggregateFlag.LOCAL_INCOMPLETE],
      confidence: 0.3,
      reason: `${input.candidateCount} candidates exist but none has been scored — reranker not available`,
      trace: msg('trace.conf.unscored', { n: input.candidateCount }),
    };
  }

  const overlap = input.lexicalOverlap;
  if (overlap !== null && overlap !== undefined && overlap < thresholds.minLexicalOverlap) {
    return {
      status: StepStatus.NO_RESULT,
      flags: [AggregateFlag.NO_LOCAL_RESULT],
      confidence: 0,
      reason: `candidates exist but the best shares only ${(overlap * 100).toFixed(0)}% of the query's characters — below the ${(thresholds.minLexicalOverlap * 100).toFixed(0)}% floor, so the rerank score of ${top1.toFixed(2)} is not believed`,
      trace: msg('trace.conf.overlapBelowFloor', {
        pct: (overlap * 100).toFixed(0),
        floor: (thresholds.minLexicalOverlap * 100).toFixed(0),
        score: top1.toFixed(2),
      }),
    };
  }

  if (top1 < thresholds.noiseFloor) {
    return {
      status: StepStatus.NO_RESULT,
      flags: [AggregateFlag.NO_LOCAL_RESULT],
      confidence: 0,
      reason: `top rerank score ${top1.toFixed(2)} is below the noise floor ${thresholds.noiseFloor}`,
      trace: msg('trace.conf.belowNoiseFloor', {
        score: top1.toFixed(2),
        floor: thresholds.noiseFloor,
      }),
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
    trace: msg(
      top1 >= thresholds.verifyFloor ? 'trace.conf.scoredClears' : 'trace.conf.scoredBetween',
      { score: top1.toFixed(2) },
    ),
  };
}
