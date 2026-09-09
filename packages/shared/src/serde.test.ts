import { describe, expect, it } from 'vitest';
import { decode, encode, toCamel, toSnake } from './serde.js';

describe('serde', () => {
  it('round-trips the keys we actually use', () => {
    for (const k of ['runId', 'lastSeq', 'agentIteration', 'costUsd', 'rerankScore', 'workId']) {
      expect(toCamel(toSnake(k))).toBe(k);
    }
  });

  it('converts nested objects and arrays', () => {
    const wire = {
      run_id: 'r',
      metadata: { cost_usd: 1, tokens_in: 2 },
      results: [{ rerank_score: 0.5 }],
    };
    expect(decode(wire)).toEqual({
      runId: 'r',
      metadata: { costUsd: 1, tokensIn: 2 },
      results: [{ rerankScore: 0.5 }],
    });
    expect(encode(decode(wire))).toEqual(wire);
  });

  it('leaves CJK string values untouched', () => {
    expect(decode({ text_display: '群峭碧摩天，逍遙不記年。' })).toEqual({
      textDisplay: '群峭碧摩天，逍遙不記年。',
    });
  });

  it('does not mangle non-plain objects', () => {
    const d = new Date('2026-09-06T00:00:00.000Z');
    expect(decode({ created_at: d })).toEqual({ createdAt: d });
  });

  it('preserves null', () => {
    expect(decode({ work_id: null })).toEqual({ workId: null });
  });
});
