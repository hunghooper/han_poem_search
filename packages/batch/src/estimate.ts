/**
 * How long this run will take, before it starts.
 *
 * IT NO LONGER PROJECTS COST, deliberately. It used to, and the projection was worth less than
 * it looked: the six measured agent runs span sevenfold ($0.0083 to $0.0608), so any single
 * figure was either a median that understated the bad case or a maximum that overstated the
 * ordinary one. The gateway's own console reports actual spend, which is a better number than
 * a guess with that much spread.
 *
 * What replaced it is not nothing. The CAP still works, and it is a different thing from an
 * estimate: a console tells you what you spent after you spent it, while the cap stops the
 * agent at a figure the user set. And `cost_usd` per row survives in the export, because a
 * console reports totals and cannot say which row of a spreadsheet cost what.
 *
 * Time is still projected, because that is not money and nothing else reports it.
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
}

/** Measured: exact match 3–70ms, the full local pipeline including rerank ~700ms. */
const LOCAL_SECONDS = 0.75;

/** Measured across live Phase 3/4 runs: 27.8s, 45s, 48.5s end to end. */
const AGENT_SECONDS = 45;

/** Observed share of golden-set queries that fall through to the agent. */
const DEFAULT_AGENT_RATE = 0.3;

const DEFAULT_CONCURRENCY = 4;

export function estimate(input: EstimateInput): Estimate {
  const rows = Math.max(0, Math.trunc(input.rows));
  const concurrency = Math.max(1, input.concurrency ?? DEFAULT_CONCURRENCY);
  const rate = input.agent.enabled ? clamp01(input.agentRate ?? DEFAULT_AGENT_RATE) : 0;

  // Ceil, not round: a one-row re-run with the agent on rounds down to zero agent rows, which
  // reads as "the agent will not be involved" for a run where it will.
  const agentRows = Math.ceil(rows * rate);

  const localSeconds = (rows * LOCAL_SECONDS) / concurrency;
  const agentSeconds = (agentRows * AGENT_SECONDS) / concurrency;

  return {
    rows,
    agentRows,
    seconds: Math.round(localSeconds + agentSeconds),
  };
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
