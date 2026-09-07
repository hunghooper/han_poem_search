/**
 * Agent budgets — the spec §12.
 *
 * "On exhaustion, emit agent_budget_exhausted, then answer from the evidence collected,
 * clearly marked as partial. Never fail silently."
 *
 * Exhaustion is therefore not an error path. It is an ordinary outcome that changes how the
 * answer is presented, which is why this returns a reason string rather than throwing.
 */

export interface Budget {
  maxIterations: number;
  maxToolCalls: number;
  maxWallClockMs: number;
  /** Enforced only while costs are known; a null cost cannot be counted (§4.3). */
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
  /** True once any call returned a null cost — the cost ceiling is then not enforceable. */
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
  /** Null while within budget. */
  exhausted: 'iterations' | 'tool_calls' | 'wall_clock' | 'cost' | null;
  reason: string | null;
}

export function checkBudget(state: BudgetState, budget: Budget, now: number): BudgetCheck {
  const ok: BudgetCheck = { withinBudget: true, exhausted: null, reason: null };

  if (state.iterations >= budget.maxIterations) {
    return { withinBudget: false, exhausted: 'iterations', reason: `reached ${budget.maxIterations} iterations` };
  }
  if (state.toolCalls >= budget.maxToolCalls) {
    return { withinBudget: false, exhausted: 'tool_calls', reason: `made ${budget.maxToolCalls} tool calls` };
  }
  const elapsed = now - state.startedAt;
  if (elapsed >= budget.maxWallClockMs) {
    return { withinBudget: false, exhausted: 'wall_clock', reason: `ran for ${elapsed}ms` };
  }
  // A cost ceiling cannot be enforced against unknown costs. Rather than pretend, the run
  // continues on the other limits and the degradation is reported (§4.3, usage_unavailable).
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

/**
 * Record spend that did not come from the agent's own reasoning call — a tool that called a
 * model on its own. Separate from recordLlmCall because it is not an iteration, and counting
 * it as one would shorten the run for spending money rather than for thinking.
 */
export const recordSpend = (state: BudgetState, costUsd: number | null): BudgetState => ({
  ...state,
  costUsd: state.costUsd + (costUsd ?? 0),
  costUnknown: state.costUnknown || costUsd === null,
});

export const recordToolCall = (state: BudgetState): BudgetState => ({
  ...state,
  toolCalls: state.toolCalls + 1,
});
