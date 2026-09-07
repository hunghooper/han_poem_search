/**
 * Running a batch.
 *
 * WHERE THIS RUNS, AND WHY IT IS NOT A TEMPORAL WORKFLOW. The agent loop moved into Temporal
 * in Phase 4 because a single run is a multi-minute conversation with a model, holding state
 * that exists nowhere else until it finishes. A batch is the opposite shape: its state is a
 * row in `batch_row`, committed the moment that row is done. Killing the API mid-batch loses
 * at most the row in flight, and `resumeInterrupted` picks the job up from the highest index
 * already written.
 *
 * So the durability here is Postgres's rather than Temporal's — and it is real, not a claim:
 * rows are idempotent on (job_id, row_index), so a resumed job cannot pay twice for work it
 * already did. What it does NOT give, and Temporal would, is automatic retry of the
 * orchestration itself. If this process never comes back, nothing restarts the job until
 * someone starts the API again.
 *
 * Each row's AGENT still runs as a Temporal workflow, because `runSearch` calls
 * `runAgentWorkflow` exactly as a single search does. Batch reuses the search pipeline whole
 * rather than reimplementing it: a second copy would drift, and "the batch says one thing and
 * the UI says another" is a bug with no good failure mode.
 */

import { and, eq, max, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { batchJob, batchRow } from '@han/db/schema';
import { StepStatus } from '@han/shared/status';
import { buildRow, cellText } from '@han/batch/row';
import { EXPORT_COLUMNS } from '@han/batch/export-schema';
import { readJsonl } from '@han/batch/jsonl';
import type { RuntimeConfig } from '@han/shared/runtime-config';
import { runSearch, type SearchDeps } from './search.js';
import type { RunStore } from './events.js';

export interface BatchDeps extends SearchDeps {
  store: RunStore;
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

/** How many rows are searched at once. Bounded by the gateway and the GPU, not by ambition. */
const CONCURRENCY = 4;

const ALL_COLUMNS: string[] = EXPORT_COLUMNS.map((c) => c.key);

/** Live jobs, so progress can be read and a cancel can be honoured mid-run. */
const running = new Map<string, { cancelled: boolean }>();

export const isRunning = (jobId: string): boolean => running.has(jobId);

export function cancel(jobId: string): boolean {
  const handle = running.get(jobId);
  if (!handle) return false;
  handle.cancelled = true;
  return true;
}

/**
 * Run every row that does not already have a result.
 *
 * Resumable by construction: the set of remaining rows comes from what is in the table, so
 * calling this twice on one job is safe, and calling it after a crash is how the job finishes.
 */
export async function runBatch(job: JobRow, deps: BatchDeps): Promise<void> {
  if (running.has(job.id)) return;
  const handle = { cancelled: false };
  running.set(job.id, handle);

  // EVERY column is computed and stored, not the ones the user has currently ticked.
  //
  // The selection is an export-time concern: the user picks columns when they download, and
  // may download twice with different picks. Storing only the ticked ones would mean a
  // different pick needs the whole batch run again — hours and real money to add a column
  // that was already sitting in the search result when the row was searched.
  const selected = ALL_COLUMNS;
  const column = job.queryColumn;
  if (!column) throw new Error('BATCH_NO_COLUMN: the job has no query column');

  await deps.db
    .update(batchJob)
    .set({ status: 'running', startedAt: new Date(), error: null })
    .where(eq(batchJob.id, job.id));

  let spent = job.costUsd;
  let done = job.rowsDone;
  const resumeFrom = await highestFinishedIndex(deps.db, job.id);

  try {
    let inFlight: Array<Promise<void>> = [];

    for await (const row of readJsonl(job.dataPath)) {
      if (handle.cancelled) break;
      // Rows already written are skipped rather than redone. This is what makes a resume
      // cheap, and what stops a restart paying the model twice for the same row.
      if (resumeFrom !== null && row.index <= resumeFrom) continue;

      // The cap stops the AGENT, not the run. Remaining rows still get a local search and a
      // real status: reporting them as unexecuted would say "we did not look" about rows we
      // did look at, which is the collapse the status vocabulary exists to prevent.
      const agentAllowed =
        job.agentEnabled && (job.agentCapUsd === null || spent < job.agentCapUsd);

      const work = searchOne(row, column, selected, agentAllowed, job, deps).then((outcome) => {
        spent += outcome.costUsd;
        done += 1;
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
    // The job stops, and says why. A batch that dies silently at row 12,000 leaves the user
    // watching a progress bar that will never move again.
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
  }
}

/**
 * One row.
 *
 * Never throws. A row that fails is a row with an ERROR status, not a batch that stops: one
 * malformed cell in 50,000 must not cost the other 49,999.
 */
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
    // An empty cell was not searched. SKIPPED, not NO_RESULT: the corpus was never asked.
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
    const outcome = await runSearch({ ...deps, config }, deps.store, runId, query);
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

/** What this row actually spent, summed from the event metadata the run already records. */
function costOf(store: RunStore, runId: string): number {
  let total = 0;
  for (const e of store.since(runId, -1)) {
    const c = e.metadata.costUsd;
    if (typeof c === 'number') total += c;
  }
  return Math.round(total * 1e6) / 1e6;
}

async function highestFinishedIndex(
  db: NodePgDatabase<Record<string, never>>,
  jobId: string,
): Promise<number | null> {
  const [row] = await db
    .select({ n: max(batchRow.rowIndex) })
    .from(batchRow)
    .where(eq(batchRow.jobId, jobId));
  return row?.n ?? null;
}

/**
 * Jobs that were running when the process died.
 *
 * Called at boot. Without it, a batch interrupted by a deploy sits at `running` forever,
 * showing a progress bar nobody is advancing — which looks exactly like a slow job.
 */
export async function resumeInterrupted(deps: BatchDeps): Promise<string[]> {
  const jobs = await deps.db
    .select()
    .from(batchJob)
    .where(and(eq(batchJob.status, 'running'), sql`${batchJob.queryColumn} is not null`));

  for (const job of jobs) {
    void runBatch(job as JobRow, deps);
  }
  return jobs.map((j) => j.id);
}
