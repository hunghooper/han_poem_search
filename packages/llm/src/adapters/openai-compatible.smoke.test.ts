import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createOpenAiCompatibleProvider } from './openai-compatible.js';
import type { LlmToolDef } from '../provider.js';

function fromDotenv(): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync('.env', 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
        .map((l) => {
          const i = l.indexOf('=');
          return [
            l.slice(0, i).trim(),
            l
              .slice(i + 1)
              .replace(/\s+#.*$/u, '')
              .trim(),
          ];
        }),
    );
  } catch {
    return {};
  }
}

const dotenv = fromDotenv();
const env = (k: string): string => process.env[k] ?? dotenv[k] ?? '';

const apiKey = env('RAMCLOUDS_API_KEY') || env('LLM_API_KEY');
const baseURL = env('RAMCLOUDS_BASE_URL') || env('LLM_BASE_URL');
const models = (env('SMOKE_MODELS') || env('LLM_MODEL_REASONING'))
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

const configured = apiKey.length > 0 && baseURL.length > 0 && models.length > 0;

const withJsonSchema = <T extends z.ZodType<unknown>>(
  schema: T,
  json: Record<string, unknown>,
): T => {
  (schema as unknown as { _jsonSchema?: Record<string, unknown> })._jsonSchema = json;
  return schema;
};

const lookupTool: LlmToolDef = {
  name: 'lookup_poem',
  description: 'Look up a classical Chinese poem by a fragment of its text.',
  parameters: withJsonSchema(z.object({ fragment: z.string() }), {
    type: 'object',
    properties: { fragment: { type: 'string', description: 'A fragment of the poem' } },
    required: ['fragment'],
  }),
};

const authorTool: LlmToolDef = {
  name: 'lookup_author',
  description: 'Look up a poet by name.',
  parameters: withJsonSchema(z.object({ name: z.string() }), {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
  }),
};

const signal = () => AbortSignal.timeout(60_000);

describe.skipIf(!configured)('gateway smoke test (§4.5)', () => {
  for (const model of models) {
    describe(model, () => {
      const provider = createOpenAiCompatibleProvider({ name: 'smoke', apiKey, baseURL });

      it('1. plain completion returns text', async () => {
        const r = await provider.complete(
          {
            model,
            messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
            maxTokens: 2000,
          },
          signal(),
        );
        expect(r.text).toBeTruthy();
        expect(r.stopReason).not.toBe('error');
      });

      it('2. a single tool definition produces a parseable tool_calls entry', async () => {
        const r = await provider.complete(
          {
            model,
            messages: [
              { role: 'user', content: 'Find the poem containing 細草微風岸. Use the tool.' },
            ],
            tools: [lookupTool],
            toolChoice: 'auto',
          },
          signal(),
        );
        expect(r.toolCalls.length).toBeGreaterThan(0);
        expect(r.toolCalls[0]!.name).toBe('lookup_poem');
        expect(r.toolCalls[0]!.args).not.toHaveProperty('__parseError');
      });

      it('3. a tool RESULT fed back produces a sensible second turn', async () => {
        const first = await provider.complete(
          {
            model,
            messages: [
              { role: 'user', content: 'Find the poem containing 細草微風岸. Use the tool.' },
            ],
            tools: [lookupTool],
            toolChoice: 'auto',
          },
          signal(),
        );
        const call = first.toolCalls[0];
        expect(call, 'no tool call to feed back').toBeDefined();

        const second = await provider.complete(
          {
            model,
            messages: [
              { role: 'user', content: 'Find the poem containing 細草微風岸. Use the tool.' },
              { role: 'assistant', content: first.text, toolCalls: first.toolCalls },
              {
                role: 'tool',
                toolCallId: call!.id,
                content: JSON.stringify({ title: '旅夜書懷', author: '杜甫', dynasty: '唐' }),
              },
            ],
            tools: [lookupTool],
          },
          signal(),
        );
        expect(second.text).toBeTruthy();
        expect(second.text).toMatch(/旅夜書懷|杜甫/);
      });

      it('4. with two tools the model picks one rather than erroring', async () => {
        const r = await provider.complete(
          {
            model,
            messages: [{ role: 'user', content: 'Who was 李白? Use the appropriate tool.' }],
            tools: [lookupTool, authorTool],
            toolChoice: 'auto',
          },
          signal(),
        );
        expect(r.stopReason).not.toBe('error');
        if (r.toolCalls.length > 0) {
          expect(['lookup_poem', 'lookup_author']).toContain(r.toolCalls[0]!.name);
        }
      });

      it('5. usage is present and non-zero', async () => {
        const r = await provider.complete(
          { model, messages: [{ role: 'user', content: 'Say OK' }], maxTokens: 2000 },
          signal(),
        );
        expect(r.flags).not.toContain('usage_unavailable');
        expect(r.usage.inputTokens).toBeGreaterThan(0);
      });

      it('6. AbortSignal actually cancels the request', async () => {
        const ac = new AbortController();
        const pending = provider.complete(
          {
            model,
            messages: [{ role: 'user', content: 'Write a long essay about 唐詩.' }],
            maxTokens: 2000,
          },
          ac.signal,
        );
        setTimeout(() => ac.abort(), 50);
        await expect(pending).rejects.toMatchObject({ code: 'TOOL_TIMEOUT' });
      });

      it('7. a CJK prompt round-trips without mojibake', async () => {
        const r = await provider.complete(
          {
            model,
            messages: [{ role: 'user', content: '請原樣重複這句話：細草微風岸，危檣獨夜舟。' }],
            maxTokens: 2000,
          },
          signal(),
        );
        expect(r.text ?? '').toMatch(/細草微風岸/);
      });
    });
  }
});

describe.skipIf(configured)('gateway smoke test (not configured)', () => {
  it('is skipped until credentials and SMOKE_MODELS are set', () => {
    expect(configured).toBe(false);
  });
});
