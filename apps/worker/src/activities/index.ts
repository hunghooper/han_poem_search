/**
 * Activities — everything the workflow is forbidden to do itself.
 *
 * §9.1: "Every side effect goes through an activity." Network, database, clock-dependent work
 * and model calls all live here. Activities may be retried, so each is written to be safe to
 * run more than once: none of them mutates shared state beyond appending to an append-only
 * log, which is keyed on (run_id, seq) and rejects duplicates.
 */

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

/**
 * Built once per worker process, not per activity: a fresh pool and model client per call
 * would spend more on connection setup than on the work.
 */
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
      process.env.PRICING_FILE ?? new URL('../../../../config/pricing.yaml', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1'),
    );
  } catch {
    // costUsd then reads null everywhere, which the trace reports rather than hides.
  }

  const apiKey = process.env.RAMCLOUDS_API_KEY;
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
  } catch {
    // Semantic tools then report UNAVAILABLE, which is different from finding nothing.
  }

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

const toolsFor = (d: NonNullable<typeof deps>, config: RuntimeConfig): Array<Tool<never>> =>
  createTools({
    db: d.db as never,
    model: d.model,
    vectors: d.vectors,
    provider: d.provider,
    answerModel: config.models.answer ?? d.answerModel,
  });

/** Tool descriptions the model can choose between. Data only — no live objects cross back. */
export async function listTools(
  config: RuntimeConfig,
): Promise<Array<{ name: string; description: string; jsonSchema: Record<string, unknown> }>> {
  const d = await init();
  return toolsFor(d, config)
    .filter((t) => !t.unavailableReason?.())
    .map((t) => ({ name: t.name, description: t.description, jsonSchema: t.jsonSchema }));
}

/** One reasoning turn. The activity owns the model call; the workflow owns what to do with it. */
export async function reason(req: {
  model: string | null;
  messages: Array<{ role: string; content: string | null; toolCalls?: unknown; toolCallId?: string }>;
  tools: Array<{ name: string; description: string; jsonSchema: Record<string, unknown> }>;
  maxTokens: number;
}): Promise<ReasonResult> {
  const d = await init();
  const model = req.model ?? d.reasoningModel;
  if (!d.provider || !model) {
    throw new Error('CONFIG_INVALID: no LLM gateway or reasoning model configured');
  }

  // The tool schemas arrive as plain JSON Schema; the adapter expects a Zod type carrying it,
  // so the shape is rebuilt here rather than shipping a Zod instance through workflow history.
  const tools: LlmToolDef[] = req.tools.map((t) => {
    const schema = z.object({}).passthrough();
    (schema as unknown as { _jsonSchema?: Record<string, unknown> })._jsonSchema = t.jsonSchema;
    return { name: t.name, description: t.description, parameters: schema };
  });

  const res = await d.provider.complete(
    {
      model,
      messages: req.messages as LlmMessage[],
      tools,
      toolChoice: 'auto',
      maxTokens: req.maxTokens,
    },
    AbortSignal.timeout(110_000),
  );

  return {
    text: res.text,
    toolCalls: res.toolCalls,
    provider: res.provider,
    model: res.model,
    costUsd: res.usage.costUsd,
    flags: res.flags,
    // The assistant turn, serialised, so the workflow can build the next request without
    // holding anything the sandbox forbids.
    messages: [{ role: 'assistant', content: res.text, toolCalls: res.toolCalls }],
  };
}

/** Run one tool. Never throws: it classifies, exactly as §5.4 requires. */
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

  const result = await runTool(tool, req.args, {
    signal: AbortSignal.timeout(Math.min(tool.timeoutMs + 5_000, 115_000)),
    debug: req.debug,
    now: () => Date.now(),
  });

  // What the tool spent, if it called a model at all. undefined: no model call. null: unpriced.
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

/**
 * Publish one event so the API can stream it.
 *
 * The worker is a different process from the API, so the WebSocket subscribers are not
 * reachable directly — §14.1 calls for Redis fan-out, and this is it. Publishing is
 * best-effort: a run whose events cannot be streamed is still a run worth finishing, and the
 * durable copy is written by the API when it receives them.
 */
export async function emitEvent(event: WorkflowEvent): Promise<void> {
  const d = await init();
  if (!d.redis) return;
  await d.redis.publish(`run:${event.runId}`, JSON.stringify(event));
}
