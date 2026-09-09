import { and, eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { batchJob, batchRow } from '@han/db/schema';
import { StepStatus } from '@han/shared/status';
import { buildRow, cellText } from '@han/batch/row';
import { EXPORT_COLUMNS } from '@han/batch/export-schema';
import { readJsonl } from '@han/batch/jsonl';
import type { RuntimeConfig } from '@han/shared/runtime-config';
import type { Redis } from 'ioredis';
import type { LlmProvider } from '@han/llm/provider';
import { dropSessionKey, stashSessionKey } from './session-key.js';
import { runSearch, type SearchDeps } from './search.js';
import type { RunStore } from './events.js';

export interface BatchDeps extends SearchDeps {
  store: RunStore;
  keyStore: Redis | null;
  makeToolsWith: (provider: LlmProvider) => SearchDeps['makeTools'];
}

export interface JobRow {
  id: string;
  dataPath: string;
  queryColumn: string | null;
  totalRows: number;
  agentEnabled: boolean;
  agentCapUsd: number | null;
  rowsDone: number;
  costUsd: number;
}

const CONCURRENCY = 4;

const ALL_COLUMNS: string[] = EXPORT_COLUMNS.map((c) => c.key);

const running = new Map<string, { cancelled: boolean; done: number; total: number }>();

export function passProgress(jobId: string): { done: number; total: number } | null {
  const h = running.get(jobId);
  return h ? { done: h.done, total: h.total } : null;
}

const jobKeys = new Map<string, { provider: LlmProvider; key: string }>();

export function setJobCredentials(
  jobId: string,
  creds: { provider: LlmProvider; key: string } | null,
): void {
  if (creds) jobKeys.set(jobId, creds);
  else jobKeys.delete(jobId);
}

export const isRunning = (jobId: string): boolean => running.has(jobId);

export function cancel(jobId: string): boolean {
  const handle = running.get(jobId);
  if (!handle) return false;
  handle.cancelled = true;
  return true;
}

export async function runBatch(
  job: JobRow,
  deps: BatchDeps,
  mode: RerunMode | null = null,
): Promise<void> {
  if (running.has(job.id)) return;
  const handle = { cancelled: false, done: 0, total: 0 };
  running.set(job.id, handle);

  const selected = ALL_COLUMNS;
  const column = job.queryColumn;
  if (!column) throw new Error('BATCH_NO_COLUMN: the job has no query column');

  await deps.db
    .update(batchJob)
    .set({ status: 'running', startedAt: new Date(), error: null })
    .where(eq(batchJob.id, job.id));

  let spent = job.costUsd;
  const skip = await indexesToSkip(deps.db, job.id, mode);
  let done = skip.size;
  handle.total = Math.max(0, job.totalRows - skip.size);

  try {
    let inFlight: Array<Promise<void>> = [];

    for await (const row of readJsonl(job.dataPath)) {
      if (handle.cancelled) break;
      if (skip.has(row.index)) continue;

      const agentAllowed =
        job.agentEnabled && (job.agentCapUsd === null || spent < job.agentCapUsd);

      const work = searchOne(row, column, selected, agentAllowed, job, deps).then((outcome) => {
        spent += outcome.costUsd;
        done += 1;
        handle.done += 1;
      });

      inFlight.push(work);
      if (inFlight.length >= CONCURRENCY) {
        await Promise.all(inFlight);
        inFlight = [];
        await deps.db
          .update(batchJob)
          .set({ rowsDone: done, costUsd: spent })
          .where(eq(batchJob.id, job.id));
      }
    }

    await Promise.all(inFlight);

    await deps.db
      .update(batchJob)
      .set({
        status: handle.cancelled ? 'cancelled' : 'done',
        rowsDone: done,
        costUsd: spent,
        finishedAt: new Date(),
      })
      .where(eq(batchJob.id, job.id));
  } catch (e) {
    await deps.db
      .update(batchJob)
      .set({
        status: 'failed',
        rowsDone: done,
        costUsd: spent,
        finishedAt: new Date(),
        error: e instanceof Error ? e.message : String(e),
      })
      .where(eq(batchJob.id, job.id));
  } finally {
    running.delete(job.id);
    jobKeys.delete(job.id);
  }
}

async function searchOne(
  row: { index: number; values: Record<string, unknown>; parseError?: string },
  column: string,
  columns: string[],
  agentAllowed: boolean,
  job: JobRow,
  deps: BatchDeps,
): Promise<{ costUsd: number }> {
  const write = async (
    status: StepStatus,
    result: Record<string, unknown> | null,
    runId: string | null,
    costUsd: number,
  ): Promise<void> => {
    await deps.db
      .insert(batchRow)
      .values({ jobId: job.id, rowIndex: row.index, runId, status, result, costUsd })
      .onConflictDoUpdate({
        target: [batchRow.jobId, batchRow.rowIndex],
        set: { runId, status, result, costUsd, finishedAt: new Date() },
      });
  };

  if (row.parseError !== undefined) {
    const result = buildRow({ status: StepStatus.ERROR, outcome: null, top: null }, columns);
    await write(StepStatus.ERROR, result, null, 0);
    return { costUsd: 0 };
  }

  const query = cellText(row.values[column]);
  if (query.length === 0) {
    const result = buildRow({ status: StepStatus.SKIPPED, outcome: null, top: null }, columns);
    await write(StepStatus.SKIPPED, result, null, 0);
    return { costUsd: 0 };
  }

  const started = Date.now();
  const runId = deps.store.create(query);
  try {
    const config: RuntimeConfig = {
      ...deps.config,
      agent: { ...deps.config.agent, enabled: agentAllowed },
    };
    const creds = jobKeys.get(job.id) ?? null;
    const rowDeps = creds
      ? {
          ...deps,
          config,
          provider: creds.provider,
          makeTools: deps.makeToolsWith(creds.provider),
        }
      : { ...deps, config };

    if (creds) await stashSessionKey(deps.keyStore, runId, creds.key);
    try {
      const outcome = await runSearch(rowDeps, deps.store, runId, query);
      const costUsd = costOf(deps.store, runId);

      const result = buildRow(
        {
          status: outcome.status,
          outcome,
          top: outcome.evidence[0] ?? null,
          costUsd,
          latencyMs: Date.now() - started,
        },
        columns,
      );
      await write(outcome.status, result, runId, costUsd);
      return { costUsd };
    } finally {
      await dropSessionKey(deps.keyStore, runId);
    }
  } catch (e) {
    const result = buildRow({ status: StepStatus.ERROR, outcome: null, top: null }, columns);
    await write(StepStatus.ERROR, result, runId, 0);
    deps.store.emit(runId, {
      step: 'final_answer',
      source: 'batch',
      phase: 'failed',
      status: StepStatus.ERROR,
      message: e instanceof Error ? e.message : String(e),
    });
    return { costUsd: 0 };
  }
}

function costOf(store: RunStore, runId: string): number {
  let total = 0;
  for (const e of store.since(runId, -1)) {
    const c = e.metadata.costUsd;
    if (typeof c === 'number') total += c;
  }
  return Math.round(total * 1e6) / 1e6;
}

export type RerunMode = 'unresolved' | 'all';

const SETTLED: readonly string[] = [StepStatus.HAS_RESULT, StepStatus.SKIPPED];

export const isSettled = (status: string): boolean => SETTLED.includes(status);

async function indexesToSkip(
  db: NodePgDatabase<Record<string, never>>,
  jobId: string,
  mode: RerunMode | null,
): Promise<Set<number>> {
  if (mode === 'all') return new Set();

  const rows = await db
    .select({ rowIndex: batchRow.rowIndex })
    .from(batchRow)
    .where(
      mode === 'unresolved'
        ? and(eq(batchRow.jobId, jobId), inArray(batchRow.status, [...SETTLED]))
        : eq(batchRow.jobId, jobId),
    );
  return new Set(rows.map((r) => r.rowIndex));
}

export async function countPending(
  db: NodePgDatabase<Record<string, never>>,
  jobId: string,
  totalRows: number,
  mode: RerunMode | null,
): Promise<number> {
  return totalRows - (await indexesToSkip(db, jobId, mode)).size;
}

export async function flagInterrupted(deps: BatchDeps): Promise<string[]> {
  const jobs = await deps.db
    .select({ id: batchJob.id })
    .from(batchJob)
    .where(eq(batchJob.status, 'running'));
  if (jobs.length === 0) return [];

  await deps.db
    .update(batchJob)
    .set({ status: 'interrupted' })
    .where(eq(batchJob.status, 'running'));
  return jobs.map((j) => j.id);
}
