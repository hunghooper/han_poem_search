/**
 * What this run will cost and how long it will take, before it starts.
 *
 * The user asked for the agent cap to be optional, which is theirs to decide. What is not
 * optional is knowing: 50,000 rows with the agent on and no cap is roughly 26 days and $600,
 * and nobody should discover that from a bill. So the estimate is computed here, shown before
 * the start button does anything, and the confirmation names the numbers.
 *
 * The figures come from measurement, not from guessing — see docs/adr/010 and the Phase 3
 * runs. They are approximate and labelled as such; the point is the order of magnitude, which
 * is what separates "press it" from "do not press it".
 */

export interface EstimateInput {
  rows: number;
  agent: { enabled: boolean; capUsd: number | null };
  /**
   * Share of rows expected to reach the agent, 0..1. Only rows the local corpus cannot resolve
   * confidently do. Callers that have run a sample pass their measured rate; the default is
   * the observed rate on the golden set.
   */
  agentRate?: number;
  /** How many rows are searched at once. Bounded by the gateway, not by us. */
  concurrency?: number;
}

export interface Estimate {
  rows: number;
  /** Rows expected to call the model. */
  agentRows: number;
  seconds: number;
  costUsd: number;
  /** True when the cap will stop the run before every row is searched. */
  capBinds: boolean;
  /** Rows expected to finish as NOT_EXECUTED because the cap was reached first. */
  rowsNotExecuted: number;
  /** Shown prominently, and the reason the confirmation exists. */
  severity: 'trivial' | 'notable' | 'serious';
}

/** Measured: exact match 3–70ms, the full local pipeline including rerank ~700ms. */
const LOCAL_SECONDS = 0.75;

/** Measured across live Phase 3/4 runs: 27.8s, 45s, 48.5s end to end. */
const AGENT_SECONDS = 45;

/** Measured: $0.009394 and $0.012448 on live runs with glm-5.3-flash answering. */
const AGENT_COST_USD = 0.012;

/** Observed share of golden-set queries that fall through to the agent. */
const DEFAULT_AGENT_RATE = 0.3;

const DEFAULT_CONCURRENCY = 4;

export function estimate(input: EstimateInput): Estimate {
  const rows = Math.max(0, Math.trunc(input.rows));
  const concurrency = Math.max(1, input.concurrency ?? DEFAULT_CONCURRENCY);
  const rate = input.agent.enabled ? clamp01(input.agentRate ?? DEFAULT_AGENT_RATE) : 0;

  const wanted = Math.round(rows * rate);
  const cap = input.agent.capUsd;

  // The cap binds on COST, and cost only accrues on rows that reach the agent. A cap of $5
  // over 50,000 rows does not stop the run — it stops the agent, and the remaining rows still
  // get a local search. They are only NOT_EXECUTED if the local pass is skipped, which it
  // never is.
  const affordable = cap === null ? wanted : Math.min(wanted, Math.floor(cap / AGENT_COST_USD));
  const capBinds = affordable < wanted;

  const localSeconds = (rows * LOCAL_SECONDS) / concurrency;
  const agentSeconds = (affordable * AGENT_SECONDS) / concurrency;
  const costUsd = affordable * AGENT_COST_USD;

  return {
    rows,
    agentRows: affordable,
    seconds: Math.round(localSeconds + agentSeconds),
    costUsd: Math.round(costUsd * 100) / 100,
    capBinds,
    // Capped rows still get a local answer, so nothing is left unexecuted by the cap alone.
    rowsNotExecuted: 0,
    severity: severityOf(costUsd, localSeconds + agentSeconds),
  };
}

/**
 * Anything past an hour or ten dollars is `serious` and the UI makes the user type to confirm.
 * The thresholds are arbitrary but the tiers are not: the difference between a run you can
 * watch and a run you have to plan for is the thing worth surfacing.
 */
function severityOf(costUsd: number, seconds: number): Estimate['severity'] {
  if (costUsd >= 10 || seconds >= 3600) return 'serious';
  if (costUsd >= 1 || seconds >= 300) return 'notable';
  return 'trivial';
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** "26 days", "3,7 giờ", "45s" — formatted by the UI, which owns the language. */
export function humanSeconds(seconds: number): { value: number; unit: 'second' | 'minute' | 'hour' | 'day' } {
  if (seconds < 90) return { value: Math.round(seconds), unit: 'second' };
  if (seconds < 5400) return { value: round1(seconds / 60), unit: 'minute' };
  if (seconds < 172800) return { value: round1(seconds / 3600), unit: 'hour' };
  return { value: round1(seconds / 86400), unit: 'day' };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
