/**
 * The tool registry — the spec §9.2.
 *
 * "Registration is a single array. Adding a tool must require ZERO changes to the agent loop.
 * If it does, the abstraction is wrong."
 *
 * There is a test asserting that the loop never names a tool, so this stays true.
 *
 * `search_souyun` is here because its check WAS done — robots.txt and terms read on
 * 2026-09-08, findings in ADR 013 — and it is off unless TOOL_SOUYUN_ENABLED says otherwise.
 *
 * `search_thivien` and `search_ctext` are still absent, and now for measured reasons rather
 * than an unfinished check: ctext.org does not answer from this machine at all, and thivien's
 * content field does not index Han text (a distinctive five-character phrase moved its result
 * count from 88,264 to 79,760, which is not a match). Both in ADR 013.
 */

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
  /** Outside sources, off unless switched on. Absent means the defaults below. */
  web?: {
    souyunEnabled: boolean;
    userAgent: string;
    timeoutMs: number;
    delayMs: number;
    cacheTtlMs: number;
  };
}

/**
 * Says who is calling and how to stop us. A scraper that hides behind a browser string gives
 * the site no way to complain before blocking, which is the wrong way round.
 */
const DEFAULT_USER_AGENT =
  'han-search/0.1 (classical Chinese poetry lookup; contact via the site operator)';

/** The single array. Add a tool here; change nothing else. */
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
