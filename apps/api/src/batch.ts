import { existsSync, mkdirSync, createReadStream, readdirSync, statSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
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

const SCAN_ROWS = 200;

const StartSchema = z.object({
  column: z.string().min(1),
  agent: z.object({
    enabled: z.boolean(),
    capUsd: z.number().positive().max(10_000).nullable(),
  }),
  rerun: z.enum(['unresolved', 'all']).optional(),
});

export function registerBatchRoutes(app: FastifyInstance, deps: BatchDeps, dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });

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

    const handle = await open(raw, 'r');
    const head = Buffer.alloc(Math.min(SNIFF_BYTES, statSync(raw).size));
    await handle.read(head, 0, head.length, 0);
    await handle.close();

    const detected = detect(head);
    if (!detected.ok) {
      await unlink(raw).catch(() => undefined);
      return reply.code(400).send({ error: detected.message, reason: detected.reason });
    }

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
      suggested: scan.suggested,
      abstainReason: scan.abstainReason ?? null,
    };
  });

  app.post('/api/batch/:id/estimate', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await loadJob(deps, id);
    if (!job) return reply.code(404).send({ error: 'no such job' });

    const body = z
      .object({ agent: StartSchema.shape.agent, rerun: StartSchema.shape.rerun })
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });

    const rows = await countPending(deps.db, id, job.totalRows, body.data.rerun ?? null);

    const agentAvailable = sessionKeyOf(request) !== null || deps.provider !== null;
    const agent = agentAvailable ? body.data.agent : { enabled: false, capUsd: null };

    return {
      ...estimate({ rows, agent }),
      pendingRows: rows,
      agentAvailable,
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
      pass: passProgress(id),
      costUsd: job.costUsd,
      agentEnabled: job.agentEnabled,
      agentCapUsd: job.agentCapUsd,
      error: job.error,
      running: isRunning(id),
    };
  });

  app.get('/api/batch', async () => {
    const jobs = await deps.db.select().from(batchJob).orderBy(desc(batchJob.createdAt)).limit(50);
    if (jobs.length === 0) return { jobs: [] };

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
        bytes: sizeOnDisk(dataDir, j.id),
      })),
    };
  });

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
      suggested: job.queryColumn ?? scanned.suggested,
      abstainReason: job.queryColumn ? null : (scanned.abstainReason ?? null),
      agentEnabled: job.agentEnabled,
      agentCapUsd: job.agentCapUsd,
    };
  });

  app.delete('/api/batch/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await loadJob(deps, id);
    if (!job) return reply.code(404).send({ error: 'no such job' });
    if (isRunning(id)) return reply.code(409).send({ error: 'cannot delete a running job' });

    for (const f of jobFiles(dataDir, id)) await unlink(f).catch(() => undefined);
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

function rowFor(
  index: number,
  results: Map<number, Record<string, unknown>>,
  columns: string[],
): Record<string, unknown> {
  const stored = results.get(index);
  if (!stored) {
    return buildRow({ status: StepStatus.NOT_EXECUTED, outcome: null, top: null }, columns);
  }
  const picked: Record<string, unknown> = {};
  for (const key of columns) picked[key] = stored[key] ?? null;

  if (columns.includes('form_label') && picked.form_label === null) {
    picked.form_label = formLabelVi(stored.form as string | null | undefined);
  }
  if (columns.includes('added') && picked.added === null) {
    const ds = stored.dataset as string | null | undefined;
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
      writer.write(
        row.values,
        columns.map((k) => (han[k] ?? null) as never),
      );
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
