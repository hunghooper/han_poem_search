/**
 * Durable event log — the spec §11.
 *
 * "search_event is append-only, (run_id, seq) unique. Never UPDATE an event. Corrections are
 * new events. search_run.final_* are a materialized convenience; the event log stays
 * authoritative and the fold must reproduce them."
 *
 * Two constraints shape this, and they pull against each other:
 *
 *   1. Persistence must NOT slow the search. The §7.1 fast path answers in 15ms; awaiting a
 *      round trip per event would multiply that many times over for bookkeeping the user is
 *      not waiting on.
 *   2. Order must hold. (run_id, seq) is unique and the fold sorts by seq, so writes racing
 *      each other is survivable — but writes LOST out of order are not, because a gap in the
 *      middle of a run is indistinguishable from a run that stopped there.
 *
 * So events are queued and drained by one serial writer per process. The search never awaits
 * a write; the writer preserves order; and a failure is logged loudly rather than swallowed,
 * because a silently short event log is exactly the opaque failure §1 forbids.
 */

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { SearchEventSchema, type SearchEvent } from '@han/shared/events';
import { decode } from '@han/shared/serde';

/**
 * Read one persisted event back as a SearchEvent.
 *
 * SQL has one word for "absent" and it is NULL; the frozen §5.2 schema spells absence as an
 * OPTIONAL key. An event written and read back therefore fails to parse as its own contract —
 * caught by the §11 property test, which is precisely what that test is for.
 *
 * The contract is frozen (§0), so the schema is not the thing to change. The mismatch is a
 * property of the SQL representation, so it is reconciled here, where SQL lives: a NULL in a
 * column backing an optional field means the key was never set.
 */
const OPTIONAL_COLUMNS = ['status', 'agentIteration', 'message'] as const;

export function rowToEvent(row: Record<string, unknown>): SearchEvent {
  const decoded = decode<Record<string, unknown>>(row);
  for (const key of OPTIONAL_COLUMNS) {
    if (decoded[key] === null) delete decoded[key];
  }
  return SearchEventSchema.parse(decoded);
}

export interface RunRecord {
  runId: string;
  /**
   * The evidence the answer rests on, in rank order. Persisted alongside the run so a reloaded
   * run can show the poems and not merely the trace of having found them — the difference
   * between a record of what happened and a record you can read.
   */
  evidence: unknown[];
  query: string;
  normalizedQuery: string | null;
  finalStatus: string | null;
  finalConfidence: number | null;
  finalFlags: string[];
  finalAnswer: string | null;
  totalCostUsd: number;
  agentInvoked: boolean;
}

export interface EventSink {
  runStarted(runId: string, query: string): void;
  event(e: SearchEvent): void;
  runFinished(record: RunRecord): void;
  /** Resolves when everything queued so far has been written. For tests and shutdown. */
  drain(): Promise<void>;
}

/** Used when no database is configured; the API still works, runs just do not survive a restart. */
export const nullSink: EventSink = {
  runStarted: () => {},
  event: () => {},
  runFinished: () => {},
  drain: () => Promise.resolve(),
};

type Job = () => Promise<void>;

export class PostgresEventSink implements EventSink {
  private queue: Job[] = [];
  private draining = false;
  private idle: Promise<void> = Promise.resolve();
  private resolveIdle: (() => void) | null = null;

  constructor(
    private readonly db: NodePgDatabase<Record<string, never>>,
    private readonly onError: (e: unknown, what: string) => void,
  ) {}

  private push(what: string, job: Job): void {
    this.queue.push(async () => {
      try {
        await job();
      } catch (e) {
        // Never rethrow into the drain loop: one failed insert must not stop the writer and
        // silently truncate every later run in the process.
        this.onError(e, what);
      }
    });
    if (!this.draining) void this.drainLoop();
  }

  private async drainLoop(): Promise<void> {
    this.draining = true;
    if (!this.resolveIdle) this.idle = new Promise<void>((r) => (this.resolveIdle = r));
    while (this.queue.length > 0) {
      const job = this.queue.shift();
      if (job) await job();
    }
    this.draining = false;
    this.resolveIdle?.();
    this.resolveIdle = null;
  }

  runStarted(runId: string, query: string): void {
    this.push('run insert', async () => {
      await this.db.execute(sql`
        INSERT INTO search_run (id, query) VALUES (${runId}, ${query})
        ON CONFLICT (id) DO NOTHING
      `);
    });
  }

  event(e: SearchEvent): void {
    this.push(`event ${e.step}#${e.seq}`, async () => {
      // ON CONFLICT DO NOTHING, never DO UPDATE: §11 says an event is never updated, and a
      // duplicate (run_id, seq) means a bug upstream that an upsert would hide.
      await this.db.execute(sql`
        INSERT INTO search_event
          (event_id, run_id, seq, ts, step, source, phase, status, flags, agent_iteration, message, metadata)
        VALUES (
          ${e.eventId}, ${e.runId}, ${e.seq}, ${e.ts}, ${e.step}, ${e.source}, ${e.phase},
          ${e.status ?? null}, ${JSON.stringify(e.flags)}::jsonb, ${e.agentIteration ?? null},
          ${e.message ?? null}, ${JSON.stringify(e.metadata)}::jsonb
        )
        ON CONFLICT (run_id, seq) DO NOTHING
      `);
    });
  }

  runFinished(r: RunRecord): void {
    this.push('results insert', async () => {
      if (r.evidence.length === 0) return;
      // One statement for the whole set: eight round trips to record eight rows nobody is
      // waiting on is eight chances for the writer to fall behind the next run.
      //
      // Built from sql fragments rather than string concatenation — the evidence is poem text
      // from a crawled corpus and query-derived metadata, so it is parameterised, not pasted.
      const rows = r.evidence.map(
        (e, i) => sql`(gen_random_uuid(), ${r.runId}, ${i}, ${JSON.stringify(e)}::jsonb)`,
      );
      await this.db.execute(sql`
        INSERT INTO search_result (id, run_id, rank, evidence)
        VALUES ${sql.join(rows, sql`, `)}
        ON CONFLICT (run_id, rank) DO NOTHING
      `);
    });

    this.push('run finalize', async () => {
      await this.db.execute(sql`
        UPDATE search_run SET
          normalized_query = ${r.normalizedQuery},
          finished_at = now(),
          final_status = ${r.finalStatus},
          final_confidence = ${r.finalConfidence},
          final_flags = ${JSON.stringify(r.finalFlags)}::jsonb,
          final_answer = ${r.finalAnswer},
          total_cost_usd = ${r.totalCostUsd},
          agent_invoked = ${r.agentInvoked}
        WHERE id = ${r.runId}
      `);
    });
  }

  async drain(): Promise<void> {
    if (this.queue.length === 0 && !this.draining) return;
    await this.idle;
  }
}

/**
 * Read a finished run back from the log.
 *
 * The point of persisting events is that a run outlives the process that served it. Without
 * this the log would be write-only — technically satisfying §11 and useless to anyone.
 */
export async function loadRun(
  db: NodePgDatabase<Record<string, never>>,
  runId: string,
): Promise<{ events: SearchEvent[]; outcome: unknown } | null> {
  const evRes = await db.execute<Record<string, unknown>>(sql`
    SELECT event_id, run_id, seq,
           to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ts,
           step, source, phase, status, flags, agent_iteration, message, metadata
    FROM search_event WHERE run_id = ${runId} ORDER BY seq
  `);
  const rows = Array.isArray(evRes) ? evRes : evRes.rows;
  if (rows.length === 0) return null;

  const runRes = await db.execute<Record<string, unknown>>(sql`
    SELECT final_status, final_confidence, final_flags, final_answer
    FROM search_run WHERE id = ${runId}
  `);
  const run = (Array.isArray(runRes) ? runRes : runRes.rows)[0];

  const resRes = await db.execute<{ evidence: unknown }>(sql`
    SELECT evidence FROM search_result WHERE run_id = ${runId} ORDER BY rank
  `);
  const evidence = (Array.isArray(resRes) ? resRes : resRes.rows).map((row) => row.evidence);

  return {
    events: rows.map(rowToEvent),
    // Evidence is read back from search_result, so a reloaded run shows the poems and not
    // only the trace of having found them.
    outcome: run
      ? {
          runId,
          status: run.final_status ?? null,
          confidence: run.final_confidence ?? null,
          flags: (run.final_flags as string[] | null) ?? [],
          reason: (run.final_answer as string | null) ?? null,
          evidence,
          colophon: null,
          // Verification and the colophon split are derivable from the trace but are not
          // stored, so a reloaded run reports them absent rather than reconstructing them
          // from event text and presenting a guess as a record.
          verification: null,
          reloadedFromLog: true,
        }
      : null,
  };
}
