import { describe, expect, it } from 'vitest';
import { flagInterrupted } from './batch-runner.js';

/**
 * The guarantee is negative, so the test has to be too: booting must not START anything.
 *
 * This replaced a resume that did start things. In development the API runs under `tsx watch`
 * and reboots on every file save, so one abandoned job was relaunched save after save — 128
 * rows and $11.88 on a real job, none of it asked for, with `agent_cap_usd` null so nothing
 * capped it. A stub that explodes on any unexpected call is the only way to assert "and then
 * it did nothing else".
 */
function stubDb(runningIds: string[]) {
  const calls: Array<{ op: string; value?: unknown }> = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => {
          calls.push({ op: 'select' });
          return runningIds.map((id) => ({ id }));
        },
      }),
    }),
    update: () => ({
      set: (value: unknown) => ({
        where: async () => {
          calls.push({ op: 'update', value });
        },
      }),
    }),
    // Anything that would actually run a row goes through these; neither may be touched.
    insert: () => {
      throw new Error('boot must not write rows');
    },
    execute: () => {
      throw new Error('boot must not execute a batch');
    },
  };
  return { db, calls };
}

const deps = (db: unknown) => ({ db }) as unknown as Parameters<typeof flagInterrupted>[0];

describe('flagInterrupted', () => {
  it('marks an interrupted job and starts nothing', async () => {
    const { db, calls } = stubDb(['job-1', 'job-2']);
    const ids = await flagInterrupted(deps(db));

    expect(ids).toEqual(['job-1', 'job-2']);
    expect(calls.map((c) => c.op)).toEqual(['select', 'update']);
    expect(calls[1]?.value).toEqual({ status: 'interrupted' });
  });

  /** Nothing was interrupted: no write at all, so a quiet boot stays quiet. */
  it('writes nothing when no job was left running', async () => {
    const { db, calls } = stubDb([]);
    const ids = await flagInterrupted(deps(db));

    expect(ids).toEqual([]);
    expect(calls.map((c) => c.op)).toEqual(['select']);
  });
});
