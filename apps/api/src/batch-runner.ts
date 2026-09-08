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

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { batchJob, batchRow } from '@han/db/schema';
import { StepStatus } from '@han/shared/status';
import { buildRow, cellText } from '@han/batch/row';
import { EXPORT_COLUMNS } from '@han/batch/export-schema';
import { readJsonl } from '@han/batch/jsonl';
import type { RuntimeConfig } from '@han/shared/runtime-config';
import type { LlmProvider } from '@han/llm/provider';
import { runSearch, type SearchDeps } from './search.js';
import type { RunStore } from './events.js';

export interface BatchDeps extends SearchDeps {
  store: RunStore;
  /** Rebuilds the tool set against a different provider, for a job running on a visitor's key. */
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

/** How many rows are searched at once. Bounded by the gateway and the GPU, not by ambition. */
const CONCURRENCY = 4;

const ALL_COLUMNS: string[] = EXPORT_COLUMNS.map((c) => c.key);

/** Live jobs, so progress can be read and a cancel can be honoured mid-run. */
const running = new Map<string, { cancelled: boolean }>();

/**
 * A gateway key supplied by whoever started this job.
 *
 * In memory only, and dropped when the job ends: it is a secret, so it must not go into
 * `batch_job` where it would outlive the visit and sit in a backup. A job resumed after a
 * restart therefore has no key and runs without the agent — which is the honest degradation,
 * because the person who could authorise the spend is no longer there to be asked.
 */
const jobKeys = new Map<string, LlmProvider>();

export function setJobProvider(jobId: string, provider: LlmProvider | null): void {
  if (provider) jobKeys.set(jobId, provider);
  else jobKeys.delete(jobId);
}

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
export async function runBatch(
  job: JobRow,
  deps: BatchDeps,
  /** Null continues an unfinished run; a mode re-runs a job that already has results. */
  mode: RerunMode | null = null,
): Promise<void> {
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
  const skip = await indexesToSkip(deps.db, job.id, mode);
  let done = skip.size;

  try {
    let inFlight: Array<Promise<void>> = [];

    for await (const row of readJsonl(job.dataPath)) {
      if (handle.cancelled) break;
      // A SET of indexes, not "everything below the highest one written". Rows finish four at
      // a time, so a process killed mid-group can leave index 5 unwritten while index 7 is
      // committed — and a high-water mark would then skip row 5 for good, marking the job
      // done with a row that was never searched.
      if (skip.has(row.index)) continue;

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
    jobKeys.delete(job.id);
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
    // A job started with someone's own key bills that key for every row of it.
    const jobProvider = jobKeys.get(job.id) ?? null;
    const rowDeps = jobProvider
      ? { ...deps, config, provider: jobProvider, makeTools: deps.makeToolsWith(jobProvider) }
      : { ...deps, config };
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

/**
 * How a second run over a job that already has results should treat those results.
 *
 * `unresolved` is the one people actually want, and the workflow it serves is the reason this
 * exists: run the whole file locally for nothing, look at what came back, then spend money
 * only on the rows the corpus could not settle. Re-running the rows that already matched
 * exactly would pay a model to re-confirm answers that are already certain.
 */
export type RerunMode = 'unresolved' | 'all';

/**
 * Statuses a re-run leaves alone. Everything else is worth another attempt.
 *
 * SKIPPED is here because in a batch it means one thing only: the cell was empty. No amount of
 * agent will find a poem in a blank cell, so counting those rows as pending would inflate
 * every estimate — on a file with many blanks, by a lot — and quote for work that returns
 * immediately. A row that errored or timed out IS worth retrying, and is not in this list.
 */
const SETTLED: readonly string[] = [StepStatus.HAS_RESULT, StepStatus.SKIPPED];

/** Exported for its test: the line between "leave it alone" and "worth another attempt". */
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

/** How many rows a run in this mode would actually search. What the estimate must be built on. */
export async function countPending(
  db: NodePgDatabase<Record<string, never>>,
  jobId: string,
  totalRows: number,
  mode: RerunMode | null,
): Promise<number> {
  return totalRows - (await indexesToSkip(db, jobId, mode)).size;
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
