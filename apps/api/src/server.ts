/**
 * Fastify API — the spec §14.1.
 *
 *   POST /api/search            start a run, return runId immediately
 *   GET  /api/runs/:runId       the folded state, for a client that missed the stream
 *   WS   /api/runs/:runId/stream  client sends { lastSeq }, server replays then streams live
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { encode } from '@han/shared/serde';
import { fold } from '@han/shared/state';
import { ModelClient } from '@han/retrieval/model-client';
import { VectorStore, assertModelMatch } from '@han/retrieval/vector-store';
import { createTools } from '@han/agent/tools';
import { createOpenAiCompatibleProvider } from '@han/llm/adapters/openai-compatible';
import { withFailover } from '@han/llm/failover';
import { loadPriceTable } from '@han/llm/pricing';
import type { LlmProvider } from '@han/llm/provider';
import { Redis } from 'ioredis';
import { AgentEventBridge } from './agent-bridge.js';
import {
  dropSessionKey,
  providerForKey,
  sessionKeyOf,
  stashSessionKey,
} from './session-key.js';
import { PostgresEventSink, loadRun } from './event-sink.js';
import { loadRuntimeConfig } from '@han/config/runtime';
import { applyOverrides, OverridesSchema, type RuntimeConfig } from '@han/shared/runtime-config';
import { RunStore } from './events.js';
import { runSearch } from './search.js';
import { registerBatchRoutes, sweepOrphanFiles } from './batch.js';
import { resumeInterrupted } from './batch-runner.js';

/**
 * Same reasoning as the worker's loadRootEnv: the process must be able to start correctly on
 * its own, not only from the one shell that has the variables exported. Existing values win.
 */
const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const PORT = Number(process.env.API_PORT ?? 3001);
const HOST = process.env.API_HOST ?? '0.0.0.0';
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set — refusing to start');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
const db = drizzle(pool);
// The event log outlives the process (§11). A write failure is logged loudly rather than
// swallowed — a silently short log is the opaque failure §1 forbids.
const store = new RunStore(
  new PostgresEventSink(db, (err, what) => app.log.error({ err, what }, 'event log write failed')),
);

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
await app.register(multipart, {
  // A 200,000-row workbook measured 20.9 MB, so 128 MB is generous for the stated scale while
  // still refusing an upload that would be a mistake rather than a batch.
  limits: { fileSize: 128 * 1024 * 1024, files: 1 },
});

/**
 * The LLM provider, or null. Null is a supported state: exact matching and the semantic layer
 * work without it, and the agent step then reports UNAVAILABLE rather than being invisible.
 */
let sharedPriceTable: ReturnType<typeof loadPriceTable> | undefined;

function initLlm(): { provider: LlmProvider | null; reasoningModel: string | null; answerModel: string | null } {
  // An explicit opt-out for a shared deployment: the server holds no usable key, so every
  // model call must bring its own and nothing can quietly bill the operator. Relying on an
  // unset variable would be fragile — the process loads the repo `.env` itself.
  const bringYourOwnKey = process.env.LLM_REQUIRE_SESSION_KEY === 'true';
  const apiKey = bringYourOwnKey ? undefined : process.env.RAMCLOUDS_API_KEY;
  const baseURL = process.env.RAMCLOUDS_BASE_URL;
  const reasoningModel = process.env.LLM_MODEL_REASONING ?? null;
  const answerModel = process.env.LLM_MODEL_ANSWER ?? reasoningModel;
  let priceTable;
  try {
    // Resolved from THIS module, not from cwd. The API is started via `pnpm --filter`, whose
    // cwd is apps/api, so a cwd-relative path silently never finds the file — and costUsd then
    // reads as null for a reason that has nothing to do with the models being unpriced.
    priceTable = loadPriceTable(
      process.env.PRICING_FILE ?? fileURLToPath(new URL('../../../config/pricing.yaml', import.meta.url)),
    );
  } catch (e) {
    // An unreadable pricing file must not silently disable cost accounting.
    app.log.warn({ err: e }, 'pricing table unreadable — costUsd will be null on every call');
  }
  sharedPriceTable = priceTable;

  // No server key is a supported state, not a failure: a visitor supplying their own key
  // still gets a priced run, and everything that does not need a model still works.
  if (!apiKey || !baseURL) {
    app.log.warn('no server LLM key — model features need a key supplied per request');
    return { provider: null, reasoningModel, answerModel };
  }

  const primary = createOpenAiCompatibleProvider({
    name: process.env.LLM_PRIMARY_PROVIDER ?? 'ramclouds',
    apiKey,
    baseURL,
    ...(priceTable ? { priceTable } : {}),
  });

  const fbKey = process.env.FALLBACK_API_KEY;
  const fbUrl = process.env.FALLBACK_BASE_URL;
  const fbName = process.env.LLM_FALLBACK_PROVIDER;
  const fallback =
    fbName && fbKey && fbUrl
      ? createOpenAiCompatibleProvider({ name: fbName, apiKey: fbKey, baseURL: fbUrl, ...(priceTable ? { priceTable } : {}) })
      : null;

  return {
    provider: withFailover({
      primary,
      fallback,
      onFailover: (i) => app.log.warn(i, 'llm_failover'),
    }),
    reasoningModel,
    answerModel,
  };
}

const llm = initLlm();
const semantic = await initSemanticLayer();
const deps = {
  db,
  ...semantic,
  provider: llm.provider,
  reasoningModel: llm.reasoningModel,
  makeTools: (config: RuntimeConfig) =>
    createTools({
      db,
      model: semantic.model,
      vectors: semantic.vectors,
      provider: llm.provider,
      // A session override wins; otherwise the environment's model.
      answerModel: config.models.answer ?? llm.answerModel,
    }),
  bridge: new AgentEventBridge(process.env.REDIS_URL, store, (err) =>
    app.log.error({ err }, 'agent event relay failed'),
  ),
  debug: process.env.DEBUG_MODE_ENABLED === 'true',
};

/**
 * A second connection, because the bridge's is a SUBSCRIBER — a Redis client in subscriber
 * mode refuses ordinary commands, so reusing it here would fail on every set.
 */
const keyStore: Redis | null = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;

/** The tool set rebuilt against another provider — for a batch running on a visitor's key. */
const makeToolsWith = (provider: LlmProvider) => (config: RuntimeConfig) =>
  createTools({
    db,
    model: semantic.model,
    vectors: semantic.vectors,
    provider,
    answerModel: config.models.answer ?? llm.answerModel,
  });

/** Committed defaults. Session overrides are applied per request and never written back. */
const baseConfig: RuntimeConfig = loadRuntimeConfig();

/**
 * Model ids the gateway actually serves, so the settings panel can offer a list without the
 * schema ever hardcoding one (§4.1 rule 5: model names are gateway-specific opaque strings).
 * Best-effort — a gateway that will not list its models is not a reason to refuse to start.
 */
let availableModels: string[] = [];
async function loadAvailableModels(): Promise<void> {
  const apiKey = process.env.RAMCLOUDS_API_KEY;
  const baseURL = process.env.RAMCLOUDS_BASE_URL;
  if (!apiKey || !baseURL) return;
  try {
    const res = await fetch(`${baseURL.replace(/\/+$/, '')}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    availableModels = (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id)).sort();
  } catch (e) {
    app.log.warn({ err: e }, 'could not list gateway models — the settings panel will accept free text');
  }
}
void loadAvailableModels();

const SearchBody = z.object({
  query: z.string().min(1).max(2000),
  /** Session overrides from the settings panel. Untrusted: bounded and .strict() by schema. */
  overrides: OverridesSchema.optional(),
});
const HelloFrame = z.object({ lastSeq: z.number().int().min(-1).default(-1) });

app.get('/health', async () => {
  const r = await pool.query('SELECT count(*)::int AS n FROM poem');
  return {
    ok: true,
    poems: r.rows[0]?.n ?? 0,
    phase: 3,
    semantic: deps.vectors !== null,
    reranker: deps.model !== null,
    agent: deps.provider !== null && deps.reasoningModel !== null,
    durableAgent: true,
    liveTrace: deps.bridge.available,
    reasoningModel: deps.reasoningModel,
    tools: deps
      .makeTools(baseConfig)
      .filter((t) => !t.unavailableReason?.())
      .map((t) => t.name),
  };
});

app.post('/api/search', async (req, reply) => {
  const parsed = SearchBody.safeParse(req.body);
  if (!parsed.success) {
    // Name the field and the rule. "query is required" on an out-of-range threshold sends the
    // reader looking in entirely the wrong place.
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`);
    return reply.code(400).send({ error: 'invalid request', issues });
  }

  const runId = store.create(parsed.data.query);
  const config = applyOverrides(baseConfig, parsed.data.overrides);

  // A key supplied by whoever is using the app bills THEM, not the server operator. It comes
  // from a header rather than the body so it never appears in a validation error or a request
  // log, and it reaches the agent through Redis rather than through workflow history.
  const sessionKey = sessionKeyOf(req);
  const baseURL = process.env.RAMCLOUDS_BASE_URL;
  const sessionProvider =
    sessionKey && baseURL ? providerForKey(sessionKey, baseURL, sharedPriceTable) : null;

  if (sessionKey) await stashSessionKey(keyStore, runId, sessionKey);

  const runDeps = sessionProvider
    ? {
        ...deps,
        config,
        provider: sessionProvider,
        makeTools: (c: RuntimeConfig) =>
          createTools({
            db,
            model: semantic.model,
            vectors: semantic.vectors,
            provider: sessionProvider,
            answerModel: c.models.answer ?? llm.answerModel,
          }),
      }
    : { ...deps, config };

  // Return immediately so the client can attach to the stream before work begins; the run is
  // then observable from its first event rather than only from its result.
  // runSearch settles the outcome into the store itself, before it emits final_answer.
  void runSearch(runDeps, store, runId, parsed.data.query)
    .catch((e: unknown) => {
      app.log.error({ err: e, runId }, 'search run failed');
    })
    .finally(() => {
      // Gone as soon as the run is over, rather than sitting out the hour-long expiry.
      void dropSessionKey(keyStore, runId);
    });
  return reply.code(202).send(encode({ runId }));
});

/**
 * What is configurable, what it currently is, and what the gateway can serve.
 *
 * The UI reads this rather than shipping its own copy of the defaults — one definition, in
 * packages/shared, that both sides speak.
 */
app.get('/api/config', async (_req, reply) => {
  return reply.send(
    encode({
      config: baseConfig,
      availableModels,
      // Named so the panel can say plainly that changing a threshold affects this browser only.
      overridesArePerSession: true,
      envModels: {
        reasoning: process.env.LLM_MODEL_REASONING ?? null,
        answer: process.env.LLM_MODEL_ANSWER ?? null,
        verify: process.env.LLM_MODEL_VERIFY ?? null,
        rewrite: process.env.LLM_MODEL_REWRITE ?? null,
      },
    }),
  );
});

app.get('/api/runs/:runId', async (req, reply) => {
  const { runId } = req.params as { runId: string };
  if (store.has(runId)) {
    const events = store.since(runId, -1);
    return reply.send(encode({ state: fold(events), events }));
  }
  // Not in memory: either an older run or one served by a process that has since restarted.
  // The log is authoritative (§11), so read it back rather than reporting the run as missing.
  const loaded = await loadRun(db, runId);
  if (!loaded) return reply.code(404).send({ error: 'run not found' });
  return reply.send(encode({ state: fold(loaded.events), events: loaded.events }));
});

app.get('/api/runs/:runId/results', async (req, reply) => {
  const { runId } = req.params as { runId: string };
  // No in-memory guard: a run served by a previous process is still a real run, and the log
  // is authoritative (§11). The 404 comes from the log having nothing, not from memory.
  let outcome = store.outcome(runId) as
    | { evidence?: unknown[]; colophon?: unknown; verification?: unknown }
    | null;
  if (!outcome) {
    const loaded = await loadRun(db, runId);
    outcome = (loaded?.outcome ?? null) as typeof outcome;
  }
  if (!outcome) return reply.code(404).send({ error: "run not found" });
  return reply.send(
    encode({
      results: outcome.evidence ?? [],
      colophon: outcome.colophon ?? null,
      verification: outcome.verification ?? null,
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

const BATCH_DIR = process.env.BATCH_DIR ?? fileURLToPath(new URL('../../../.data/batch', import.meta.url));
registerBatchRoutes(app, { ...deps, store, config: baseConfig, makeToolsWith, keyStore }, BATCH_DIR);

await app.listen({ port: PORT, host: HOST });

// A batch interrupted by a restart resumes from the highest row already written. Without
// this it would sit at `running` forever, showing a progress bar nobody is advancing.
const resumed = await resumeInterrupted({ ...deps, store, config: baseConfig, makeToolsWith, keyStore });
if (resumed.length > 0) app.log.info({ jobs: resumed }, 'resumed interrupted batch jobs');

// After the resume, so a job about to be picked up still owns its file when the sweep runs.
const swept = await sweepOrphanFiles({ ...deps, store, config: baseConfig, makeToolsWith, keyStore }, BATCH_DIR);
if (swept.files > 0) app.log.info(swept, 'swept orphaned batch files');
