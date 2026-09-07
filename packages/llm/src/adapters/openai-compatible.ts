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
  MODEL_SUBSTITUTED,
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
  /** Force the non-streaming path. Defaults to streaming — see the note in the factory. */
  stream?: boolean;
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

/** Everything a completion yields, however it arrived. */
interface Parts {
  text: string | null;
  /** Raw tool calls, arguments still unparsed. */
  rawCalls: Array<{ id: string; name: string; args: string }>;
  finishReason: string | null | undefined;
  usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
  } | null;
  model: string;
  raw: unknown;
}

/**
 * Build the frozen LlmResponse from whatever the transport produced.
 *
 * Shared by the streaming and non-streaming paths so the two cannot drift: every defensive
 * behaviour §4.3 asks for — malformed tool JSON, absent usage, unpriced models — is applied
 * in exactly one place regardless of how the bytes arrived.
 */
/**
 * Did the gateway serve a different model than we asked for?
 *
 * MEASURED: requesting `qwen-3.8-max` returns `qwen3.8-flash`, three times out of three. That
 * matters twice over. Cost is looked up by the id that SERVED the call, so pricing the
 * requested id silently does nothing; and a model that passed the §4.5 smoke test is not
 * necessarily the model answering, which undermines the whole point of that gate.
 *
 * Compared on a normalised prefix, because a version suffix is not a substitution:
 * `gpt-4o` served as `gpt-4o-2024-11-20` is the same model, `qwen-3.8-max` served as
 * `qwen3.8-flash` is not.
 */
export function isSubstituted(requested: string, served: string): boolean {
  const norm = (m: string) => m.toLowerCase().replace(/[^a-z0-9]/gu, '');
  const [a, b] = [norm(requested), norm(served)];
  if (!a || !b) return false;
  return !b.startsWith(a) && !a.startsWith(b);
}

function buildResponse(parts: Parts, cfg: AdapterConfig, req: LlmRequest): LlmResponse {
  const flags: string[] = [];
  const toolCalls: LlmResponse['toolCalls'] = [];

  for (const c of parts.rawCalls) {
    const parsed = safeJsonParse(c.args || '{}');
    if (parsed.ok) {
      toolCalls.push({ id: c.id, name: c.name, args: parsed.value });
    } else {
      if (!flags.includes(BAD_TOOL_ARGS)) flags.push(BAD_TOOL_ARGS);
      toolCalls.push({ id: c.id, name: c.name, args: { __parseError: parsed.error, __raw: c.args } });
    }
  }

  const served = parts.model || req.model;
  if (isSubstituted(req.model, served)) flags.push(MODEL_SUBSTITUTED);

  const hasUsage = parts.usage != null;
  if (!hasUsage) flags.push(USAGE_UNAVAILABLE);
  const usage = {
    inputTokens: parts.usage?.prompt_tokens ?? 0,
    outputTokens: parts.usage?.completion_tokens ?? 0,
    // Reported by this gateway as prompt_tokens_details.cached_tokens, and INCLUDED in
    // prompt_tokens. estimateCost splits them so a cache hit is billed once, at its own rate.
    cachedInputTokens: parts.usage?.prompt_tokens_details?.cached_tokens ?? 0,
  };

  return {
    text: parts.text,
    toolCalls,
    stopReason: toolCalls.length > 0 ? 'tool_use' : mapFinishReason(parts.finishReason),
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      costUsd: hasUsage ? estimateCost(usage, parts.model || req.model, cfg.priceTable) : null,
    },
    model: parts.model || req.model,
    provider: cfg.name,
    raw: parts.raw,
    flags,
  };
}

/** Map an SDK/transport failure onto the same status vocabulary tools use (§5.4). */
function toLlmError(e: unknown, cfg: AdapterConfig, signal: AbortSignal): AppError {
  const err = e as { status?: number; name?: string; message?: string };
  if (err.name === 'AbortError' || signal.aborted) {
    return new AppError('TOOL_TIMEOUT', `${cfg.name}: request aborted`, { provider: cfg.name });
  }
  if (err.status === 429) {
    return new AppError('TOOL_UNAVAILABLE', `${cfg.name}: rate limited`, { provider: cfg.name, status: 429 });
  }
  return new AppError('INTERNAL', `${cfg.name}: ${err.message ?? String(e)}`, {
    provider: cfg.name,
    ...(err.status !== undefined ? { status: err.status } : {}),
  });
}

/**
 * Accumulate a stream into Parts.
 *
 * §4.3: "Streaming tool calls arrive as deltas that must be accumulated BY INDEX before the
 * arguments are valid JSON." By index, not by id — the id arrives only on a call's first
 * delta, and later fragments of the same call carry nothing but `index` and a slice of the
 * argument string. Measured on this gateway, one tool call arrives in anywhere from 1 to 6
 * fragments depending on the model, and no single fragment is parseable JSON on its own.
 */
async function accumulate(
  stream: AsyncIterable<Record<string, unknown>>,
  fallbackModel: string,
): Promise<Parts> {
  const byIndex = new Map<number, { id: string; name: string; args: string }>();
  let text = '';
  let finishReason: string | null | undefined;
  let usage: Parts['usage'] = null;
  let model = fallbackModel;
  const chunks: unknown[] = [];

  for await (const chunk of stream) {
    chunks.push(chunk);
    const c = chunk as {
      model?: string;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number } | null;
      } | null;
      choices?: Array<{
        delta?: {
          content?: string | null;
          tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
        };
        finish_reason?: string | null;
      }>;
    };

    if (c.model) model = c.model;
    // Usage arrives in a final chunk of its own on gateways that support stream_options;
    // on those that do not it never arrives, and buildResponse flags it as unavailable.
    if (c.usage) usage = c.usage;

    const choice = c.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (choice.delta?.content) text += choice.delta.content;

    for (const tc of choice.delta?.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      const cur = byIndex.get(idx) ?? { id: '', name: '', args: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name = tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      byIndex.set(idx, cur);
    }
  }

  return {
    text: text.length > 0 ? text : null,
    // Ordered by index so multiple parallel tool calls keep the order the model chose.
    rawCalls: [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v),
    finishReason,
    usage,
    model,
    raw: chunks,
  };
}

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

  /**
   * Streaming is the DEFAULT, and that is a measured decision rather than a preference.
   *
   * Nine of twenty models on the Ramclouds gateway answer a request carrying no `stream`
   * parameter with `text/event-stream` anyway — every DeepSeek, Kimi, Grok and Claude model —
   * so the non-streaming path cannot reach them at all. Streaming, by contrast, works for
   * every model tested in both groups, tool calls included. One path that works everywhere
   * beats two paths and a per-model config flag nobody can maintain.
   */
  const useStream = cfg.stream !== false;

  return {
    name: cfg.name,
    supportsTools: true,
    supportsStreaming: true,

    async complete(req: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
      const body = {
        model: req.model,
        messages: toOpenAiMessages(req.messages),
        ...(req.tools?.length ? { tools: req.tools.map(toOpenAiTool) } : {}),
        ...(req.toolChoice ? { tool_choice: req.toolChoice } : {}),
        ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      };

      if (!useStream) {
        let res;
        try {
          res = await client.chat.completions.create(body, { signal });
        } catch (e) {
          throw toLlmError(e, cfg, signal);
        }
        const choice = res.choices?.[0];
        if (!choice) {
          throw new AppError('LLM_EMPTY_RESPONSE', `${cfg.name}: gateway returned no choices`, {
            provider: cfg.name,
          });
        }
        return buildResponse(
          {
            text: choice.message?.content ?? null,
            rawCalls: (choice.message?.tool_calls ?? []).map((tc) => {
              const fn = (tc as { function?: { name?: string; arguments?: string } }).function;
              return { id: tc.id, name: fn?.name ?? '', args: fn?.arguments ?? '{}' };
            }),
            finishReason: choice.finish_reason,
            usage: res.usage ?? null,
            model: res.model ?? req.model,
            raw: res,
          },
          cfg,
          req,
        );
      }

      let parts: Parts;
      try {
        const stream = await client.chat.completions.create(
          // include_usage asks for a final usage chunk. Gateways that ignore it simply never
          // send one, and the response is flagged usage_unavailable rather than guessed at.
          { ...body, stream: true, stream_options: { include_usage: true } },
          { signal },
        );
        parts = await accumulate(stream as unknown as AsyncIterable<Record<string, unknown>>, req.model);
      } catch (e) {
        throw toLlmError(e, cfg, signal);
      }

      // A stream that produced neither text nor a tool call is the streaming equivalent of a
      // response with no choices, and must be as loud.
      if (parts.text === null && parts.rawCalls.length === 0) {
        throw new AppError('LLM_EMPTY_RESPONSE', `${cfg.name}: stream produced no content`, {
          provider: cfg.name,
          finishReason: parts.finishReason ?? null,
        });
      }

      return buildResponse(parts, cfg, req);
    },
  };
}
