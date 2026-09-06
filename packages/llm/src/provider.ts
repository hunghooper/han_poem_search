/**
 * LLM provider contract — the spec §4.2. FROZEN.
 *
 * Every LLM call in this system goes through this interface. Nothing outside
 * packages/llm/src/adapters/ may import the `openai` SDK — an ESLint no-restricted-imports
 * rule enforces it (§4.1 rule 4), so that swapping gateways is a config change rather than a
 * code change.
 */

import type { z } from 'zod';

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmMessage {
  role: LlmRole;
  content: string | null;
  /** Present on assistant messages that requested tools. */
  toolCalls?: Array<{ id: string; name: string; args: unknown }>;
  /** Present on tool messages, identifying which call this answers. */
  toolCallId?: string;
}

export interface LlmToolDef {
  name: string;
  description: string;
  /** Converted to JSON Schema by the adapter. */
  parameters: z.ZodType<unknown>;
}

export interface LlmRequest {
  /** An opaque gateway-specific string. NEVER branch on it (§4.1 rule 5). */
  model: string;
  messages: LlmMessage[];
  tools?: LlmToolDef[];
  toolChoice?: 'auto' | 'none' | 'required';
  maxTokens?: number;
  temperature?: number;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'error';

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** null when the model is unpriced. NEVER a guess (§4.3). */
  costUsd: number | null;
}

export interface LlmResponse {
  text: string | null;
  toolCalls: Array<{ id: string; name: string; args: unknown }>;
  stopReason: StopReason;
  usage: LlmUsage;
  model: string;
  /** Which provider actually served this call. With failover on, otherwise unanswerable. */
  provider: string;
  /** Debug mode only. Must never reach the default UI or the event log unredacted. */
  raw: unknown;
  /**
   * Surfaced when the gateway dropped `usage`. Budget accounting is then visibly degraded
   * rather than silently wrong (§4.3).
   */
  flags: string[];
}

export interface LlmProvider {
  readonly name: string;
  readonly supportsTools: boolean;
  readonly supportsStreaming: boolean;
  /** The signal is the caller's wall-clock budget, not the SDK's timeout (§4.1 rule 3). */
  complete(req: LlmRequest, signal: AbortSignal): Promise<LlmResponse>;
}

/** Flag emitted when a gateway omits token counts. */
export const USAGE_UNAVAILABLE = 'usage_unavailable';
/** Flag emitted when the model returned unparseable tool arguments. */
export const BAD_TOOL_ARGS = 'llm_bad_tool_args';
