import type { z } from 'zod';

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmMessage {
  role: LlmRole;
  content: string | null;
  toolCalls?: Array<{ id: string; name: string; args: unknown }>;
  toolCallId?: string;
}

export interface LlmToolDef {
  name: string;
  description: string;
  parameters: z.ZodType<unknown>;
}

export interface LlmRequest {
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
  cachedInputTokens?: number;
  costUsd: number | null;
}

export interface LlmResponse {
  text: string | null;
  toolCalls: Array<{ id: string; name: string; args: unknown }>;
  stopReason: StopReason;
  usage: LlmUsage;
  model: string;
  provider: string;
  raw: unknown;
  flags: string[];
}

export interface LlmProvider {
  readonly name: string;
  readonly supportsTools: boolean;
  readonly supportsStreaming: boolean;
  complete(req: LlmRequest, signal: AbortSignal): Promise<LlmResponse>;
}

export const USAGE_UNAVAILABLE = 'usage_unavailable';
export const BAD_TOOL_ARGS = 'llm_bad_tool_args';
export const MODEL_SUBSTITUTED = 'llm_model_substituted';
