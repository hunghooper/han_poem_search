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

import { mkdirSync, createReadStream, statSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
// Imported for its type augmentation: without it `request.file()` does not exist on the
// request type, even though the plugin is registered.
import '@fastify/multipart';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { batchJob, batchRow } from '@han/db/schema';
import { StepStatus } from '@han/shared/status';
import { detect, SNIFF_BYTES } from '@han/batch/detect';
import { scanColumns } from '@han/batch/columns';
import { xlsxToJsonl, XlsxWriter } from '@han/batch/xlsx';
import { JsonlWriter, countJsonlRows, readJsonl } from '@han/batch/jsonl';
import { EXPORT_COLUMNS, headerFor, resolveColumns } from '@han/batch/export-schema';
import { buildRow } from '@han/batch/row';
import { estimate } from '@han/batch/estimate';
import { cancel, isRunning, runBatch, type BatchDeps, type JobRow } from './batch-runner.js';

/** How many rows the column profiler looks at. Enough to be representative, not to be slow. */
const SCAN_ROWS = 200;

const StartSchema = z.object({
  column: z.string().min(1),
  agent: z.object({
    enabled: z.boolean(),
    /** Null is a deliberate choice to run uncapped, not a missing value. */
    capUsd: z.number().positive().max(10_000).nullable(),
  }),
  /** Must match the estimate the user was shown. Guards against a stale confirmation. */
  acknowledgedCostUsd: z.number().nonnegative().optional(),
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
      .object({ agent: StartSchema.shape.agent })
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });

    return estimate({ rows: job.totalRows, agent: body.data.agent });
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

    const est = estimate({ rows: job.totalRows, agent: parsed.data.agent });
    // A confirmation is only meaningful against the number the user actually saw. If the
    // options changed after the dialog was shown, the estimate moved and the confirmation is
    // stale — which is exactly when an expensive run gets started by accident.
    if (
      est.severity !== 'trivial' &&
      parsed.data.acknowledgedCostUsd !== undefined &&
      Math.abs(parsed.data.acknowledgedCostUsd - est.costUsd) > 0.01
    ) {
      return reply.code(409).send({ error: 'estimate changed since it was shown', estimate: est });
    }

    await deps.db
      .update(batchJob)
      .set({
        queryColumn: parsed.data.column,
        agentEnabled: parsed.data.agent.enabled,
        agentCapUsd: parsed.data.agent.capUsd,
        status: 'running',
      })
      .where(eq(batchJob.id, id));

    const updated = await loadJob(deps, id);
    void runBatch(updated as JobRow, deps);
    return { started: true, estimate: est };
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
      costUsd: job.costUsd,
      agentEnabled: job.agentEnabled,
      agentCapUsd: job.agentCapUsd,
      error: job.error,
      running: isRunning(id),
    };
  });

  app.get('/api/batch', async () => {
    const jobs = await deps.db
      .select()
      .from(batchJob)
      .orderBy(desc(batchJob.createdAt))
      .limit(50);
    return { jobs };
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
