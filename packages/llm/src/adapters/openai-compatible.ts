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
  fetch?: (...args: never[]) => Promise<Response>;
  stream?: boolean;
}

function toJsonSchema(schema: unknown): Record<string, unknown> {
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

export function safeJsonParse(
  raw: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
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

interface Parts {
  text: string | null;
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
      toolCalls.push({
        id: c.id,
        name: c.name,
        args: { __parseError: parsed.error, __raw: c.args },
      });
    }
  }

  const served = parts.model || req.model;
  if (isSubstituted(req.model, served)) flags.push(MODEL_SUBSTITUTED);

  const hasUsage = parts.usage != null;
  if (!hasUsage) flags.push(USAGE_UNAVAILABLE);
  const usage = {
    inputTokens: parts.usage?.prompt_tokens ?? 0,
    outputTokens: parts.usage?.completion_tokens ?? 0,
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

function toLlmError(e: unknown, cfg: AdapterConfig, signal: AbortSignal): AppError {
  const err = e as { status?: number; name?: string; message?: string };
  if (err.name === 'AbortError' || signal.aborted) {
    return new AppError('TOOL_TIMEOUT', `${cfg.name}: request aborted`, { provider: cfg.name });
  }
  if (err.status === 429) {
    return new AppError('TOOL_UNAVAILABLE', `${cfg.name}: rate limited`, {
      provider: cfg.name,
      status: 429,
    });
  }
  return new AppError('INTERNAL', `${cfg.name}: ${err.message ?? String(e)}`, {
    provider: cfg.name,
    ...(err.status !== undefined ? { status: err.status } : {}),
  });
}

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
          tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason?: string | null;
      }>;
    };

    if (c.model) model = c.model;
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
    maxRetries: 0,
    ...(cfg.fetch
      ? {
          fetch: cfg.fetch as unknown as ConstructorParameters<typeof OpenAI>[0] extends {
            fetch?: infer F;
          }
            ? F
            : never,
        }
      : {}),
  });

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
          { ...body, stream: true, stream_options: { include_usage: true } },
          { signal },
        );
        parts = await accumulate(
          stream as unknown as AsyncIterable<Record<string, unknown>>,
          req.model,
        );
      } catch (e) {
        throw toLlmError(e, cfg, signal);
      }

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
