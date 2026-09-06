/**
 * The ONE adapter — the spec §4.3.
 *
 * Because the wire format is OpenAI-compatible, one adapter covers every provider we are
 * likely to want: Ramclouds, OpenRouter, a local vLLM, or OpenAI itself. Do not write a
 * provider-specific adapter; instantiate this one with different credentials (§4).
 *
 * This is the only file in the repository permitted to import `openai`.
 */

import OpenAI from 'openai';
import { AppError } from '@han/shared/errors';
import {
  BAD_TOOL_ARGS,
  USAGE_UNAVAILABLE,
  type LlmMessage,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type LlmToolDef,
  type StopReason,
} from '../provider.js';
import { estimateCost, type PriceTable } from '../pricing.js';

export interface AdapterConfig {
  name: string;
  apiKey: string;
  baseURL: string;
  priceTable?: PriceTable;
  /**
   * Injectable transport, so the adapter can be exercised without a gateway or a key.
   *
   * Typed loosely because the SDK's own Fetch type is narrower than the platform's: the
   * conversion happens once, here, rather than forcing every test to satisfy a shape the
   * global `fetch` does not have.
   */
  fetch?: (...args: never[]) => Promise<Response>;
}

/** Zod -> JSON Schema, for the subset of shapes our tools actually use. */
function toJsonSchema(schema: unknown): Record<string, unknown> {
  // Tool input schemas in this codebase are flat objects of strings, numbers and enums. Rather
  // than pull in a full converter, each Tool declares its JSON Schema alongside its Zod type
  // (see packages/agent/src/tool.ts) and this reads it off. Zod stays the runtime validator;
  // JSON Schema is only ever the wire description handed to the model.
  const s = schema as { _jsonSchema?: Record<string, unknown> };
  return s._jsonSchema ?? { type: 'object', properties: {}, additionalProperties: true };
}

const toOpenAiTool = (t: LlmToolDef) => ({
  type: 'function' as const,
  function: {
    name: t.name,
    description: t.description,
    parameters: toJsonSchema(t.parameters),
  },
});

/**
 * Models emit malformed JSON in `tool_calls[].function.arguments` regularly (§4.3).
 *
 * Returning the parse error rather than throwing lets the caller feed it back to the model as
 * a tool result so it can correct itself. Crashing the run over a stray trailing comma throws
 * away everything the agent has done so far.
 */
export function safeJsonParse(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function mapFinishReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case null:
    case undefined:
      // Some gateways omit finish_reason entirely. Treating that as a clean end would hide a
      // truncated response; treating it as an error would reject working gateways. The
      // presence of tool calls disambiguates it at the call site.
      return 'end_turn';
    default:
      return 'error';
  }
}

const toOpenAiMessages = (messages: LlmMessage[]) =>
  messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool' as const, content: m.content ?? '', tool_call_id: m.toolCallId ?? '' };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant' as const,
        content: m.content,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
        })),
      };
    }
    return { role: m.role as 'system' | 'user' | 'assistant', content: m.content ?? '' };
  });

export function createOpenAiCompatibleProvider(cfg: AdapterConfig): LlmProvider {
  const client = new OpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseURL,
    // Temporal owns the retry policy (§4.1 rule 2). Two independent retry layers produce
    // duplicated tool calls and blown cost budgets that are painful to diagnose. Retry belongs
    // in exactly one place, and it is not here.
    maxRetries: 0,
    // Cast once, here: the SDK's Fetch type is narrower than the platform's, and widening it
    // at this single boundary is better than making every caller satisfy the narrower shape.
    ...(cfg.fetch ? { fetch: cfg.fetch as unknown as ConstructorParameters<typeof OpenAI>[0] extends { fetch?: infer F } ? F : never } : {}),
  });

  return {
    name: cfg.name,
    supportsTools: true,
    supportsStreaming: true,

    async complete(req: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
      let res;
      try {
        res = await client.chat.completions.create(
          {
            model: req.model,
            messages: toOpenAiMessages(req.messages),
            ...(req.tools?.length ? { tools: req.tools.map(toOpenAiTool) } : {}),
            ...(req.toolChoice ? { tool_choice: req.toolChoice } : {}),
            ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          },
          { signal },
        );
      } catch (e) {
        // Upstream errors map onto StepStatus using the same table as tools (CONTRIBUTING.md,
        // extension point 3): 429 is UNAVAILABLE, a socket timeout is TIMEOUT, a 500 is ERROR.
        const err = e as { status?: number; name?: string; message?: string };
        if (err.name === 'AbortError' || signal.aborted) {
          throw new AppError('TOOL_TIMEOUT', `${cfg.name}: request aborted`, { provider: cfg.name });
        }
        if (err.status === 429) {
          throw new AppError('TOOL_UNAVAILABLE', `${cfg.name}: rate limited`, { provider: cfg.name, status: 429 });
        }
        throw new AppError('INTERNAL', `${cfg.name}: ${err.message ?? String(e)}`, {
          provider: cfg.name,
          ...(err.status !== undefined ? { status: err.status } : {}),
        });
      }

      const choice = res.choices?.[0];
      if (!choice) {
        throw new AppError('LLM_EMPTY_RESPONSE', `${cfg.name}: gateway returned no choices`, {
          provider: cfg.name,
        });
      }

      const flags: string[] = [];
      const toolCalls: LlmResponse['toolCalls'] = [];
      for (const tc of choice.message?.tool_calls ?? []) {
        const fn = (tc as { function?: { name?: string; arguments?: string } }).function;
        const parsed = safeJsonParse(fn?.arguments ?? '{}');
        if (parsed.ok) {
          toolCalls.push({ id: tc.id, name: fn?.name ?? '', args: parsed.value });
        } else {
          // Kept as a call with the error attached, so the loop can hand the model its own
          // mistake as a tool result instead of the run dying.
          if (!flags.includes(BAD_TOOL_ARGS)) flags.push(BAD_TOOL_ARGS);
          toolCalls.push({
            id: tc.id,
            name: fn?.name ?? '',
            args: { __parseError: parsed.error, __raw: fn?.arguments ?? '' },
          });
        }
      }

      // `usage` may be absent — gateways drop it. Report zeros and costUsd null; never
      // fabricate a number, and make the degradation visible (§4.3).
      const hasUsage = res.usage != null;
      if (!hasUsage) flags.push(USAGE_UNAVAILABLE);
      const usage = {
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
      };

      const stopReason =
        toolCalls.length > 0 ? 'tool_use' : mapFinishReason(choice.finish_reason);

      return {
        text: choice.message?.content ?? null,
        toolCalls,
        stopReason,
        usage: {
          ...usage,
          costUsd: hasUsage ? estimateCost(usage, res.model ?? req.model, cfg.priceTable) : null,
        },
        model: res.model ?? req.model,
        provider: cfg.name,
        raw: res,
        flags,
      };
    },
  };
}
