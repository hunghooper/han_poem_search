/**
 * Gateway smoke runner — the spec §4.5, §18 Q1.
 *
 * Produces the results table for docs/adr/002-llm-gateway.md. Runs the seven checks against
 * each model SEQUENTIALLY with a pause between calls: the gateway throttles on "excessive
 * errors", so a parallel run measures the throttle rather than the models.
 *
 *   pnpm exec tsx scripts/smoke-gateway.ts model-a model-b ...
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { createOpenAiCompatibleProvider } from '@han/llm/adapters/openai-compatible';
import type { LlmToolDef, LlmProvider } from '@han/llm/provider';

const dotenv = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).replace(/\s+#.*$/u, '').trim()];
    }),
);

const apiKey = process.env.RAMCLOUDS_API_KEY ?? dotenv.RAMCLOUDS_API_KEY ?? '';
const baseURL = process.env.RAMCLOUDS_BASE_URL ?? dotenv.RAMCLOUDS_BASE_URL ?? '';
if (!apiKey || !baseURL) throw new Error('RAMCLOUDS_API_KEY / RAMCLOUDS_BASE_URL not set');

const withJsonSchema = <T extends z.ZodType<unknown>>(schema: T, json: Record<string, unknown>): T => {
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

/**
 * Reasoning models spend max_tokens on internal reasoning BEFORE emitting content. MEASURED:
 * glm-5.3 at max_tokens=16 returns finish_reason "length" with empty content and
 * reasoning_tokens=18; at 2000 it returns "OK". A small budget therefore fails a working model
 * and looks like the model is broken, so every check here allows room to think.
 */
const MAX_TOKENS = 2000;

const PAUSE_MS = 1200;
const pause = () => new Promise((r) => setTimeout(r, PAUSE_MS));
const sig = () => AbortSignal.timeout(90_000);

type Outcome = 'pass' | 'fail' | 'error';
interface CheckResult { n: number; name: string; outcome: Outcome; note: string }

async function check(
  n: number,
  name: string,
  fn: () => Promise<{ ok: boolean; note: string }>,
): Promise<CheckResult> {
  try {
    const { ok, note } = await fn();
    return { n, name, outcome: ok ? 'pass' : 'fail', note };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return { n, name, outcome: 'error', note: m.slice(0, 110).replace(/\s+/gu, ' ') };
  }
}

async function runModel(model: string): Promise<CheckResult[]> {
  const p: LlmProvider = createOpenAiCompatibleProvider({ name: 'smoke', apiKey, baseURL });
  const out: CheckResult[] = [];

  out.push(
    await check(1, 'plain completion', async () => {
      const r = await p.complete(
        { model, messages: [{ role: 'user', content: 'Reply with exactly: OK' }], maxTokens: MAX_TOKENS },
        sig(),
      );
      return { ok: Boolean(r.text?.trim()), note: r.text ? `"${r.text.trim().slice(0, 24)}"` : 'empty text' };
    }),
  );
  await pause();

  let firstCall: Awaited<ReturnType<LlmProvider['complete']>> | null = null;
  out.push(
    await check(2, 'tool call', async () => {
      const r = await p.complete(
        {
          model,
          messages: [{ role: 'user', content: 'Find the poem containing 細草微風岸. Use the tool.' }],
          tools: [lookupTool],
          toolChoice: 'auto',
        },
        sig(),
      );
      firstCall = r;
      const tc = r.toolCalls[0];
      if (!tc) return { ok: false, note: 'no tool_calls returned' };
      const bad = (tc.args as { __parseError?: string }).__parseError;
      return { ok: !bad && tc.name === 'lookup_poem', note: bad ? `bad JSON: ${bad}` : tc.name };
    }),
  );
  await pause();

  out.push(
    await check(3, 'tool result round-trip', async () => {
      const first = firstCall;
      const call = first?.toolCalls[0];
      if (!call) return { ok: false, note: 'skipped — check 2 produced no call' };
      const r = await p.complete(
        {
          model,
          messages: [
            { role: 'user', content: 'Find the poem containing 細草微風岸. Use the tool.' },
            { role: 'assistant', content: first!.text, toolCalls: first!.toolCalls },
            {
              role: 'tool',
              toolCallId: call.id,
              content: JSON.stringify({ title: '旅夜書懷', author: '杜甫', dynasty: '唐' }),
            },
          ],
          tools: [lookupTool],
          maxTokens: MAX_TOKENS,
        },
        sig(),
      );
      const text = r.text ?? '';
      return { ok: /旅夜書懷|杜甫/u.test(text), note: text ? `"${text.replace(/\s+/gu, ' ').slice(0, 40)}"` : 'empty text' };
    }),
  );
  await pause();

  out.push(
    await check(4, 'two tools', async () => {
      const r = await p.complete(
        {
          model,
          messages: [{ role: 'user', content: 'Who was 李白? Use the appropriate tool.' }],
          tools: [lookupTool, authorTool],
          toolChoice: 'auto',
        },
        sig(),
      );
      if (r.stopReason === 'error') return { ok: false, note: 'stopReason error' };
      const picked = r.toolCalls[0]?.name;
      return { ok: true, note: picked ?? 'answered without a tool' };
    }),
  );
  await pause();

  out.push(
    await check(5, 'usage present', async () => {
      const r = await p.complete({ model, messages: [{ role: 'user', content: 'Say OK' }], maxTokens: MAX_TOKENS }, sig());
      return {
        ok: !r.flags.includes('usage_unavailable') && r.usage.inputTokens > 0,
        note: `in=${r.usage.inputTokens} out=${r.usage.outputTokens}`,
      };
    }),
  );
  await pause();

  out.push(
    await check(6, 'abort cancels', async () => {
      const ac = new AbortController();
      const pending = p.complete(
        { model, messages: [{ role: 'user', content: 'Write a long essay about 唐詩.' }], maxTokens: MAX_TOKENS },
        ac.signal,
      );
      setTimeout(() => ac.abort(), 60);
      try {
        await pending;
        return { ok: false, note: 'completed despite abort' };
      } catch (e) {
        const code = (e as { code?: string }).code;
        return { ok: code === 'TOOL_TIMEOUT', note: code ?? 'unknown' };
      }
    }),
  );
  await pause();

  out.push(
    await check(7, 'CJK round-trip', async () => {
      const r = await p.complete(
        { model, messages: [{ role: 'user', content: '請原樣重複這句話：細草微風岸，危檣獨夜舟。' }], maxTokens: MAX_TOKENS },
        sig(),
      );
      const text = r.text ?? '';
      return { ok: /細草微風岸/u.test(text), note: text ? `"${text.replace(/\s+/gu, ' ').slice(0, 30)}"` : 'empty text' };
    }),
  );

  return out;
}

const models = process.argv.slice(2);
if (models.length === 0) throw new Error('usage: tsx scripts/smoke-gateway.ts <model> [model...]');

const mark = (o: Outcome) => (o === 'pass' ? 'PASS' : o === 'fail' ? 'FAIL' : 'ERR ');
const all: Record<string, CheckResult[]> = {};

for (const model of models) {
  console.log(`\n=== ${model} ===`);
  const results = await runModel(model);
  all[model] = results;
  for (const r of results) console.log(`  ${mark(r.outcome)} ${r.n}. ${r.name.padEnd(24)} ${r.note}`);
  // Checks 2, 3 and 4 decide whether a model can drive the agent loop at all (§4.5).
  const agentReady = [2, 3, 4].every((n) => results.find((r) => r.n === n)?.outcome === 'pass');
  console.log(`  -> ${agentReady ? 'USABLE for the agent loop' : 'NOT usable for the agent loop'}`);
  await pause();
}

console.log('\n\n| model | 1 text | 2 tool call | 3 tool result | 4 two tools | 5 usage | 6 abort | 7 CJK | agent-capable |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const [model, results] of Object.entries(all)) {
  const cell = (n: number) => {
    const r = results.find((x) => x.n === n);
    return r?.outcome === 'pass' ? 'pass' : r?.outcome === 'fail' ? 'FAIL' : 'ERROR';
  };
  const agentReady = [2, 3, 4].every((n) => results.find((r) => r.n === n)?.outcome === 'pass');
  console.log(
    `| \`${model}\` | ${[1, 2, 3, 4, 5, 6, 7].map(cell).join(' | ')} | ${agentReady ? '**yes**' : 'no'} |`,
  );
}

writeFileSync('docs/smoke-latest.json', JSON.stringify({ ranAt: new Date().toISOString(), baseURL, results: all }, null, 2));
console.log('\nwrote docs/smoke-latest.json');
