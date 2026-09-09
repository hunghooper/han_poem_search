export interface EstimateInput {
  rows: number;
  agent: { enabled: boolean; capUsd: number | null };
  agentRate?: number;
  concurrency?: number;
}

export interface Estimate {
  rows: number;
  agentRows: number;
  seconds: number;
}

const LOCAL_SECONDS = 0.75;

const AGENT_SECONDS = 45;

const DEFAULT_AGENT_RATE = 0.3;

const DEFAULT_CONCURRENCY = 4;

export function estimate(input: EstimateInput): Estimate {
  const rows = Math.max(0, Math.trunc(input.rows));
  const concurrency = Math.max(1, input.concurrency ?? DEFAULT_CONCURRENCY);
  const rate = input.agent.enabled ? clamp01(input.agentRate ?? DEFAULT_AGENT_RATE) : 0;

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

export function humanSeconds(seconds: number): {
  value: number;
  unit: 'second' | 'minute' | 'hour' | 'day';
} {
  if (seconds < 90) return { value: Math.round(seconds), unit: 'second' };
  if (seconds < 5400) return { value: round1(seconds / 60), unit: 'minute' };
  if (seconds < 172800) return { value: round1(seconds / 3600), unit: 'hour' };
  return { value: round1(seconds / 86400), unit: 'day' };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
