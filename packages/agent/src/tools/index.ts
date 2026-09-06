/**
 * The tool registry — the spec §9.2.
 *
 * "Registration is a single array. Adding a tool must require ZERO changes to the agent loop.
 * If it does, the abstraction is wrong."
 *
 * There is a test asserting that the loop never names a tool, so this stays true.
 *
 * Tools requiring an external site (search_thivien, search_ctext, search_souyun) are NOT here
 * yet: CONTRIBUTING.md and §9.2 both require checking each site's terms of service and rate
 * limits, and recording the findings in an ADR, BEFORE implementing its tool. That check has
 * not been done, so shipping a scraper would be shipping a decision nobody made. See
 * docs/TODO.md.
 */

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { LlmProvider } from '@han/llm/provider';
import type { ModelClient } from '@han/retrieval/model-client';
import type { VectorStore } from '@han/retrieval/vector-store';
import type { Tool } from '../tool.js';
import { createAskModelTool } from './ask-model.js';
import { createSearchLocalExactTool, createSearchLocalSemanticTool } from './search-local.js';

export interface ToolRegistryDeps {
  db: NodePgDatabase<Record<string, never>>;
  model: ModelClient | null;
  vectors: VectorStore | null;
  provider: LlmProvider | null;
  answerModel: string | null;
}

/** The single array. Add a tool here; change nothing else. */
export function createTools(deps: ToolRegistryDeps): Array<Tool<never>> {
  return [
    createSearchLocalExactTool(deps.db),
    createSearchLocalSemanticTool(deps.db, deps.model, deps.vectors),
    createAskModelTool(deps.provider, deps.answerModel),
  ] as unknown as Array<Tool<never>>;
}

export { createAskModelTool, createSearchLocalExactTool, createSearchLocalSemanticTool };
