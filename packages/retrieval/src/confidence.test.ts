import { describe, expect, it } from 'vitest';
import { evaluateLocal, PROVISIONAL_THRESHOLDS } from './confidence.js';
import { StepStatus } from '@han/shared/status';

const base = {
  intent: 'fragment_lookup' as const,
  exactMatch: { kind: 'none' as const, workIds: [] as string[], windowsMatched: 0 },
  candidateCount: 0,
  rerankScores: [] as number[],
};

describe('evaluateLocal', () => {
  it('a single-work exact match is full confidence', () => {
    const r = evaluateLocal({ ...base, exactMatch: { kind: 'full', workIds: ['w1'], windowsMatched: 5 } });
    expect(r.status).toBe(StepStatus.HAS_RESULT);
    expect(r.confidence).toBe(1);
    expect(r.flags).toContain('exact_full_match');
  });

  it('an ambiguous exact match passes all candidates forward rather than guessing', () => {
    const r = evaluateLocal({
      ...base,
      exactMatch: { kind: 'ambiguous', workIds: ['w1', 'w2'], windowsMatched: 4 },
    });
    expect(r.status).toBe(StepStatus.HAS_RESULT);
    expect(r.confidence).toBe(0.9);
    expect(r.flags).toContain('exact_ambiguous');
  });

  it('a partial match needs agreeing windows', () => {
    const one = evaluateLocal({ ...base, exactMatch: { kind: 'partial', workIds: ['w1'], windowsMatched: 1 } });
    expect(one.status).not.toBe(StepStatus.HAS_RESULT);

    const two = evaluateLocal({ ...base, exactMatch: { kind: 'partial', workIds: ['w1'], windowsMatched: 2 } });
    expect(two.status).toBe(StepStatus.HAS_RESULT);
    expect(two.confidence).toBe(0.85);
  });

  // the spec §7.4 and CONTRIBUTING.md name this explicitly. It must never be weakened.
  it('candidates present but all scores below the floor is LOW_CONFIDENCE, never a result', () => {
    const r = evaluateLocal({ ...base, candidateCount: 20, rerankScores: [0.11, 0.09, 0.05] });
    expect(r.status).not.toBe(StepStatus.HAS_RESULT);
    expect(r.flags).not.toContain('local_result_found');
    expect(r.confidence).toBeLessThan(0.6);
  });

  it('no candidates at all is NO_RESULT, distinct from low confidence', () => {
    const r = evaluateLocal({ ...base, candidateCount: 0 });
    expect(r.status).toBe(StepStatus.NO_RESULT);
    expect(r.flags).toContain('no_local_result');
    expect(r.confidence).toBe(0);
  });

  it('unscored candidates are reported as incomplete, not as nothing found', () => {
    // Phase 1 has no reranker. Saying "no result" here would hide that a whole stage is absent.
    const r = evaluateLocal({ ...base, candidateCount: 8, rerankScores: [] });
    expect(r.status).toBe(StepStatus.LOW_CONFIDENCE);
    expect(r.flags).toContain('local_incomplete');
  });

  it('a score clearing the verify floor still requires verification, not an answer', () => {
    const r = evaluateLocal({ ...base, candidateCount: 5, rerankScores: [0.72] });
    expect(r.status).toBe(StepStatus.LOW_CONFIDENCE);
    expect(r.reason).toMatch(/requires verification/);
  });

  // REGRESSION, measured against the live index. The reranker scored the nonsense query
  // 龘龘龘龘龘龘 at 0.99 against 韓愈《駑驥》 — a poem sharing not one character with it. A
  // cross-encoder given out-of-distribution input returns a confident number, not an
  // admission of ignorance, so the score alone must never be able to produce an answer.
  // This is §16's explicit prohibition and CONTRIBUTING.md's first undeletable test.
  it('refuses a high rerank score when the candidate shares nothing with the query', () => {
    const r = evaluateLocal({ ...base, candidateCount: 8, rerankScores: [0.99], lexicalOverlap: 0 });
    expect(r.status).toBe(StepStatus.NO_RESULT);
    expect(r.flags).toContain('no_local_result');
    expect(r.confidence).toBe(0);
    expect(r.reason).toMatch(/not believed/);
  });

  it('accepts a high rerank score when the candidate does share the query characters', () => {
    const r = evaluateLocal({ ...base, candidateCount: 8, rerankScores: [0.99], lexicalOverlap: 0.8 });
    expect(r.status).toBe(StepStatus.LOW_CONFIDENCE);
  });

  it('treats unknown overlap as unknown, not as acceptable', () => {
    // null means "could not compute", and must not be read as passing the gate.
    const r = evaluateLocal({ ...base, candidateCount: 8, rerankScores: [0.99], lexicalOverlap: null });
    expect(r.status).toBe(StepStatus.LOW_CONFIDENCE);
  });

  it('the lexical gate does not override an exact match', () => {
    // An exact contiguous match is decided before any score is read.
    const r = evaluateLocal({
      ...base,
      exactMatch: { kind: 'full', workIds: ['w1'], windowsMatched: 5 },
      candidateCount: 8,
      rerankScores: [0.99],
      lexicalOverlap: 0,
    });
    expect(r.status).toBe(StepStatus.HAS_RESULT);
  });

  it('is pure — the same input gives the same output', () => {
    const input = { ...base, candidateCount: 3, rerankScores: [0.5] };
    expect(evaluateLocal(input)).toEqual(evaluateLocal(input));
  });

  it('thresholds are injectable, so calibration never edits the pipeline', () => {
    const input = { ...base, candidateCount: 5, rerankScores: [0.4] };
    expect(evaluateLocal(input, PROVISIONAL_THRESHOLDS).status).toBe(StepStatus.LOW_CONFIDENCE);
    expect(
      evaluateLocal(input, { ...PROVISIONAL_THRESHOLDS, noiseFloor: 0.5 }).status,
    ).toBe(StepStatus.NO_RESULT);
  });
});
