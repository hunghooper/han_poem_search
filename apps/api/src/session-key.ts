import type { Redis } from 'ioredis';
import type { FastifyRequest } from 'fastify';
import { createOpenAiCompatibleProvider } from '@han/llm/adapters/openai-compatible';
import { withFailover } from '@han/llm/failover';
import type { LlmProvider } from '@han/llm/provider';
import type { PriceTable } from '@han/llm/pricing';

export const SESSION_KEY_HEADER = 'x-llm-api-key';

const TTL_SECONDS = 3600;

const redisKey = (runId: string): string => `runkey:${runId}`;

export function sessionKeyOf(request: FastifyRequest): string | null {
  const raw = request.headers[SESSION_KEY_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export async function stashSessionKey(
  redis: Redis | null,
  runId: string,
  key: string | null,
): Promise<void> {
  if (!redis || !key) return;
  await redis.set(redisKey(runId), key, 'EX', TTL_SECONDS).catch(() => undefined);
}

export async function dropSessionKey(redis: Redis | null, runId: string): Promise<void> {
  if (!redis) return;
  await redis.del(redisKey(runId)).catch(() => undefined);
}

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
