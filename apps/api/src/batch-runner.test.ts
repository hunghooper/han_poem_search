import { describe, expect, it } from 'vitest';
import { flagInterrupted } from './batch-runner.js';

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

  it('writes nothing when no job was left running', async () => {
    const { db, calls } = stubDb([]);
    const ids = await flagInterrupted(deps(db));

    expect(ids).toEqual([]);
    expect(calls.map((c) => c.op)).toEqual(['select']);
  });
});
