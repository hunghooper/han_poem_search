import { describe, expect, it } from 'vitest';
import { checkBudget, DEFAULT_BUDGET, initialBudgetState, recordLlmCall, recordToolCall } from './budget.js';

const at = (t: number) => initialBudgetState(t);

describe('checkBudget', () => {
  it('permits a fresh run', () => {
    expect(checkBudget(at(0), DEFAULT_BUDGET, 0).withinBudget).toBe(true);
  });

  it('stops on each limit and names which one', () => {
    const cases = [
      [{ ...at(0), iterations: 6 }, 0, 'iterations'],
      [{ ...at(0), toolCalls: 12 }, 0, 'tool_calls'],
      [at(0), 60_000, 'wall_clock'],
      [{ ...at(0), costUsd: 0.5 }, 0, 'cost'],
    ] as const;
    for (const [state, now, expected] of cases) {
      const r = checkBudget(state, DEFAULT_BUDGET, now);
      expect(r.withinBudget).toBe(false);
      expect(r.exhausted).toBe(expected);
      expect(r.reason).toBeTruthy();
    }
  });

  // §4.3: a null cost is not zero. Enforcing a ceiling against unknown spend would be fiction.
  it('does not enforce the cost ceiling once any cost is unknown', () => {
    const s = { ...at(0), costUsd: 999, costUnknown: true };
    expect(checkBudget(s, DEFAULT_BUDGET, 0).withinBudget).toBe(true);
  });
});

describe('recording', () => {
  it('counts an iteration and its cost per LLM call', () => {
    const s = recordLlmCall(at(0), 0.01);
    expect(s.iterations).toBe(1);
    expect(s.costUsd).toBeCloseTo(0.01);
    expect(s.costUnknown).toBe(false);
  });

  it('marks the accounting unknown once a call returns a null cost, and stays marked', () => {
    let s = recordLlmCall(at(0), null);
    expect(s.costUnknown).toBe(true);
    s = recordLlmCall(s, 0.01);
    expect(s.costUnknown).toBe(true);
  });

  it('counts tool calls separately from iterations', () => {
    const s = recordToolCall(recordLlmCall(at(0), 0));
    expect(s.iterations).toBe(1);
    expect(s.toolCalls).toBe(1);
  });
});
