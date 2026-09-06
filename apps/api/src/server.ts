/**
 * Fastify API — the spec §14.1.
 *
 *   POST /api/search            start a run, return runId immediately
 *   GET  /api/runs/:runId       the folded state, for a client that missed the stream
 *   WS   /api/runs/:runId/stream  client sends { lastSeq }, server replays then streams live
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { encode } from '@han/shared/serde';
import { fold } from '@han/shared/state';
import { ModelClient } from '@han/retrieval/model-client';
import { VectorStore, assertModelMatch } from '@han/retrieval/vector-store';
import { RunStore } from './events.js';
import { runSearch } from './search.js';

const PORT = Number(process.env.API_PORT ?? 3001);
const HOST = process.env.API_HOST ?? '0.0.0.0';
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set — refusing to start');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
const db = drizzle(pool);
const store = new RunStore();

const MODEL_SERVICE_URL = process.env.MODEL_SERVICE_URL ?? 'http://localhost:8000';
const QDRANT_URL = process.env.QDRANT_URL ?? 'http://localhost:6333';
const QDRANT_ALIAS = process.env.QDRANT_COLLECTION_ALIAS ?? 'poetry';

/**
 * The semantic layer is OPTIONAL and its absence is reported, never hidden.
 *
 * If the sidecar or the collection is missing, exact matching still works and every query says
 * so in the trace. What is NOT permitted is starting with a collection built by a different
 * embedding model than the sidecar serves (§2.1): that returns confident, wrong neighbours
 * with no error anywhere, so it is a hard refusal to boot.
 */
async function initSemanticLayer(): Promise<{ model: ModelClient | null; vectors: VectorStore | null }> {
  const model = new ModelClient({ baseUrl: MODEL_SERVICE_URL, timeoutMs: 30000 });
  let health;
  try {
    health = await model.health();
  } catch (e) {
    app.log.warn({ err: e }, 'model service unreachable — semantic search disabled, exact matching unaffected');
    return { model: null, vectors: null };
  }

  const vectors = new VectorStore(QDRANT_URL, QDRANT_ALIAS, process.env.QDRANT_API_KEY);
  const meta = await vectors.readMeta();
  if (!meta) {
    app.log.warn('no vector collection behind the alias — semantic search disabled until ingest runs');
    return { model, vectors: null };
  }

  // Throws on mismatch. Do not soften this into a warning.
  assertModelMatch(meta, {
    modelId: health.modelId,
    dim: health.dim,
    normalized: health.normalized,
    openccConfig: health.openccConfig,
  });
  app.log.info(
    { modelId: meta.modelId, points: meta.pointCount, corpus: meta.corpusCommitSha.slice(0, 8) },
    'semantic layer ready',
  );
  return { model, vectors };
}

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
await app.register(cors, { origin: true });
await app.register(websocket);

const deps = await initSemanticLayer().then((d) => ({ db, ...d }));

const SearchBody = z.object({ query: z.string().min(1).max(2000) });
const HelloFrame = z.object({ lastSeq: z.number().int().min(-1).default(-1) });

app.get('/health', async () => {
  const r = await pool.query('SELECT count(*)::int AS n FROM poem');
  return {
    ok: true,
    poems: r.rows[0]?.n ?? 0,
    phase: 2,
    semantic: deps.vectors !== null,
    reranker: deps.model !== null,
  };
});

app.post('/api/search', async (req, reply) => {
  const parsed = SearchBody.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'query is required' });

  const runId = store.create();
  // Return immediately so the client can attach to the stream before work begins; the run is
  // then observable from its first event rather than only from its result.
  // runSearch settles the outcome into the store itself, before it emits final_answer.
  void runSearch(deps, store, runId, parsed.data.query).catch((e: unknown) => {
    app.log.error({ err: e, runId }, 'search run failed');
  });
  return reply.code(202).send(encode({ runId }));
});

app.get('/api/runs/:runId', async (req, reply) => {
  const { runId } = req.params as { runId: string };
  if (!store.has(runId)) return reply.code(404).send({ error: 'run not found' });
  const events = store.since(runId, -1);
  return reply.send(encode({ state: fold(events), events }));
});

app.get('/api/runs/:runId/results', async (req, reply) => {
  const { runId } = req.params as { runId: string };
  if (!store.has(runId)) return reply.code(404).send({ error: 'run not found' });
  const outcome = store.outcome(runId) as
    | { evidence?: unknown[]; colophon?: unknown; verification?: unknown }
    | null;
  return reply.send(
    encode({
      results: outcome?.evidence ?? [],
      colophon: outcome?.colophon ?? null,
      verification: outcome?.verification ?? null,
    }),
  );
});

app.get('/api/runs/:runId/stream', { websocket: true }, (socket, req) => {
  const { runId } = req.params as { runId: string };
  if (!store.has(runId)) {
    socket.send(JSON.stringify({ error: 'run not found' }));
    socket.close();
    return;
  }

  let unsubscribe: (() => void) | null = null;
  const send = (payload: unknown) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(encode(payload)));
  };

  socket.on('message', (raw: Buffer) => {
    if (unsubscribe) return; // already attached; a second hello is a client bug, not a reset
    let lastSeq = -1;
    try {
      lastSeq = HelloFrame.parse(JSON.parse(raw.toString())).lastSeq;
    } catch {
      lastSeq = -1; // a malformed hello replays everything rather than dropping the client
    }

    // Replay first, then attach. Doing it in this order is what makes reconnect lossless:
    // events emitted between the replay and the subscribe would otherwise fall in the gap.
    // The reducer is idempotent by seq, so an overlap here is harmless and a gap is not.
    const backlog = store.since(runId, lastSeq);
    unsubscribe = store.subscribe(runId, (e) => send(e));
    for (const e of backlog) send(e);
  });

  socket.on('close', () => unsubscribe?.());
});

await app.listen({ port: PORT, host: HOST });
