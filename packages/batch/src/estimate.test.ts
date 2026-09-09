import { describe, expect, it } from 'vitest';
import { estimate, humanSeconds } from './estimate.js';

const noAgent = { enabled: false, capUsd: null };

describe('estimate', () => {
  it('projects time, and does not project cost', () => {
    const e = estimate({ rows: 1000, agent: noAgent });
    expect(e.seconds).toBeGreaterThan(0);
    expect(e).not.toHaveProperty('costUsd');
  });

  it('counts no agent rows when the agent is off', () => {
    expect(estimate({ rows: 50_000, agent: noAgent }).agentRows).toBe(0);
  });

  it('puts real time on 50,000 rows with the agent on', () => {
    const e = estimate({ rows: 50_000, agent: { enabled: true, capUsd: null } });
    expect(e.agentRows).toBe(15_000);
    expect(e.seconds).toBeGreaterThan(86_400);
  });

  it('never rounds a run that will call the model down to zero', () => {
    expect(estimate({ rows: 1, agent: { enabled: true, capUsd: null } }).agentRows).toBe(1);
  });

  it('is safe on an empty file', () => {
    expect(estimate({ rows: 0, agent: noAgent })).toEqual({ rows: 0, agentRows: 0, seconds: 0 });
  });
});

describe('humanSeconds', () => {
  it('scales the unit to the magnitude', () => {
    expect(humanSeconds(45)).toEqual({ value: 45, unit: 'second' });
    expect(humanSeconds(600)).toEqual({ value: 10, unit: 'minute' });
    expect(humanSeconds(7200)).toEqual({ value: 2, unit: 'hour' });
    expect(humanSeconds(2_250_000)).toEqual({ value: 26, unit: 'day' });
  });
});
