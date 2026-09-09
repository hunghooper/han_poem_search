import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { LlmProvider } from '@han/llm/provider';
import type { ModelClient } from '@han/retrieval/model-client';
import type { VectorStore } from '@han/retrieval/vector-store';
import type { Tool } from '../tool.js';
import { createAskModelTool } from './ask-model.js';
import { createSearchLocalExactTool, createSearchLocalSemanticTool } from './search-local.js';
import { createSouyunTool } from './search-souyun.js';

export interface ToolRegistryDeps {
  db: NodePgDatabase<Record<string, never>>;
  model: ModelClient | null;
  vectors: VectorStore | null;
  provider: LlmProvider | null;
  answerModel: string | null;
  web?: {
    souyunEnabled: boolean;
    userAgent: string;
    timeoutMs: number;
    delayMs: number;
    cacheTtlMs: number;
  };
}

const DEFAULT_USER_AGENT =
  'han-search/0.1 (classical Chinese poetry lookup; contact via the site operator)';

export function createTools(deps: ToolRegistryDeps): Array<Tool<never>> {
  return [
    createSearchLocalExactTool(deps.db),
    createSearchLocalSemanticTool(deps.db, deps.model, deps.vectors),
    createAskModelTool(deps.provider, deps.answerModel),
    createSouyunTool({
      enabled: deps.web?.souyunEnabled ?? false,
      userAgent: deps.web?.userAgent ?? DEFAULT_USER_AGENT,
      timeoutMs: deps.web?.timeoutMs ?? 15_000,
      delayMs: deps.web?.delayMs ?? 2_000,
      cacheTtlMs: deps.web?.cacheTtlMs ?? 3_600_000,
    }),
  ] as unknown as Array<Tool<never>>;
}

export {
  createAskModelTool,
  createSearchLocalExactTool,
  createSearchLocalSemanticTool,
  createSouyunTool,
};
