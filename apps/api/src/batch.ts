/**
 * Batch routes — upload, scan, estimate, run, export.
 *
 * The flow is deliberately four steps rather than one, and the middle two are the point:
 *
 *   upload   detect the file, normalise it, profile its columns
 *   choose   the user picks the column — never inferred and acted on silently
 *   estimate what this will cost and how long it will take, before anything starts
 *   run      then export
 *
 * A one-shot "upload and go" would be shorter and would let someone spend $600 on a
 * mis-picked column without ever seeing a number.
 */

import { existsSync, mkdirSync, createReadStream, readdirSync, statSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
// Imported for its type augmentation: without it `request.file()` does not exist on the
// request type, even though the plugin is registered.
import '@fastify/multipart';
import { providerForKey, sessionKeyOf } from './session-key.js';
import { count, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { batchJob, batchRow } from '@han/db/schema';
import { StepStatus } from '@han/shared/status';
import { detect, SNIFF_BYTES } from '@han/batch/detect';
import { scanColumns } from '@han/batch/columns';
import { xlsxToJsonl, XlsxWriter } from '@han/batch/xlsx';
import { JsonlWriter, countJsonlRows, readJsonl } from '@han/batch/jsonl';
import { EXPORT_COLUMNS, headerFor, resolveColumns } from '@han/batch/export-schema';
import { buildRow } from '@han/batch/row';
import { formLabelVi } from '@han/batch/form-label';
import { estimate } from '@han/batch/estimate';
import {
  cancel,
  countPending,
  isRunning,
  passProgress,
  runBatch,
  setJobCredentials,
  type BatchDeps,
  type JobRow,
  type RerunMode,
} from './batch-runner.js';

/** How many rows the column profiler looks at. Enough to be representative, not to be slow. */
const SCAN_ROWS = 200;

const StartSchema = z.object({
  column: z.string().min(1),
  agent: z.object({
    enabled: z.boolean(),
    /** Null is a deliberate choice to run uncapped, not a missing value. */
    capUsd: z.number().positive().max(10_000).nullable(),
  }),
  /**
   * Required to start a job that already has results, and it must be said out loud.
   *
   * `unresolved` re-runs only the rows the corpus could not settle — the cheap-then-escalate
   * workflow. `all` re-runs everything and pays for it again.
   */
  rerun: z.enum(['unresolved', 'all']).optional(),
});

export function registerBatchRoutes(app: FastifyInstance, deps: BatchDeps, dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });

  /** The column catalogue, so the UI picker and the server cannot disagree about what exists. */
  app.get('/api/batch/columns', () => ({
    columns: EXPORT_COLUMNS.map((c) => ({
      key: c.key,
      header: headerFor(c.key),
      group: c.group,
      byDefault: c.byDefault,
      locked: c.locked ?? false,
      wide: c.wide ?? false,
    })),
  }));

  app.post('/api/batch/upload', async (request, reply) => {
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: 'no file uploaded' });

    const id = randomUUID();
    const raw = join(dataDir, `${id}.upload`);
    await pipeline(file.file, createWriteStream(raw));

    if (file.file.truncated) {
      await unlink(raw).catch(() => undefined);
      return reply.code(413).send({ error: 'file too large' });
    }

    // Detect from the bytes on disk, never from the filename. A .jsonl holding a JSON array
    // and an .xlsx that is really a legacy .xls are both routine.
    const handle = await open(raw, 'r');
    const head = Buffer.alloc(Math.min(SNIFF_BYTES, statSync(raw).size));
    await handle.read(head, 0, head.length, 0);
    await handle.close();

    const detected = detect(head);
    if (!detected.ok) {
      await unlink(raw).catch(() => undefined);
      return reply.code(400).send({ error: detected.message, reason: detected.reason });
    }

    // Everything downstream reads JSONL, whatever arrived. See packages/batch/src/xlsx.ts for
    // why an xlsx is converted here rather than streamed later.
    const dataPath = join(dataDir, `${id}.jsonl`);
    let headers: string[] = [];
    let total = 0;

    if (detected.kind === 'xlsx') {
      const conv = await xlsxToJsonl(raw, dataPath);
      headers = conv.headers;
      total = conv.total;
    } else {
      await copyFile(raw, dataPath);
      total = await countJsonlRows(dataPath);
    }
    await unlink(raw).catch(() => undefined);

    const sample: Array<Record<string, unknown>> = [];
    for await (const row of readJsonl(dataPath, { limit: SCAN_ROWS })) sample.push(row.values);
    const scan = scanColumns(sample, headers.length > 0 ? headers : undefined);
    if (headers.length === 0) headers = scan.columns.map((c) => c.name);

    await deps.db.insert(batchJob).values({
      id,
      filename: file.filename,
      kind: detected.kind,
      dataPath,
      headers,
      totalRows: total,
      status: 'scanned',
    });

    return {
      jobId: id,
      kind: detected.kind,
      filename: file.filename,
      totalRows: total,
      headers,
      columns: scan.columns,
      // Null means the scan will not guess. The UI must then make the user choose, rather
      // than preselecting the least bad column and letting them click past it.
      suggested: scan.suggested,
      abstainReason: scan.abstainReason ?? null,
    };
  });

  /** What the chosen options will cost, before anything runs. */
  app.post('/api/batch/:id/estimate', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await loadJob(deps, id);
    if (!job) return reply.code(404).send({ error: 'no such job' });

    const body = z
      .object({ agent: StartSchema.shape.agent, rerun: StartSchema.shape.rerun })
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });

    // Estimated over the rows this run would ACTUALLY search, not over the whole file. A
    // second pass on the 1,200 rows that came back empty is a different number from a first
    // pass on 50,000, and quoting the larger one would make the confirmation meaningless.
    const rows = await countPending(deps.db, id, job.totalRows, body.data.rerun ?? null);

    // Can the agent run AT ALL? FOUND ON REAL DATA: a 14,519-row batch was started with the
    // agent enabled and a $100 cap against a server holding no key and with none supplied.
    // The estimate promised agent rows and a cost, the run took two hours, the agent was
    // never invoked once, and the only place that said so was 12,237 traces nobody opens.
    // An estimate that quotes work the system cannot do is worse than no estimate.
    const agentAvailable = sessionKeyOf(request) !== null || deps.provider !== null;
    const agent = agentAvailable ? body.data.agent : { enabled: false, capUsd: null };

    return {
      ...estimate({ rows, agent }),
      pendingRows: rows,
      agentAvailable,
      /** True when the caller asked for the agent and it cannot run — the UI must say so. */
      agentRequestedButUnavailable: body.data.agent.enabled && !agentAvailable,
    };
  });

  app.post('/api/batch/:id/start', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = StartSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const job = await loadJob(deps, id);
    if (!job) return reply.code(404).send({ error: 'no such job' });
    if (isRunning(id)) return reply.code(409).send({ error: 'already running' });
    if (!job.headers.includes(parsed.data.column)) {
      return reply.code(400).send({ error: `no such column: ${parsed.data.column}` });
    }

    // A job that already has results must say what a second run means. Without this the
    // request was accepted, `started: true` was returned with a real cost estimate, and then
    // nothing ran at all — the worst of both, because the caller is told work began.
    const already = await countPending(deps.db, id, job.totalRows, null);
    const isRerun = already < job.totalRows;
    if (isRerun && !parsed.data.rerun) {
      return reply.code(409).send({
        error: 'this job already has results — pass rerun: "unresolved" or "all"',
        settledRows: job.totalRows - already,
      });
    }

    const mode: RerunMode | null = isRerun ? (parsed.data.rerun ?? null) : null;
    const pending = await countPending(deps.db, id, job.totalRows, mode);
    if (pending === 0) {
      return reply.code(409).send({ error: 'nothing left to run in this mode', pendingRows: 0 });
    }

    const est = estimate({ rows: pending, agent: parsed.data.agent });

    await deps.db
      .update(batchJob)
      .set({
        queryColumn: parsed.data.column,
        agentEnabled: parsed.data.agent.enabled,
        agentCapUsd: parsed.data.agent.capUsd,
        status: 'running',
      })
      .where(eq(batchJob.id, id));

    // A key supplied with THIS request bills the person who pressed start, for every row.
    const sessionKey = sessionKeyOf(request);
    const baseURL = process.env.RAMCLOUDS_BASE_URL;
    setJobCredentials(
      id,
      sessionKey && baseURL
        ? { provider: providerForKey(sessionKey, baseURL, undefined), key: sessionKey }
        : null,
    );

    const updated = await loadJob(deps, id);
    void runBatch(updated as JobRow, deps, mode);
    return { started: true, pendingRows: pending, estimate: est };
  });

  app.post('/api/batch/:id/cancel', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!cancel(id)) return reply.code(409).send({ error: 'not running' });
    return { cancelled: true };
  });

  app.get('/api/batch/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await loadJob(deps, id);
    if (!job) return reply.code(404).send({ error: 'no such job' });

    // Counted from the rows themselves rather than from the job's own tally: the tally is a
    // convenience that lags by up to one concurrency window, and a progress bar that
    // disagrees with the export is worse than one that updates a beat later.
    const counts = await statusCounts(deps, id);
    return {
      jobId: job.id,
      filename: job.filename,
      kind: job.kind,
      status: job.status,
      queryColumn: job.queryColumn,
      totalRows: job.totalRows,
      rowsDone: Object.values(counts).reduce((a, b) => a + b, 0),
      byStatus: counts,
      // The pass currently executing, which is what a progress bar must show. `rowsDone`
      // above counts rows that have ANY result and so sits at the total for the whole of a
      // re-run — true, and useless as progress.
      pass: passProgress(id),
      costUsd: job.costUsd,
      agentEnabled: job.agentEnabled,
      agentCapUsd: job.agentCapUsd,
      error: job.error,
      running: isRunning(id),
    };
  });

  /**
   * Recent jobs.
   *
   * Without this the only way back to a job is to upload the file again — which creates a
   * SECOND job, re-runs every row and pays for all of them. The history is what makes the
   * cheap path reachable: reopen the job, re-run only what is unresolved.
   */
  app.get('/api/batch', async () => {
    const jobs = await deps.db
      .select()
      .from(batchJob)
      .orderBy(desc(batchJob.createdAt))
      .limit(50);
    if (jobs.length === 0) return { jobs: [] };

    // One grouped query rather than one per job: a list of 50 jobs should not be 50 round
    // trips, and the counts are what make a row in the list worth reading.
    const counts = await deps.db
      .select({ jobId: batchRow.jobId, status: batchRow.status, n: count() })
      .from(batchRow)
      .where(
        inArray(
          batchRow.jobId,
          jobs.map((j) => j.id),
        ),
      )
      .groupBy(batchRow.jobId, batchRow.status);

    const byJob = new Map<string, Record<string, number>>();
    for (const c of counts) {
      const entry = byJob.get(c.jobId) ?? {};
      entry[c.status] = Number(c.n);
      byJob.set(c.jobId, entry);
    }

    return {
      jobs: jobs.map((j) => ({
        jobId: j.id,
        filename: j.filename,
        kind: j.kind,
        status: j.status,
        totalRows: j.totalRows,
        queryColumn: j.queryColumn,
        costUsd: j.costUsd,
        createdAt: j.createdAt,
        byStatus: byJob.get(j.id) ?? {},
        running: isRunning(j.id),
        // What this job is costing on disk. Nothing deletes these files on its own, so the
        // number has to be visible or it is a leak nobody can see.
        bytes: sizeOnDisk(dataDir, j.id),
      })),
    };
  });

  /**
   * Everything the panel needs to reopen a job, in the shape the upload returned.
   *
   * The column profiles are recomputed from the normalised file rather than stored: reading
   * 200 rows costs nothing, and a stored profile would be a second copy of the truth that
   * could disagree with the file it describes.
   */
  app.get('/api/batch/:id/scan', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await loadJob(deps, id);
    if (!job) return reply.code(404).send({ error: 'no such job' });

    const sample: Array<Record<string, unknown>> = [];
    for await (const row of readJsonl(job.dataPath, { limit: SCAN_ROWS })) sample.push(row.values);
    const scanned = scanColumns(sample, job.headers.length > 0 ? job.headers : undefined);

    return {
      jobId: job.id,
      kind: job.kind,
      filename: job.filename,
      totalRows: job.totalRows,
      headers: job.headers,
      columns: scanned.columns,
      // A reopened job keeps the column the user chose. Re-suggesting would quietly invite
      // them to change it, and a job searched on two different columns is not one job.
      suggested: job.queryColumn ?? scanned.suggested,
      abstainReason: job.queryColumn ? null : (scanned.abstainReason ?? null),
      agentEnabled: job.agentEnabled,
      agentCapUsd: job.agentCapUsd,
    };
  });

  /** Delete a job and the files behind it. The only thing that bounds the data directory. */
  app.delete('/api/batch/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await loadJob(deps, id);
    if (!job) return reply.code(404).send({ error: 'no such job' });
    if (isRunning(id)) return reply.code(409).send({ error: 'cannot delete a running job' });

    // Files first: a row deleted with its files left behind is a leak with no handle on it,
    // whereas files deleted with the row left behind fails loudly on the next read.
    for (const f of jobFiles(dataDir, id)) await unlink(f).catch(() => undefined);
    // batch_row goes with it — the foreign key cascades.
    await deps.db.delete(batchJob).where(eq(batchJob.id, id));
    return { deleted: true };
  });

  app.get('/api/batch/:id/export', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = z
      .object({
        format: z.enum(['jsonl', 'xlsx']).default('jsonl'),
        columns: z.string().optional(),
      })
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.message });

    const job = await loadJob(deps, id);
    if (!job) return reply.code(404).send({ error: 'no such job' });

    const requested = query.data.columns?.split(',').filter((s) => s.length > 0);
    const columns = resolveColumns(requested);
    const results = await loadResults(deps, id);

    const outPath = join(dataDir, `${id}.export.${query.data.format}`);
    const base = job.filename.replace(/\.(jsonl|xlsx)$/iu, '');
    const name = `${base}.han.${query.data.format}`;

    if (query.data.format === 'xlsx') {
      await writeXlsx(outPath, job, columns, results);
    } else {
      await writeJsonl(outPath, job, columns, results);
    }

    reply.header('content-disposition', `attachment; filename="${encodeURIComponent(name)}"`);
    reply.type(
      query.data.format === 'xlsx'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'application/x-ndjson',
    );
    return reply.send(createReadStream(outPath));
  });
}

/**
 * Delete files in the data directory that no job owns.
 *
 * Called at boot, when nothing is running. Uploads write the normalised file BEFORE inserting
 * the job row, so a failure between the two leaves a file with no handle on it — nothing knows
 * it exists, nothing lists it, and nothing will ever delete it. Deleting a job through the API
 * removes its files, so in the ordinary case this finds nothing; it exists for the case where
 * the ordinary path did not complete.
 *
 * Safe by construction: a file is only removed when its id has no row in `batch_job`, so a
 * live job's data can never be swept.
 */
export async function sweepOrphanFiles(
  deps: BatchDeps,
  dataDir: string,
): Promise<{ files: number; bytes: number }> {
  if (!existsSync(dataDir)) return { files: 0, bytes: 0 };

  const rows = await deps.db.select({ id: batchJob.id }).from(batchJob);
  const known = new Set(rows.map((r) => r.id));

  let files = 0;
  let bytes = 0;
  for (const name of readdirSync(dataDir)) {
    const id = name.split('.')[0] ?? '';
    if (known.has(id)) continue;
    const full = join(dataDir, name);
    bytes += statSync(full).size;
    await unlink(full).catch(() => undefined);
    files += 1;
  }
  return { files, bytes };
}

/** The files one job owns: the normalised data and any export left from a download. */
function jobFiles(dataDir: string, id: string): string[] {
  return [
    join(dataDir, `${id}.jsonl`),
    join(dataDir, `${id}.export.jsonl`),
    join(dataDir, `${id}.export.xlsx`),
    join(dataDir, `${id}.upload`),
  ];
}

function sizeOnDisk(dataDir: string, id: string): number {
  let total = 0;
  for (const f of jobFiles(dataDir, id)) {
    if (existsSync(f)) total += statSync(f).size;
  }
  return total;
}

/**
 * A row that has no result yet is exported as NOT_EXECUTED, not omitted.
 *
 * Omitting it would shorten the file and break the alignment with the user's original, and
 * leaving it blank would read as "searched, found nothing". Exporting a half-finished job is
 * a legitimate thing to want; misreporting what is in it is not.
 */
function rowFor(
  index: number,
  results: Map<number, Record<string, unknown>>,
  columns: string[],
): Record<string, unknown> {
  const stored = results.get(index);
  if (!stored) {
    return buildRow({ status: StepStatus.NOT_EXECUTED, outcome: null, top: null }, columns);
  }
  // The run stored every column; the download takes the ones asked for. This is what lets the
  // same finished job be exported twice with different picks and no re-run.
  const picked: Record<string, unknown> = {};
  for (const key of columns) picked[key] = stored[key] ?? null;

  // Derived at DOWNLOAD time, not stored at run time, so a column added after a job ran still
  // fills for every row of it. The Vietnamese form name is a pure function of the form code
  // that is already there; making the user re-run 14,519 rows to populate a rename would be
  // absurd. Anything genuinely new — needing a fresh search — still needs the re-run.
  if (columns.includes('form_label') && picked.form_label === null) {
    picked.form_label = formLabelVi(stored.form as string | null | undefined);
  }
  // Same trick, same reason: `added` is a pure function of the `dataset` already stored on the
  // row, so a job that ran before this column existed still exports it rather than showing a
  // blank where a provenance warning belongs.
  if (columns.includes('added') && picked.added === null) {
    const ds = stored.dataset as string | null | undefined;
    // Falls back to 'no' rather than null whenever the row HAS an answer, matching what the
    // run-time path writes. A result from the model or an outside site has no dataset, and the
    // honest answer to "did this come from an addition" is still no. Only a row with no answer
    // at all leaves the cell empty.
    const answering = stored.status === 'has_result' || stored.status === 'low_confidence';
    picked.added =
      ds === 'user-added' ? 'user' : ds === 'agent-proposed' ? 'agent' : answering ? 'no' : null;
  }
  return picked;
}

async function writeJsonl(
  path: string,
  job: JobRecord,
  columns: string[],
  results: Map<number, Record<string, unknown>>,
): Promise<void> {
  const writer = new JsonlWriter(path);
  try {
    for await (const row of readJsonl(job.dataPath)) {
      const han = rowFor(row.index, results, columns);
      await writer.write(row.values, han as never);
    }
  } finally {
    await writer.close();
  }
}

async function writeXlsx(
  path: string,
  job: JobRecord,
  columns: string[],
  results: Map<number, Record<string, unknown>>,
): Promise<void> {
  const writer = new XlsxWriter(path, job.headers, columns.map(headerFor));
  try {
    for await (const row of readJsonl(job.dataPath)) {
      const han = rowFor(row.index, results, columns);
      writer.write(row.values, columns.map((k) => (han[k] ?? null) as never));
    }
  } finally {
    await writer.close();
  }
}

interface JobRecord extends JobRow {
  filename: string;
  kind: string;
  headers: string[];
  status: string;
  error: string | null;
}

async function loadJob(deps: BatchDeps, id: string): Promise<JobRecord | null> {
  const [job] = await deps.db.select().from(batchJob).where(eq(batchJob.id, id));
  return (job as JobRecord | undefined) ?? null;
}

async function statusCounts(deps: BatchDeps, id: string): Promise<Record<string, number>> {
  const rows = await deps.db
    .select({ status: batchRow.status })
    .from(batchRow)
    .where(eq(batchRow.jobId, id));
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return counts;
}

async function loadResults(
  deps: BatchDeps,
  id: string,
): Promise<Map<number, Record<string, unknown>>> {
  const rows = await deps.db
    .select({ rowIndex: batchRow.rowIndex, result: batchRow.result })
    .from(batchRow)
    .where(eq(batchRow.jobId, id));
  const map = new Map<number, Record<string, unknown>>();
  for (const r of rows) if (r.result) map.set(r.rowIndex, r.result);
  return map;
}

async function copyFile(from: string, to: string): Promise<void> {
  await pipeline(createReadStream(from), createWriteStream(to));
}
