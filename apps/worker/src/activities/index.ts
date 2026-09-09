import { ApplicationFailure, heartbeat } from '@temporalio/activity';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Redis } from 'ioredis';
import { createOpenAiCompatibleProvider } from '@han/llm/adapters/openai-compatible';
import { withFailover } from '@han/llm/failover';
import { loadPriceTable } from '@han/llm/pricing';
import type { LlmMessage, LlmProvider, LlmToolDef } from '@han/llm/provider';
import { ModelClient } from '@han/retrieval/model-client';
import { VectorStore } from '@han/retrieval/vector-store';
import { createTools } from '@han/agent/tools';
import { runTool, type Tool } from '@han/agent/tool';
import type { RuntimeConfig } from '@han/shared/runtime-config';
import { z } from 'zod';
import type { ReasonResult, ToolCallResult, WorkflowEvent } from '../shared.js';

let priceTableCache: ReturnType<typeof loadPriceTable> | undefined;

let deps: {
  db: ReturnType<typeof drizzle>;
  provider: LlmProvider | null;
  reasoningModel: string | null;
  answerModel: string | null;
  model: ModelClient | null;
  vectors: VectorStore | null;
  redis: Redis | null;
} | null = null;

async function init() {
  if (deps) return deps;

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
  const db = drizzle(pool);

  let priceTable;
  try {
    priceTable = loadPriceTable(
      process.env.PRICING_FILE ??
        new URL('../../../../config/pricing.yaml', import.meta.url).pathname.replace(
          /^\/([A-Za-z]:)/u,
          '$1',
        ),
    );
  } catch {}
  priceTableCache = priceTable;

  const bringYourOwnKey = process.env.LLM_REQUIRE_SESSION_KEY === 'true';
  const apiKey = bringYourOwnKey ? undefined : process.env.RAMCLOUDS_API_KEY;
  const baseURL = process.env.RAMCLOUDS_BASE_URL;
  const provider =
    apiKey && baseURL
      ? withFailover({
          primary: createOpenAiCompatibleProvider({
            name: process.env.LLM_PRIMARY_PROVIDER ?? 'ramclouds',
            apiKey,
            baseURL,
            ...(priceTable ? { priceTable } : {}),
          }),
        })
      : null;

  const modelClient = new ModelClient({
    baseUrl: process.env.MODEL_SERVICE_URL ?? 'http://localhost:8000',
    timeoutMs: 30_000,
  });
  let model: ModelClient | null = null;
  let vectors: VectorStore | null = null;
  try {
    await modelClient.health();
    model = modelClient;
    const vs = new VectorStore(
      process.env.QDRANT_URL ?? 'http://localhost:6333',
      process.env.QDRANT_COLLECTION_ALIAS ?? 'poetry',
    );
    if (await vs.readMeta()) vectors = vs;
  } catch {}

  const redisUrl = process.env.REDIS_URL;
  const redis = redisUrl ? new Redis(redisUrl) : null;

  deps = {
    db,
    provider,
    reasoningModel: process.env.LLM_MODEL_REASONING ?? null,
    answerModel: process.env.LLM_MODEL_ANSWER ?? null,
    model,
    vectors,
    redis,
  };
  return deps;
}

async function beatingWhile<T>(work: Promise<T>): Promise<T> {
  const timer = setInterval(() => {
    heartbeat();
  }, HEARTBEAT_INTERVAL_MS);
  try {
    return await work;
  } finally {
    clearInterval(timer);
  }
}

const HEARTBEAT_INTERVAL_MS = 5_000;

const toolsFor = (d: NonNullable<typeof deps>, config: RuntimeConfig): Array<Tool<never>> =>
  createTools({
    db: d.db as never,
    model: d.model,
    vectors: d.vectors,
    provider: d.provider,
    answerModel: config.models.answer ?? d.answerModel,
    web: {
      souyunEnabled: process.env.TOOL_SOUYUN_ENABLED === 'true',
      userAgent: process.env.TOOL_HTTP_USER_AGENT ?? 'han-search/0.1',
      timeoutMs: Number(process.env.TOOL_DEFAULT_TIMEOUT_MS ?? 15000),
      delayMs: Number(process.env.TOOL_SCRAPE_DELAY_MS ?? 2000),
      cacheTtlMs: Number(process.env.TOOL_CACHE_TTL_SECONDS ?? 3600) * 1000,
    },
  });

export async function listTools(
  config: RuntimeConfig,
): Promise<Array<{ name: string; description: string; jsonSchema: Record<string, unknown> }>> {
  const d = await init();
  return toolsFor(d, config)
    .filter((t) => !t.unavailableReason?.())
    .map((t) => ({ name: t.name, description: t.description, jsonSchema: t.jsonSchema }));
}

async function sessionProviderFor(
  d: NonNullable<typeof deps>,
  runId: string | undefined,
): Promise<LlmProvider | null> {
  if (!runId || !d.redis) return null;
  const key = await d.redis.get(`runkey:${runId}`).catch(() => null);
  const baseURL = process.env.RAMCLOUDS_BASE_URL;
  if (!key || !baseURL) return null;

  return withFailover({
    primary: createOpenAiCompatibleProvider({
      name: process.env.LLM_PRIMARY_PROVIDER ?? 'ramclouds',
      apiKey: key,
      baseURL,
      ...(priceTableCache ? { priceTable: priceTableCache } : {}),
    }),
  });
}

export async function reason(req: {
  model: string | null;
  messages: Array<{
    role: string;
    content: string | null;
    toolCalls?: unknown;
    toolCallId?: string;
  }>;
  tools: Array<{ name: string; description: string; jsonSchema: Record<string, unknown> }>;
  maxTokens: number;
  runId?: string;
}): Promise<ReasonResult> {
  const d = await init();
  const model = req.model ?? d.reasoningModel;
  const session = await sessionProviderFor(d, req.runId);
  const provider = session ?? d.provider;
  if (!provider || !model) {
    throw ApplicationFailure.create({
      type: 'CONFIG_INVALID',
      message: 'no LLM gateway or reasoning model configured',
      nonRetryable: true,
    });
  }

  const tools: LlmToolDef[] = req.tools.map((t) => {
    const schema = z.object({}).passthrough();
    (schema as unknown as { _jsonSchema?: Record<string, unknown> })._jsonSchema = t.jsonSchema;
    return { name: t.name, description: t.description, parameters: schema };
  });

  const res = await beatingWhile(
    provider.complete(
      {
        model,
        messages: req.messages as LlmMessage[],
        tools,
        toolChoice: 'auto',
        maxTokens: req.maxTokens,
      },
      AbortSignal.timeout(110_000),
    ),
  );

  return {
    text: res.text,
    toolCalls: res.toolCalls,
    provider: res.provider,
    model: res.model,
    costUsd: res.usage.costUsd,
    flags: res.flags,
    messages: [{ role: 'assistant', content: res.text, toolCalls: res.toolCalls }],
  };
}

export async function callTool(req: {
  tool: string;
  args: unknown;
  config: RuntimeConfig;
  debug: boolean;
}): Promise<ToolCallResult> {
  const d = await init();
  const tool = toolsFor(d, req.config).find((t) => t.name === req.tool);
  if (!tool) {
    return {
      toolName: req.tool,
      source: req.tool,
      status: 'error',
      resultCount: 0,
      results: [],
      latencyMs: 0,
      error: { code: 'NO_SUCH_TOOL', message: `no such tool: ${req.tool}` },
      costUsd: undefined,
    };
  }

  const result = await beatingWhile(
    runTool(tool, req.args, {
      signal: AbortSignal.timeout(Math.min(tool.timeoutMs + 5_000, 115_000)),
      debug: req.debug,
      now: () => Date.now(),
    }),
  );

  let costUsd: number | null | undefined;
  for (const e of result.results) {
    if (!('costUsd' in e.metadata)) continue;
    const c = e.metadata.costUsd;
    costUsd = typeof c === 'number' ? (costUsd ?? 0) + c : null;
    if (costUsd === null) break;
  }

  return {
    toolName: result.toolName,
    source: result.source,
    status: result.status,
    resultCount: result.resultCount,
    results: result.results,
    latencyMs: result.latencyMs,
    error: result.error,
    costUsd,
  };
}

export async function emitEvent(event: WorkflowEvent): Promise<void> {
  const d = await init();
  if (!d.redis) return;
  await d.redis.publish(`run:${event.runId}`, JSON.stringify(event));
}
