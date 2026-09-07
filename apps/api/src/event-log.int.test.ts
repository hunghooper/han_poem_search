/**
 * §11: "search_run.final_* are a materialized convenience; the event log stays authoritative
 * and the fold must reproduce them. Test that property."
 *
 * This is that test. It runs the real pipeline against the real Postgres — CONTRIBUTING.md is
 * emphatic that the database is not mocked, because the write path and the read-back ARE the
 * thing under test. It uses DATABASE_URL rather than Testcontainers so it can run against the
 * same corpus the developer is already looking at; skipped cleanly when DATABASE_URL is unset.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { fold } from '@han/shared/state';
import { PostgresEventSink, rowToEvent } from './event-sink.js';
import { RunStore } from './events.js';
import { runSearch } from './search.js';
import { DEFAULT_RUNTIME_CONFIG } from '@han/shared/runtime-config';

const url = process.env.DATABASE_URL ?? '';
const configured = url.length > 0;

let pool: pg.Pool;
// Typed as the schemaless client the sink and pipeline expect; this file only issues raw SQL.
let db: NodePgDatabase<Record<string, never>>;
let store: RunStore;
const errors: Array<{ what: string }> = [];

beforeAll(async () => {
  if (!configured) return;
  pool = new pg.Pool({ connectionString: url, max: 3 });
  db = drizzle(pool) as unknown as NodePgDatabase<Record<string, never>>;
  store = new RunStore(new PostgresEventSink(db, (_e, what) => errors.push({ what })));
});

afterAll(async () => {
  if (pool) await pool.end();
});

const readEvents = async (runId: string) => {
  const res = await db.execute<Record<string, unknown>>(sql`
    SELECT event_id, run_id, seq, to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ts,
           step, source, phase, status, flags, agent_iteration, message, metadata
    FROM search_event WHERE run_id = ${runId} ORDER BY seq
  `);
  const rows = Array.isArray(res) ? res : res.rows;
  // Through the production reader, so the test exercises the same path the API uses.
  return rows.map(rowToEvent);
};

describe.skipIf(!configured)('the event log is authoritative (§11)', () => {
  it('persists every emitted event, in order, with no gaps', async () => {
    const runId = store.create('撥雲尋古道');
    await runSearch(
      { db, model: null, vectors: null, provider: null, reasoningModel: null, tools: [], debug: false, config: DEFAULT_RUNTIME_CONFIG },
      store,
      runId,
      '撥雲尋古道',
    );
    await store.flush();
    expect(errors, `sink reported write failures: ${errors.map((e) => e.what).join(', ')}`).toEqual([]);

    const persisted = await readEvents(runId);
    const inMemory = store.since(runId, -1);

    expect(persisted).toHaveLength(inMemory.length);
    expect(persisted.map((e) => e.seq)).toEqual(inMemory.map((e) => e.seq));
    // A gap in the middle of a run is indistinguishable from a run that stopped there.
    expect(persisted.map((e) => e.seq)).toEqual([...Array(persisted.length).keys()]);
  });

  it('the fold over the persisted log reproduces search_run.final_*', async () => {
    const runId = store.create('撥雲尋古道');
    const outcome = await runSearch(
      { db, model: null, vectors: null, provider: null, reasoningModel: null, tools: [], debug: false, config: DEFAULT_RUNTIME_CONFIG },
      store,
      runId,
      '撥雲尋古道',
    );
    await store.flush();

    const res = await db.execute<{ finalStatus: string; finalFlags: string[]; finalConfidence: number }>(sql`
      SELECT final_status AS "finalStatus", final_flags AS "finalFlags", final_confidence AS "finalConfidence"
      FROM search_run WHERE id = ${runId}
    `);
    const row = (Array.isArray(res) ? res : res.rows)[0];
    expect(row, 'search_run was never written').toBeDefined();

    const folded = fold(await readEvents(runId));

    // THE property: the materialized row is derivable from the log alone.
    expect(folded.flags.sort()).toEqual([...row!.finalFlags].sort());
    expect(folded.finished).toBe(true);
    const terminal = folded.steps['final_answer:local'];
    expect(terminal?.status).toBe(row!.finalStatus);
    expect(terminal?.confidence).toBeCloseTo(row!.finalConfidence, 5);
    // And the outcome the caller got is the same thing again, from a third direction.
    expect(outcome.flags.sort()).toEqual(folded.flags.sort());
  });

  it('refuses a duplicate (run_id, seq) rather than overwriting an event', async () => {
    // §11: never UPDATE an event. A duplicate seq means a bug upstream, and an upsert would
    // hide it by silently replacing history.
    const runId = store.create('duplicate check');
    const first = store.emit(runId, { step: 'exact', source: 'exact', phase: 'completed' });
    await store.flush();

    await db.execute(sql`
      INSERT INTO search_event (event_id, run_id, seq, step, source, phase, flags, metadata)
      VALUES (gen_random_uuid(), ${runId}, ${first.seq}, 'exact', 'exact', 'completed', '[]'::jsonb, '{}'::jsonb)
      ON CONFLICT (run_id, seq) DO NOTHING
    `);

    const persisted = await readEvents(runId);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.eventId).toBe(first.eventId);
  });
});
