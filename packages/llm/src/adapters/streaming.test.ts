import { describe, expect, it, vi } from 'vitest';
import { createOpenAiCompatibleProvider } from './openai-compatible.js';
import { BAD_TOOL_ARGS, USAGE_UNAVAILABLE } from '../provider.js';

/**
 * A fake SSE gateway. Streaming is the adapter's default path, so these cover the behaviour
 * §4.3 singles out: tool-call arguments arrive in fragments and are not valid JSON until
 * accumulated BY INDEX.
 */
const sse = (chunks: unknown[], opts: { done?: boolean } = {}) => {
  const body =
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') +
    (opts.done === false ? '' : 'data: [DONE]\n\n');
  return vi.fn(
    async () =>
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  );
};

const provider = (fetchImpl: ReturnType<typeof sse>, priceTable?: Record<string, { inputPerMTok: number; outputPerMTok: number }>) =>
  createOpenAiCompatibleProvider({
    name: 'fake',
    apiKey: 'k',
    baseURL: 'https://gateway.invalid/v1',
    fetch: fetchImpl as never,
    ...(priceTable ? { priceTable } : {}),
  });

const delta = (d: unknown, finish: string | null = null) => ({
  id: 'c1',
  model: 'test-model',
  choices: [{ index: 0, delta: d, finish_reason: finish }],
});

const sig = () => new AbortController().signal;

describe('streaming', () => {
  it('accumulates content fragments into one text', async () => {
    const p = provider(
      sse([
        delta({ role: 'assistant', content: '細草' }),
        delta({ content: '微風' }),
        delta({ content: '岸' }, 'stop'),
      ]),
    );
    const r = await p.complete({ model: 'test-model', messages: [] }, sig());
    expect(r.text).toBe('細草微風岸');
    expect(r.stopReason).toBe('end_turn');
  });

  // The reason this module exists: no single fragment is parseable on its own.
  it('accumulates tool arguments split across fragments', async () => {
    const p = provider(
      sse([
        delta({ tool_calls: [{ index: 0, id: 't1', function: { name: 'lookup_poem', arguments: '{"frag' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: 'ment":"細草' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '微風岸"}' } }] }, 'tool_calls'),
      ]),
    );
    const r = await p.complete({ model: 'test-model', messages: [] }, sig());
    expect(r.stopReason).toBe('tool_use');
    expect(r.toolCalls).toEqual([{ id: 't1', name: 'lookup_poem', args: { fragment: '細草微風岸' } }]);
    expect(r.flags).not.toContain(BAD_TOOL_ARGS);
  });

  // §4.3 says BY INDEX, not by id — later fragments carry only the index.
  it('keeps two parallel tool calls apart by index, not by id', async () => {
    const p = provider(
      sse([
        delta({
          tool_calls: [
            { index: 0, id: 'a', function: { name: 'lookup_poem', arguments: '{"fragment":' } },
            { index: 1, id: 'b', function: { name: 'lookup_author', arguments: '{"name":' } },
          ],
        }),
        delta({
          tool_calls: [
            { index: 1, function: { arguments: '"李白"}' } },
            { index: 0, function: { arguments: '"細草"}' } },
          ],
        }, 'tool_calls'),
      ]),
    );
    const r = await p.complete({ model: 'test-model', messages: [] }, sig());
    expect(r.toolCalls).toEqual([
      { id: 'a', name: 'lookup_poem', args: { fragment: '細草' } },
      { id: 'b', name: 'lookup_author', args: { name: '李白' } },
    ]);
  });

  it('carries an id that only ever appeared on the first fragment', async () => {
    const p = provider(
      sse([
        delta({ tool_calls: [{ index: 0, id: 'only-here', function: { name: 'f', arguments: '{}' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '' } }] }, 'tool_calls'),
      ]),
    );
    const r = await p.complete({ model: 'm', messages: [] }, sig());
    expect(r.toolCalls[0]!.id).toBe('only-here');
  });

  it('reports malformed accumulated arguments rather than crashing', async () => {
    const p = provider(
      sse([
        delta({ tool_calls: [{ index: 0, id: 't1', function: { name: 'f', arguments: '{"a":' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: ' unquoted}' } }] }, 'tool_calls'),
      ]),
    );
    const r = await p.complete({ model: 'm', messages: [] }, sig());
    expect(r.flags).toContain(BAD_TOOL_ARGS);
    expect(r.toolCalls[0]!.args).toHaveProperty('__parseError');
  });

  it('takes usage from the final chunk when the gateway sends one', async () => {
    const p = provider(
      sse([
        delta({ content: 'OK' }, 'stop'),
        { id: 'c1', model: 'test-model', choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } },
      ]),
      { 'test-model': { inputPerMTok: 1, outputPerMTok: 2 } },
    );
    const r = await p.complete({ model: 'test-model', messages: [] }, sig());
    expect(r.usage.inputTokens).toBe(12);
    expect(r.usage.costUsd).toBeCloseTo(12 / 1e6 + (4 / 1e6) * 2);
    expect(r.flags).not.toContain(USAGE_UNAVAILABLE);
  });

  it('flags usage as unavailable when no usage chunk arrives', async () => {
    const p = provider(sse([delta({ content: 'OK' }, 'stop')]));
    const r = await p.complete({ model: 'm', messages: [] }, sig());
    expect(r.flags).toContain(USAGE_UNAVAILABLE);
    expect(r.usage.costUsd).toBeNull();
  });

  it('treats a stream with no content and no tool call as an empty response', async () => {
    const p = provider(sse([delta({}, 'stop')]));
    await expect(p.complete({ model: 'm', messages: [] }, sig())).rejects.toMatchObject({
      code: 'LLM_EMPTY_RESPONSE',
    });
  });

  it('round-trips CJK across fragment boundaries', async () => {
    const p = provider(sse([delta({ content: '危檣' }), delta({ content: '獨夜舟' }, 'stop')]));
    const r = await p.complete({ model: 'm', messages: [] }, sig());
    expect(r.text).toBe('危檣獨夜舟');
  });

  it('still supports the non-streaming path when explicitly disabled', async () => {
    const json = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 'c1',
            model: 'test-model',
            choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const p = createOpenAiCompatibleProvider({
      name: 'fake',
      apiKey: 'k',
      baseURL: 'https://gateway.invalid/v1',
      fetch: json as never,
      stream: false,
    });
    const r = await p.complete({ model: 'test-model', messages: [] }, sig());
    expect(r.text).toBe('OK');
    expect(r.usage.inputTokens).toBe(3);
  });
});

describe('model substitution', () => {
  // MEASURED: this gateway answers a request for `qwen-3.8-max` with `qwen3.8-flash`. Cost is
  // looked up by the id that served the call, so the substitution silently defeats pricing —
  // and, worse, means the model that passed the §4.5 smoke test may not be the one answering.
  it('flags a served model that is not the requested one', async () => {
    const p = provider(sse([delta({ content: 'OK' }, 'stop')]).mockImplementation(async () =>
      new Response(
        `data: ${JSON.stringify({ model: 'qwen3.8-flash', choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    ));
    const r = await p.complete({ model: 'qwen-3.8-max', messages: [] }, sig());
    expect(r.flags).toContain('llm_model_substituted');
    expect(r.model).toBe('qwen3.8-flash');
  });

  it('does not flag a version suffix — that is the same model, not a substitution', async () => {
    const p = provider(sse([]).mockImplementation(async () =>
      new Response(
        `data: ${JSON.stringify({ model: 'gpt-4o-2024-11-20', choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    ));
    const r = await p.complete({ model: 'gpt-4o', messages: [] }, sig());
    expect(r.flags).not.toContain('llm_model_substituted');
  });
});
