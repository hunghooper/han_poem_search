import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { SearchEventSchema, type SearchEvent } from '@han/shared/events';
import { decode } from '@han/shared/serde';

const OPTIONAL_COLUMNS = ['status', 'agentIteration', 'message', 'messageTrace'] as const;

export function rowToEvent(row: Record<string, unknown>): SearchEvent {
  const decoded = decode<Record<string, unknown>>(row);
  for (const key of OPTIONAL_COLUMNS) {
    if (decoded[key] === null) delete decoded[key];
  }
  return SearchEventSchema.parse(decoded);
}

export interface RunRecord {
  runId: string;
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
  drain(): Promise<void>;
}

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
      await this.db.execute(sql`
        INSERT INTO search_event
          (event_id, run_id, seq, ts, step, source, phase, status, flags, agent_iteration, message, message_trace, metadata)
        VALUES (
          ${e.eventId}, ${e.runId}, ${e.seq}, ${e.ts}, ${e.step}, ${e.source}, ${e.phase},
          ${e.status ?? null}, ${JSON.stringify(e.flags)}::jsonb, ${e.agentIteration ?? null},
          ${e.message ?? null},
          ${e.messageTrace ? JSON.stringify(e.messageTrace) : null}::jsonb,
          ${JSON.stringify(e.metadata)}::jsonb
        )
        ON CONFLICT (run_id, seq) DO NOTHING
      `);
    });
  }

  runFinished(r: RunRecord): void {
    this.push('results insert', async () => {
      if (r.evidence.length === 0) return;
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

export async function loadRun(
  db: NodePgDatabase<Record<string, never>>,
  runId: string,
): Promise<{ events: SearchEvent[]; outcome: unknown } | null> {
  const evRes = await db.execute<Record<string, unknown>>(sql`
    SELECT event_id, run_id, seq,
           to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ts,
           step, source, phase, status, flags, agent_iteration, message, message_trace, metadata
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
    outcome: run
      ? {
          runId,
          status: run.final_status ?? null,
          confidence: run.final_confidence ?? null,
          flags: (run.final_flags as string[] | null) ?? [],
          reason: (run.final_answer as string | null) ?? null,
          evidence,
          colophon: null,
          verification: null,
          reloadedFromLog: true,
        }
      : null,
  };
}
