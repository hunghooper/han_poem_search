/**
 * Environment parsing — the spec §4.4.
 *
 * Parsed and validated ONCE, at boot. The process exits with a readable message if anything
 * required is missing. Never `process.env.FOO!` scattered through the codebase.
 */

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const port = z.coerce.number().int().positive();
const ms = z.coerce.number().int().nonnegative();

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

  API_PORT: port.default(3001),
  API_HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  QDRANT_URL: z.string().url().default('http://localhost:6333'),
  QDRANT_API_KEY: z.string().optional(),
  QDRANT_COLLECTION_ALIAS: z.string().default('poetry'),

  MODEL_SERVICE_URL: z.string().url().default('http://localhost:8000'),
  MODEL_SERVICE_TIMEOUT_MS: ms.default(15000),
  EMBEDDING_MODEL_ID: z.string().default('BAAI/bge-m3'),
  RERANKER_MODEL_ID: z.string().default('BAAI/bge-reranker-v2-m3'),

  CORPUS_REPO_URL: z.string().url().default('https://github.com/chinese-poetry/chinese-poetry'),
  /**
   * Pinned deliberately. Provenance on every local result references this SHA (§3.1 item 4),
   * and an unpinned corpus makes a retrieval regression impossible to attribute.
   */
  CORPUS_COMMIT_SHA: z.string().min(7),
  CORPUS_DATA_DIR: z.string().default('./data/chinese-poetry'),
  CORPUS_COLLECTIONS: z
    .string()
    .default('全唐詩,宋詞')
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),

  LLM_PRIMARY_PROVIDER: z.string().default('ramclouds'),
  RAMCLOUDS_API_KEY: z.string().optional(),
  RAMCLOUDS_BASE_URL: z.string().url().optional(),
  LLM_FALLBACK_PROVIDER: z.string().optional(),
  LLM_MODEL_REASONING: z.string().optional(),
  LLM_MODEL_REWRITE: z.string().optional(),
  LLM_MODEL_ANSWER: z.string().optional(),
  LLM_MODEL_VERIFY: z.string().optional(),
  LLM_TIMEOUT_MS: ms.default(30000),

  AGENT_MAX_ITERATIONS: z.coerce.number().int().positive().default(6),
  AGENT_MAX_TOOL_CALLS: z.coerce.number().int().positive().default(12),
  AGENT_MAX_WALL_CLOCK_MS: ms.default(60000),
  AGENT_MAX_COST_USD: z.coerce.number().nonnegative().default(0.5),
  TOOL_DEFAULT_TIMEOUT_MS: ms.default(8000),

  DEBUG_MODE_ENABLED: z
    .string()
    .default('false')
    .transform((s) => s === 'true'),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test seam — resets the memoized value. */
export const resetEnvCache = (): void => {
  cached = null;
};
