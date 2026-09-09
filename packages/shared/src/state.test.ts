import { describe, expect, it } from 'vitest';
import { fold, initialState, reduce, stepKey, failedSources } from './state.js';
import type { SearchEvent } from './events.js';
import { StepStatus } from './status.js';
import { AggregateFlag, flag } from './flags.js';

const RUN = '11111111-1111-4111-8111-111111111111';
let n = 0;
const ev = (p: Partial<SearchEvent>): SearchEvent => ({
  eventId: `2222${(n++).toString().padStart(4, '0')}-2222-4222-8222-222222222222`,
  runId: RUN,
  seq: 0,
  ts: '2026-09-06T00:00:00.000Z',
  step: 'exact',
  source: 'exact',
  phase: 'completed',
  flags: [],
  metadata: {},
  ...p,
});

describe('reduce', () => {
  it('is idempotent — replaying a seq already applied changes nothing', () => {
    const e = ev({ seq: 0, status: StepStatus.HAS_RESULT });
    const once = reduce(initialState(), e);
    const twice = reduce(once, e);
    expect(twice).toBe(once);
  });

  it('orders by seq, not arrival order — reconnect replay is order-insensitive', () => {
    const a = ev({ seq: 0, step: 'normalization', source: 'query', phase: 'started' });
    const b = ev({ seq: 1, step: 'exact', source: 'exact', status: StepStatus.HAS_RESULT });
    const c = ev({ seq: 2, step: 'final_answer', source: 'local' });
    expect(fold([c, a, b])).toEqual(fold([a, b, c]));
  });

  it('keeps two sources on the same step distinct', () => {
    const s = fold([
      ev({ seq: 0, step: 'tool_call', source: 'google', status: StepStatus.NO_RESULT }),
      ev({ seq: 1, step: 'tool_call', source: 'thivien', status: StepStatus.HAS_RESULT }),
    ]);
    expect(Object.keys(s.steps)).toHaveLength(2);
    expect(s.steps[stepKey('tool_call', 'google')]?.status).toBe(StepStatus.NO_RESULT);
    expect(s.steps[stepKey('tool_call', 'thivien')]?.status).toBe(StepStatus.HAS_RESULT);
  });

  it('accumulates flags without duplicating them', () => {
    const s = fold([
      ev({ seq: 0, flags: [AggregateFlag.EXACT_PARTIAL_MATCH, AggregateFlag.INPUT_REORDERED] }),
      ev({ seq: 1, flags: [AggregateFlag.INPUT_REORDERED, flag('exact', StepStatus.HAS_RESULT)] }),
    ]);
    expect(s.flags).toEqual(['exact_partial_match', 'input_reordered', 'exact_has_result']);
  });

  it('sums cost and tokens across the run', () => {
    const s = fold([
      ev({
        seq: 0,
        step: 'agent',
        source: 'model',
        metadata: { costUsd: 0.01, tokensIn: 100, tokensOut: 20 },
      }),
      ev({
        seq: 1,
        step: 'llm_verification',
        source: 'llm_verify',
        metadata: { costUsd: 0.02, tokensIn: 50, tokensOut: 10 },
      }),
    ]);
    expect(s.totalCostUsd).toBeCloseTo(0.03);
    expect(s.totalTokensIn).toBe(150);
    expect(s.totalTokensOut).toBe(30);
  });

  it('distinguishes failure from finding nothing', () => {
    const s = fold([
      ev({ seq: 0, step: 'tool_call', source: 'google', status: StepStatus.NO_RESULT }),
      ev({ seq: 1, step: 'tool_call', source: 'ctext', status: StepStatus.TIMEOUT }),
      ev({ seq: 2, step: 'tool_call', source: 'souyun', status: StepStatus.UNAVAILABLE }),
    ]);
    expect(
      failedSources(s)
        .map((f) => f.source)
        .sort(),
    ).toEqual(['ctext', 'souyun']);
  });

  it('preserves started metadata when the completed event omits it', () => {
    const s = fold([
      ev({ seq: 0, phase: 'started', metadata: { query: '撥雲尋古道' } }),
      ev({
        seq: 1,
        phase: 'completed',
        status: StepStatus.HAS_RESULT,
        metadata: { latencyMs: 42 },
      }),
    ]);
    const st = s.steps[stepKey('exact', 'exact')];
    expect(st?.latencyMs).toBe(42);
    expect(st?.startedAtSeq).toBe(0);
    expect(st?.completedAtSeq).toBe(1);
  });

  it('a partial stream folds without throwing — gaps are normal on reconnect', () => {
    expect(() => fold([ev({ seq: 7 }), ev({ seq: 19 })])).not.toThrow();
    expect(fold([ev({ seq: 7 }), ev({ seq: 19 })]).lastSeq).toBe(19);
  });

  it('marks the run finished only on a terminal final_answer event', () => {
    expect(fold([ev({ seq: 0, step: 'final_answer', phase: 'started' })]).finished).toBe(false);
    expect(fold([ev({ seq: 0, step: 'final_answer', phase: 'completed' })]).finished).toBe(true);
    expect(fold([ev({ seq: 0, step: 'final_answer', phase: 'failed' })]).finished).toBe(true);
  });
});

describe('reconnect', () => {
  it('folding a full stream equals folding a prefix then replaying the suffix', () => {
    const events = Array.from({ length: 12 }, (_, i) =>
      ev({ seq: i, step: i % 2 ? 'tool_call' : 'exact', source: i % 3 ? 'exact' : 'google' }),
    );
    const full = fold(events);
    const prefix = fold(events.slice(0, 5));
    const resumed = events.slice(5).reduce(reduce, prefix);
    expect(resumed).toEqual(full);
  });

  it('an overlapping replay window does not double-count cost', () => {
    const events = Array.from({ length: 6 }, (_, i) => ev({ seq: i, metadata: { costUsd: 0.01 } }));
    const prefix = fold(events.slice(0, 4));
    const resumed = events.slice(2).reduce(reduce, prefix);
    expect(resumed.totalCostUsd).toBeCloseTo(0.06);
  });
});
