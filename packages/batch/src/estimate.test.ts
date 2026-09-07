import { describe, expect, it } from 'vitest';
import { estimate, humanSeconds } from './estimate.js';

const noAgent = { enabled: false, capUsd: null };

describe('estimate', () => {
  it('costs nothing with the agent off', () => {
    const e = estimate({ rows: 50_000, agent: noAgent });
    expect(e.costUsd).toBe(0);
    expect(e.agentRows).toBe(0);
    expect(e.severity).toBe('serious'); // still hours of local search
  });

  // The number this whole feature needs to show before anyone presses start. The user chose
  // "cap optional", which is theirs to choose — but not to be surprised by.
  it('puts a real number on 50,000 rows with the agent uncapped', () => {
    const e = estimate({ rows: 50_000, agent: { enabled: true, capUsd: null } });
    expect(e.costUsd).toBeGreaterThan(100);
    expect(e.seconds).toBeGreaterThan(86_400);
    expect(e.severity).toBe('serious');
  });

  it('lets a cap bound the spend', () => {
    const e = estimate({ rows: 50_000, agent: { enabled: true, capUsd: 5 } });
    expect(e.costUsd).toBeLessThanOrEqual(5);
    expect(e.capBinds).toBe(true);
  });

  // A cap stops the AGENT, not the run: capped rows still get a local search and a real
  // status. Reporting them as unexecuted would be the same collapse the status column exists
  // to prevent, one level up.
  it('does not leave capped rows unexecuted', () => {
    const e = estimate({ rows: 50_000, agent: { enabled: true, capUsd: 1 } });
    expect(e.rowsNotExecuted).toBe(0);
  });

  // A single row with the agent on is not free, and an estimate that says $0.00 for it is
  // the one direction a cost estimate must never round.
  it('never quotes zero for a run that will call the model', () => {
    const e = estimate({ rows: 1, agent: { enabled: true, capUsd: null } });
    expect(e.agentRows).toBe(1);
    expect(e.costUsd).toBeGreaterThan(0);
  });

  it('reports a small local-only run as trivial', () => {
    expect(estimate({ rows: 100, agent: noAgent }).severity).toBe('trivial');
  });

  it('is safe on an empty file', () => {
    expect(estimate({ rows: 0, agent: noAgent })).toMatchObject({ rows: 0, costUsd: 0, seconds: 0 });
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
