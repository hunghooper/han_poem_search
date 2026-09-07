import { describe, expect, it } from 'vitest';
import { checkBudget, DEFAULT_BUDGET, initialBudgetState, recordLlmCall, recordSpend, recordToolCall } from './budget.js';

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

describe('tool timeouts must fit inside the run budget', () => {
  // REGRESSION. ask_model was given a 90s timeout inside a 60s wall-clock budget, so the call
  // could never complete on its own terms: every invocation was cut off by the run instead,
  // and the trace blamed the budget rather than the tool. A timeout longer than the budget it
  // sits inside is always a bug, so it is checked structurally rather than per tool.
  it('no registered tool can outlive the agent wall clock', async () => {
    const { createTools } = await import('./tools/index.js');
    const tools = createTools({
      db: null as never,
      model: null,
      vectors: null,
      provider: null,
      answerModel: null,
    });
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(t.timeoutMs, `${t.name} outlives the run budget`).toBeLessThan(
        DEFAULT_BUDGET.maxWallClockMs,
      );
    }
  });
});

describe('tool spend', () => {
  // REGRESSION. ask_model calls a model and was discarding what it cost, so §12's ceiling
  // covered only the agent's own reasoning calls — and ask_model is usually the largest single
  // spend in a run. A ceiling that cannot see the biggest cost is not a ceiling.
  it('adds tool spend to the run cost without consuming an iteration', () => {
    const s = recordSpend(initialBudgetState(0), 0.02);
    expect(s.costUsd).toBeCloseTo(0.02);
    expect(s.iterations).toBe(0);
  });

  it('marks the accounting degraded when a tool used an unpriced model', () => {
    const s = recordSpend(initialBudgetState(0), null);
    expect(s.costUnknown).toBe(true);
    // And the ceiling then stops being enforced, rather than being enforced against a fiction.
    expect(checkBudget({ ...s, costUsd: 999 }, DEFAULT_BUDGET, 0).withinBudget).toBe(true);
  });

  it('combines agent and tool spend against one ceiling', () => {
    let s = recordLlmCall(initialBudgetState(0), 0.3);
    s = recordSpend(s, 0.25);
    expect(s.costUsd).toBeCloseTo(0.55);
    expect(checkBudget(s, DEFAULT_BUDGET, 0).exhausted).toBe('cost');
  });
});
