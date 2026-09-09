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
import { dropSessionKey, providerForKey, sessionKeyOf, stashSessionKey } from './session-key.js';
import { PostgresEventSink, loadRun } from './event-sink.js';
import { loadRuntimeConfig } from '@han/config/runtime';
import { applyOverrides, OverridesSchema, type RuntimeConfig } from '@han/shared/runtime-config';
import { RunStore } from './events.js';
import { runSearch } from './search.js';
import { registerBatchRoutes, sweepOrphanFiles } from './batch.js';
import { registerCorpusRoutes } from './corpus.js';
import { flagInterrupted } from './batch-runner.js';

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
const store = new RunStore(
  new PostgresEventSink(db, (err, what) => app.log.error({ err, what }, 'event log write failed')),
);

const MODEL_SERVICE_URL = process.env.MODEL_SERVICE_URL ?? 'http://localhost:8000';
const QDRANT_URL = process.env.QDRANT_URL ?? 'http://localhost:6333';
const QDRANT_ALIAS = process.env.QDRANT_COLLECTION_ALIAS ?? 'poetry';

async function initSemanticLayer(): Promise<{
  model: ModelClient | null;
  vectors: VectorStore | null;
}> {
  const model = new ModelClient({ baseUrl: MODEL_SERVICE_URL, timeoutMs: 30000 });
  let health;
  try {
    health = await model.health();
  } catch (e) {
    app.log.warn(
      { err: e },
      'model service unreachable — semantic search disabled, exact matching unaffected',
    );
    return { model: null, vectors: null };
  }

  const vectors = new VectorStore(QDRANT_URL, QDRANT_ALIAS, process.env.QDRANT_API_KEY);
  const meta = await vectors.readMeta();
  if (!meta) {
    app.log.warn(
      'no vector collection behind the alias — semantic search disabled until ingest runs',
    );
    return { model, vectors: null };
  }

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
  limits: { fileSize: 128 * 1024 * 1024, files: 1 },
});

let sharedPriceTable: ReturnType<typeof loadPriceTable> | undefined;

function initLlm(): {
  provider: LlmProvider | null;
  reasoningModel: string | null;
  answerModel: string | null;
} {
  const bringYourOwnKey = process.env.LLM_REQUIRE_SESSION_KEY === 'true';
  const apiKey = bringYourOwnKey ? undefined : process.env.RAMCLOUDS_API_KEY;
  const baseURL = process.env.RAMCLOUDS_BASE_URL;
  const reasoningModel = process.env.LLM_MODEL_REASONING ?? null;
  const answerModel = process.env.LLM_MODEL_ANSWER ?? reasoningModel;
  let priceTable;
  try {
    priceTable = loadPriceTable(
      process.env.PRICING_FILE ??
        fileURLToPath(new URL('../../../config/pricing.yaml', import.meta.url)),
    );
  } catch (e) {
    app.log.warn({ err: e }, 'pricing table unreadable — costUsd will be null on every call');
  }
  sharedPriceTable = priceTable;

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
      ? createOpenAiCompatibleProvider({
          name: fbName,
          apiKey: fbKey,
          baseURL: fbUrl,
          ...(priceTable ? { priceTable } : {}),
        })
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
const WEB_TOOLS = {
  souyunEnabled: process.env.TOOL_SOUYUN_ENABLED === 'true',
  userAgent: process.env.TOOL_HTTP_USER_AGENT ?? 'han-search/0.1',
  timeoutMs: Number(process.env.TOOL_DEFAULT_TIMEOUT_MS ?? 15000),
  delayMs: Number(process.env.TOOL_SCRAPE_DELAY_MS ?? 2000),
  cacheTtlMs: Number(process.env.TOOL_CACHE_TTL_SECONDS ?? 3600) * 1000,
} as const;

const deps = {
  db,
  ...semantic,
  provider: llm.provider,
  reasoningModel: llm.reasoningModel,
  verifyModel: process.env.LLM_MODEL_VERIFY ?? llm.answerModel,
  makeTools: (config: RuntimeConfig) =>
    createTools({
      db,
      model: semantic.model,
      vectors: semantic.vectors,
      provider: llm.provider,
      answerModel: config.models.answer ?? llm.answerModel,
      web: WEB_TOOLS,
    }),
  bridge: new AgentEventBridge(process.env.REDIS_URL, store, (err) =>
    app.log.error({ err }, 'agent event relay failed'),
  ),
  debug: process.env.DEBUG_MODE_ENABLED === 'true',
};

const keyStore: Redis | null = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;

const makeToolsWith = (provider: LlmProvider) => (config: RuntimeConfig) =>
  createTools({
    db,
    model: semantic.model,
    vectors: semantic.vectors,
    provider,
    answerModel: config.models.answer ?? llm.answerModel,
    web: WEB_TOOLS,
  });

const baseConfig: RuntimeConfig = loadRuntimeConfig();

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
    availableModels = (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => Boolean(id))
      .sort();
  } catch (e) {
    app.log.warn(
      { err: e },
      'could not list gateway models — the settings panel will accept free text',
    );
  }
}
void loadAvailableModels();

const SearchBody = z.object({
  query: z.string().min(1).max(2000),
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
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`);
    return reply.code(400).send({ error: 'invalid request', issues });
  }

  const runId = store.create(parsed.data.query);
  const config = applyOverrides(baseConfig, parsed.data.overrides);

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
            web: WEB_TOOLS,
          }),
      }
    : { ...deps, config };

  void runSearch(runDeps, store, runId, parsed.data.query)
    .catch((e: unknown) => {
      app.log.error({ err: e, runId }, 'search run failed');
    })
    .finally(() => {
      void dropSessionKey(keyStore, runId);
    });
  return reply.code(202).send(encode({ runId }));
});

app.get('/api/config', async (_req, reply) => {
  return reply.send(
    encode({
      config: baseConfig,
      availableModels,
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
  const loaded = await loadRun(db, runId);
  if (!loaded) return reply.code(404).send({ error: 'run not found' });
  return reply.send(encode({ state: fold(loaded.events), events: loaded.events }));
});

app.get('/api/runs/:runId/results', async (req, reply) => {
  const { runId } = req.params as { runId: string };
  let outcome = store.outcome(runId) as {
    evidence?: unknown[];
    colophon?: unknown;
    verification?: unknown;
  } | null;
  if (!outcome) {
    const loaded = await loadRun(db, runId);
    outcome = (loaded?.outcome ?? null) as typeof outcome;
  }
  if (!outcome) return reply.code(404).send({ error: 'run not found' });
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

    const backlog = store.since(runId, lastSeq);
    unsubscribe = store.subscribe(runId, (e) => send(e));
    for (const e of backlog) send(e);
  });

  socket.on('close', () => unsubscribe?.());
});

const BATCH_DIR =
  process.env.BATCH_DIR ?? fileURLToPath(new URL('../../../local/batch', import.meta.url));
registerBatchRoutes(
  app,
  { ...deps, store, config: baseConfig, makeToolsWith, keyStore },
  BATCH_DIR,
);
registerCorpusRoutes(app, db);

await app.listen({ port: PORT, host: HOST });

const interrupted = await flagInterrupted({
  ...deps,
  store,
  config: baseConfig,
  makeToolsWith,
  keyStore,
});
if (interrupted.length > 0) {
  app.log.warn({ jobs: interrupted }, 'batch jobs were interrupted; they are waiting for a re-run');
}

const swept = await sweepOrphanFiles(
  { ...deps, store, config: baseConfig, makeToolsWith, keyStore },
  BATCH_DIR,
);
if (swept.files > 0) app.log.info(swept, 'swept orphaned batch files');
