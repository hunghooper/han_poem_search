export interface Budget {
  maxIterations: number;
  maxToolCalls: number;
  maxWallClockMs: number;
  maxCostUsd: number;
}

export const DEFAULT_BUDGET: Budget = {
  maxIterations: 6,
  maxToolCalls: 12,
  maxWallClockMs: 60_000,
  maxCostUsd: 0.5,
};

export interface BudgetState {
  iterations: number;
  toolCalls: number;
  startedAt: number;
  costUsd: number;
  costUnknown: boolean;
}

export const initialBudgetState = (now: number): BudgetState => ({
  iterations: 0,
  toolCalls: 0,
  startedAt: now,
  costUsd: 0,
  costUnknown: false,
});

export interface BudgetCheck {
  withinBudget: boolean;
  exhausted: 'iterations' | 'tool_calls' | 'wall_clock' | 'cost' | null;
  reason: string | null;
}

export function checkBudget(state: BudgetState, budget: Budget, now: number): BudgetCheck {
  const ok: BudgetCheck = { withinBudget: true, exhausted: null, reason: null };

  if (state.iterations >= budget.maxIterations) {
    return {
      withinBudget: false,
      exhausted: 'iterations',
      reason: `reached ${budget.maxIterations} iterations`,
    };
  }
  if (state.toolCalls >= budget.maxToolCalls) {
    return {
      withinBudget: false,
      exhausted: 'tool_calls',
      reason: `made ${budget.maxToolCalls} tool calls`,
    };
  }
  const elapsed = now - state.startedAt;
  if (elapsed >= budget.maxWallClockMs) {
    return { withinBudget: false, exhausted: 'wall_clock', reason: `ran for ${elapsed}ms` };
  }
  if (!state.costUnknown && state.costUsd >= budget.maxCostUsd) {
    return { withinBudget: false, exhausted: 'cost', reason: `spent $${state.costUsd.toFixed(4)}` };
  }
  return ok;
}

export const recordLlmCall = (state: BudgetState, costUsd: number | null): BudgetState => ({
  ...state,
  iterations: state.iterations + 1,
  costUsd: state.costUsd + (costUsd ?? 0),
  costUnknown: state.costUnknown || costUsd === null,
});

export const recordSpend = (state: BudgetState, costUsd: number | null): BudgetState => ({
  ...state,
  costUsd: state.costUsd + (costUsd ?? 0),
  costUnknown: state.costUnknown || costUsd === null,
});

export const recordToolCall = (state: BudgetState): BudgetState => ({
  ...state,
  toolCalls: state.toolCalls + 1,
});
