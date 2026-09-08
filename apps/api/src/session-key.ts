/**
 * A gateway key supplied per request, by whoever is using the app.
 *
 * WHY THIS EXISTS. The deployment this was written for is a temporary shared link: the person
 * opening it is not the person running the server, and the server's own key must not pay for
 * their searches. So the key arrives with the request, is used for that run, and is never
 * written to the project's configuration.
 *
 * WHERE IT MUST NOT GO, and this is the whole design:
 *
 *   - NOT into `OverridesSchema`. That schema is echoed back by `GET /api/config` and is meant
 *     for thresholds a user can share in a screenshot. A secret does not belong in it.
 *   - NOT into the request BODY, which is what error handlers and request logs quote back.
 *     It travels in a header instead.
 *   - NOT into the Temporal workflow input. Workflow history is persisted to Postgres and
 *     replayed for the life of the run, so a key placed there is a secret written into a
 *     durable log that outlives the session that supplied it. The agent needs the key, so it
 *     is handed over out of band: stored in Redis under the run id with a short expiry, read
 *     once by the activity that calls the model, and gone within the hour.
 *   - NOT into the event log, the run record, or any error message.
 *
 * The run id is already in the workflow input and is not a secret, so it is the whole of what
 * crosses into Temporal.
 */

import type { Redis } from 'ioredis';
import type { FastifyRequest } from 'fastify';
import { createOpenAiCompatibleProvider } from '@han/llm/adapters/openai-compatible';
import { withFailover } from '@han/llm/failover';
import type { LlmProvider } from '@han/llm/provider';
import type { PriceTable } from '@han/llm/pricing';

/** Lower-case: Node normalises incoming header names, and a mismatch here fails silently. */
export const SESSION_KEY_HEADER = 'x-llm-api-key';

/**
 * Long enough for a multi-minute agent run and its retries, short enough that a key does not
 * outlive the visit that supplied it. The agent's own wall-clock budget is far below this.
 */
const TTL_SECONDS = 3600;

const redisKey = (runId: string): string => `runkey:${runId}`;

/** The key this request brought, if any. Absent is normal and means "use the server's own". */
export function sessionKeyOf(request: FastifyRequest): string | null {
  const raw = request.headers[SESSION_KEY_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/**
 * Hand the key to the worker without putting it in workflow history.
 *
 * Best-effort: with no Redis the agent simply runs without a session key and reports what it
 * has, which is the honest degradation. Failing the whole search because a side channel is
 * unavailable would be worse.
 */
export async function stashSessionKey(
  redis: Redis | null,
  runId: string,
  key: string | null,
): Promise<void> {
  if (!redis || !key) return;
  await redis.set(redisKey(runId), key, 'EX', TTL_SECONDS).catch(() => undefined);
}

/** Drop it as soon as the run is done rather than waiting out the expiry. */
export async function dropSessionKey(redis: Redis | null, runId: string): Promise<void> {
  if (!redis) return;
  await redis.del(redisKey(runId)).catch(() => undefined);
}

/**
 * A provider that bills the caller's key instead of the server's.
 *
 * No failover: the fallback gateway is the server operator's account, and quietly moving a
 * visitor's traffic onto it is exactly the surprise this whole module exists to prevent.
 */
export function providerForKey(
  key: string,
  baseURL: string,
  priceTable: PriceTable | undefined,
): LlmProvider {
  return withFailover({
    primary: createOpenAiCompatibleProvider({
      name: process.env.LLM_PRIMARY_PROVIDER ?? 'ramclouds',
      apiKey: key,
      baseURL,
      ...(priceTable ? { priceTable } : {}),
    }),
  });
}
