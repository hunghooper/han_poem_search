import { describe, expect, it, vi } from 'vitest';
import {
  createOpenAiCompatibleProvider,
  mapFinishReason,
  safeJsonParse,
} from './openai-compatible.js';
import { USAGE_UNAVAILABLE, BAD_TOOL_ARGS } from '../provider.js';

const fakeGateway = (body: unknown, init: { status?: number } = {}) =>
  vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  );

const provider = (
  fetchImpl: ReturnType<typeof fakeGateway>,
  priceTable?: Record<string, { inputPerMTok: number; outputPerMTok: number }>,
) =>
  createOpenAiCompatibleProvider({
    name: 'fake',
    apiKey: 'test-key',
    baseURL: 'https://gateway.invalid/v1',
    fetch: fetchImpl as never,
    stream: false,
    ...(priceTable ? { priceTable } : {}),
  });

const completion = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  model: 'test-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
  ...over,
});

describe('safeJsonParse', () => {
  it('parses valid arguments', () => {
    expect(safeJsonParse('{"q":"李白"}')).toEqual({ ok: true, value: { q: '李白' } });
  });

  it('returns the error instead of throwing — models emit malformed JSON regularly', () => {
    const r = safeJsonParse('{"q": "李白",}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeTruthy();
  });
});

describe('mapFinishReason', () => {
  it('maps the documented reasons', () => {
    expect(mapFinishReason('stop')).toBe('end_turn');
    expect(mapFinishReason('tool_calls')).toBe('tool_use');
    expect(mapFinishReason('length')).toBe('max_tokens');
    expect(mapFinishReason('content_filter')).toBe('error');
  });

  it('treats an omitted reason as a clean end rather than an error', () => {
    expect(mapFinishReason(null)).toBe('end_turn');
    expect(mapFinishReason(undefined)).toBe('end_turn');
  });
});

describe('createOpenAiCompatibleProvider', () => {
  it('returns text and usage from a plain completion', async () => {
    const p = provider(fakeGateway(completion()));
    const r = await p.complete(
      { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
      new AbortController().signal,
    );
    expect(r.text).toBe('hello');
    expect(r.stopReason).toBe('end_turn');
    expect(r.usage.inputTokens).toBe(10);
    expect(r.provider).toBe('fake');
    expect(r.flags).toEqual([]);
  });

  it('parses a well-formed tool call', async () => {
    const p = provider(
      fakeGateway(
        completion({
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 't1',
                    type: 'function',
                    function: { name: 'search_local_exact', arguments: '{"query":"細草微風岸"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      ),
    );
    const r = await p.complete({ model: 'm', messages: [] }, new AbortController().signal);
    expect(r.stopReason).toBe('tool_use');
    expect(r.toolCalls).toEqual([
      { id: 't1', name: 'search_local_exact', args: { query: '細草微風岸' } },
    ]);
  });

  it('survives malformed tool arguments and carries the error forward', async () => {
    const p = provider(
      fakeGateway(
        completion({
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 't1',
                    type: 'function',
                    function: { name: 'search_google', arguments: '{"q": unquoted}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      ),
    );
    const r = await p.complete({ model: 'm', messages: [] }, new AbortController().signal);
    expect(r.flags).toContain(BAD_TOOL_ARGS);
    const args = r.toolCalls[0]!.args as { __parseError?: string; __raw?: string };
    expect(args.__parseError).toBeTruthy();
    expect(args.__raw).toBe('{"q": unquoted}');
  });
});

describe('degraded gateways', () => {
  it('reports missing usage as degraded rather than as zero cost', async () => {
    const p = provider(fakeGateway(completion({ usage: undefined })), {
      'test-model': { inputPerMTok: 1, outputPerMTok: 1 },
    });
    const r = await p.complete({ model: 'test-model', messages: [] }, new AbortController().signal);
    expect(r.flags).toContain(USAGE_UNAVAILABLE);
    expect(r.usage.inputTokens).toBe(0);
    expect(r.usage.costUsd).toBeNull();
  });

  it('prices a known model and refuses to price an unknown one', async () => {
    const priced = provider(fakeGateway(completion()), {
      'test-model': { inputPerMTok: 2, outputPerMTok: 10 },
    });
    const r = await priced.complete(
      { model: 'test-model', messages: [] },
      new AbortController().signal,
    );
    expect(r.usage.costUsd).toBeCloseTo((10 / 1e6) * 2 + (5 / 1e6) * 10);

    const unpriced = provider(fakeGateway(completion({ model: 'mystery-model' })));
    const u = await unpriced.complete(
      { model: 'mystery-model', messages: [] },
      new AbortController().signal,
    );
    expect(u.usage.costUsd).toBeNull();
  });

  it('throws a typed error when the gateway returns no choices', async () => {
    const p = provider(fakeGateway(completion({ choices: [] })));
    await expect(
      p.complete({ model: 'm', messages: [] }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'LLM_EMPTY_RESPONSE' });
  });

  it('maps a 429 to UNAVAILABLE, not to a generic error', async () => {
    const p = provider(fakeGateway({ error: { message: 'rate limited' } }, { status: 429 }));
    await expect(
      p.complete({ model: 'm', messages: [] }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'TOOL_UNAVAILABLE' });
  });

  it('honours an AbortSignal and reports it as a timeout', async () => {
    const ac = new AbortController();
    const slow = vi.fn(
      () =>
        new Promise<Response>((_, reject) => {
          ac.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );
    const p = provider(slow as never);
    const pending = p.complete({ model: 'm', messages: [] }, ac.signal);
    ac.abort();
    await expect(pending).rejects.toMatchObject({ code: 'TOOL_TIMEOUT' });
  });

  it('round-trips CJK without mojibake', async () => {
    const p = provider(
      fakeGateway(
        completion({
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '細草微風岸，危檣獨夜舟。' },
              finish_reason: 'stop',
            },
          ],
        }),
      ),
    );
    const r = await p.complete(
      { model: 'm', messages: [{ role: 'user', content: '杜甫' }] },
      new AbortController().signal,
    );
    expect(r.text).toBe('細草微風岸，危檣獨夜舟。');
  });

  it('sends a tool result back as a tool-role message', async () => {
    const spy = fakeGateway(completion());
    const p = provider(spy);
    await p.complete(
      {
        model: 'm',
        messages: [
          { role: 'user', content: 'where is this from' },
          {
            role: 'assistant',
            content: null,
            toolCalls: [{ id: 't1', name: 'search_local_exact', args: { query: 'x' } }],
          },
          { role: 'tool', content: '{"status":"no_result"}', toolCallId: 't1' },
        ],
      },
      new AbortController().signal,
    );
    const body = JSON.parse(
      String(
        (spy.mock.calls[0] as unknown[])[1]
          ? (((spy.mock.calls[0] as unknown[])[1] as { body?: string }).body ?? '{}')
          : '{}',
      ),
    );
    expect(body.messages[1].tool_calls[0].id).toBe('t1');
    expect(body.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 't1' });
  });
});
