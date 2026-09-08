/**
 * Activities — everything the workflow is forbidden to do itself.
 *
 * §9.1: "Every side effect goes through an activity." Network, database, clock-dependent work
 * and model calls all live here. Activities may be retried, so each is written to be safe to
 * run more than once: none of them mutates shared state beyond appending to an append-only
 * log, which is keyed on (run_id, seq) and rejects duplicates.
 */

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

/**
 * Built once per worker process, not per activity: a fresh pool and model client per call
 * would spend more on connection setup than on the work.
 */
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
      process.env.PRICING_FILE ?? new URL('../../../../config/pricing.yaml', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1'),
    );
  } catch {
    // costUsd then reads null everywhere, which the trace reports rather than hides.
  }
  // Kept module-wide so a per-run provider built from a visitor's own key is priced the same
  // way the worker's own is.
  priceTableCache = priceTable;

  // See the API's initLlm: with this set the worker holds no usable key of its own, so the
  // agent only runs for a caller who supplied one.
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

/**
 * Beat for as long as `work` runs.
 *
 * A single heartbeat at the start would be worse than none: it advertises a heartbeat timeout
 * the activity then breaches while it is healthily waiting on a 110-second model call, and
 * Temporal cancels it. The point of heartbeating is the opposite — to distinguish "still
 * working" from "the worker is gone", which is the distinction a mid-run crash turns on.
 */
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

/** Comfortably inside the workflow's heartbeatTimeout, so one missed beat is not a failure. */
const HEARTBEAT_INTERVAL_MS = 5_000;

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

/**
 * The gateway key for this run, if the caller supplied their own.
 *
 * Read from Redis by run id rather than taken from the workflow input, and that is deliberate:
 * workflow history is persisted to Postgres and replayed for the life of the run, so a key
 * placed in the input would be a secret written into a durable log. The run id is already in
 * the input and is not a secret, so it is the whole of what crosses into Temporal.
 *
 * Null means "use the worker's own key", which is the ordinary single-operator case.
 */
async function sessionProviderFor(
  d: NonNullable<typeof deps>,
  runId: string | undefined,
): Promise<LlmProvider | null> {
  if (!runId || !d.redis) return null;
  const key = await d.redis.get(`runkey:${runId}`).catch(() => null);
  const baseURL = process.env.RAMCLOUDS_BASE_URL;
  if (!key || !baseURL) return null;

  // No failover: the fallback gateway is the operator's account, and quietly moving a
  // visitor's traffic onto it is the surprise this whole path exists to prevent.
  return withFailover({
    primary: createOpenAiCompatibleProvider({
      name: process.env.LLM_PRIMARY_PROVIDER ?? 'ramclouds',
      apiKey: key,
      baseURL,
      ...(priceTableCache ? { priceTable: priceTableCache } : {}),
    }),
  });
}

/** One reasoning turn. The activity owns the model call; the workflow owns what to do with it. */
export async function reason(req: {
  model: string | null;
  messages: Array<{ role: string; content: string | null; toolCalls?: unknown; toolCallId?: string }>;
  tools: Array<{ name: string; description: string; jsonSchema: Record<string, unknown> }>;
  maxTokens: number;
  /** Not the key — just the id the key is filed under. See sessionProviderFor. */
  runId?: string;
}): Promise<ReasonResult> {
  const d = await init();
  const model = req.model ?? d.reasoningModel;
  const session = await sessionProviderFor(d, req.runId);
  const provider = session ?? d.provider;
  if (!provider || !model) {
    // ApplicationFailure with an explicit `type`, not a plain Error: the workflow's
    // nonRetryableErrorTypes list matches on the failure TYPE, never on the message. Throwing
    // `new Error('CONFIG_INVALID: ...')` reads as if it were covered and is retried anyway —
    // three attempts against a gateway that is not configured, and then a report of
    // "budget exhausted" for what is a misconfiguration.
    throw ApplicationFailure.create({
      type: 'CONFIG_INVALID',
      message: 'no LLM gateway or reasoning model configured',
      nonRetryable: true,
    });
  }



  // The tool schemas arrive as plain JSON Schema; the adapter expects a Zod type carrying it,
  // so the shape is rebuilt here rather than shipping a Zod instance through workflow history.
  const tools: LlmToolDef[] = req.tools.map((t) => {
    const schema = z.object({}).passthrough();
    (schema as unknown as { _jsonSchema?: Record<string, unknown> })._jsonSchema = t.jsonSchema;
    return { name: t.name, description: t.description, parameters: schema };
  });

  // Heartbeat while the model thinks. Without it a crash mid-call is invisible to Temporal
  // until startToCloseTimeout expires, so a restarted worker sits idle for the remainder of
  // that window — long enough to spend the whole run budget doing nothing.
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

  const result = await beatingWhile(
    runTool(tool, req.args, {
      signal: AbortSignal.timeout(Math.min(tool.timeoutMs + 5_000, 115_000)),
      debug: req.debug,
      now: () => Date.now(),
    }),
  );

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
