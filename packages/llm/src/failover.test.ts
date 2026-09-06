import { describe, expect, it, vi } from 'vitest';
import { isFailoverWorthy, withFailover, LLM_FAILOVER } from './failover.js';
import { AppError } from '@han/shared/errors';
import type { LlmProvider, LlmResponse } from './provider.js';

const ok = (name: string): LlmResponse => ({
  text: 'answer',
  toolCalls: [],
  stopReason: 'end_turn',
  usage: { inputTokens: 1, outputTokens: 1, costUsd: null },
  model: 'm',
  provider: name,
  raw: {},
  flags: [],
});

const fake = (name: string, impl: () => Promise<LlmResponse>, caps = { tools: true, streaming: true }): LlmProvider => ({
  name,
  supportsTools: caps.tools,
  supportsStreaming: caps.streaming,
  complete: impl,
});

const working = (name: string) => fake(name, () => Promise.resolve(ok(name)));
const failing = (name: string, code: 'TOOL_TIMEOUT' | 'TOOL_UNAVAILABLE' | 'INTERNAL' | 'CONFIG_INVALID') =>
  fake(name, () => Promise.reject(new AppError(code, `${name} failed`)));

describe('isFailoverWorthy', () => {
  it('fails over on timeout, unavailable and internal errors', () => {
    for (const code of ['TOOL_TIMEOUT', 'TOOL_UNAVAILABLE', 'INTERNAL'] as const) {
      expect(isFailoverWorthy(new AppError(code, 'x'))).toBe(true);
    }
  });

  it('does not fail over on a bad request — the other provider would fail identically', () => {
    expect(isFailoverWorthy(new AppError('CONFIG_INVALID', 'x'))).toBe(false);
    expect(isFailoverWorthy(new Error('plain'))).toBe(false);
  });
});

describe('withFailover', () => {
  it('uses the primary when it works, and never touches the fallback', async () => {
    const fb = vi.fn(() => Promise.resolve(ok('fallback')));
    const p = withFailover({ primary: working('primary'), fallback: fake('fallback', fb) });
    const r = await p.complete({ model: 'm', messages: [] }, new AbortController().signal);
    expect(r.provider).toBe('primary');
    expect(r.flags).not.toContain(LLM_FAILOVER);
    expect(fb).not.toHaveBeenCalled();
  });

  it('fails over once and records which provider actually served the call', async () => {
    // §4.4: with failover on, "which model produced this answer" is otherwise unanswerable.
    const onFailover = vi.fn();
    const p = withFailover({
      primary: failing('primary', 'TOOL_UNAVAILABLE'),
      fallback: working('fallback'),
      onFailover,
    });
    const r = await p.complete({ model: 'm', messages: [] }, new AbortController().signal);
    expect(r.provider).toBe('fallback');
    expect(r.flags).toContain(LLM_FAILOVER);
    expect(onFailover).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'primary', to: 'fallback' }),
    );
  });

  it('does not fail over when no fallback is configured', async () => {
    const p = withFailover({ primary: failing('primary', 'INTERNAL') });
    await expect(p.complete({ model: 'm', messages: [] }, new AbortController().signal)).rejects.toMatchObject({
      code: 'INTERNAL',
    });
  });

  it('propagates a non-failover error rather than trying the fallback', async () => {
    const fb = vi.fn(() => Promise.resolve(ok('fallback')));
    const p = withFailover({ primary: failing('primary', 'CONFIG_INVALID'), fallback: fake('fallback', fb) });
    await expect(p.complete({ model: 'm', messages: [] }, new AbortController().signal)).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    expect(fb).not.toHaveBeenCalled();
  });

  it('does not fail over after the caller has aborted — failover buys no extra time', async () => {
    const ac = new AbortController();
    ac.abort();
    const fb = vi.fn(() => Promise.resolve(ok('fallback')));
    const p = withFailover({ primary: failing('primary', 'TOOL_TIMEOUT'), fallback: fake('fallback', fb) });
    await expect(p.complete({ model: 'm', messages: [] }, ac.signal)).rejects.toBeTruthy();
    expect(fb).not.toHaveBeenCalled();
  });

  it('reports capabilities as the intersection', async () => {
    // Claiming a capability the fallback lacks would fail only after failover, in production.
    const p = withFailover({
      primary: working('primary'),
      fallback: fake('fallback', () => Promise.resolve(ok('fallback')), { tools: false, streaming: true }),
    });
    expect(p.supportsTools).toBe(false);
    expect(p.supportsStreaming).toBe(true);
  });
});
