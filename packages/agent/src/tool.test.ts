import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { redactArgs, runTool, type Tool, type ToolContext } from './tool.js';
import { StepStatus } from '@han/shared/status';
import { AppError } from '@han/shared/errors';

const ctx = (signal?: AbortSignal): ToolContext => ({
  signal: signal ?? new AbortController().signal,
  debug: false,
  now: () => Date.now(),
});

const mk = (over: Partial<Tool<{ q: string }>> = {}): Tool<never> =>
  ({
    name: 'test_tool',
    source: 'google',
    description: 'test',
    inputSchema: z.object({ q: z.string() }),
    jsonSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    timeoutMs: 100,
    execute: async () => ({
      toolName: 'test_tool',
      source: 'google',
      status: StepStatus.NO_RESULT,
      resultCount: 0,
      results: [],
      latencyMs: 1,
      error: null,
    }),
    ...over,
  }) as unknown as Tool<never>;

describe('runTool — a tool NEVER throws (§5.4)', () => {
  it('classifies a thrown error as ERROR rather than propagating it', async () => {
    const r = await runTool(
      mk({ execute: () => Promise.reject(new AppError('INTERNAL', 'boom')) }),
      { q: 'x' },
      ctx(),
    );
    expect(r.status).toBe(StepStatus.ERROR);
    expect(r.error?.message).toBe('boom');
  });

  it('classifies a slow tool as TIMEOUT, never as NO_RESULT', async () => {
    const r = await runTool(
      mk({
        timeoutMs: 20,
        execute: (_a, c) =>
          new Promise((_res, rej) => {
            c.signal.addEventListener('abort', () => rej(new Error('aborted')));
          }),
      }),
      { q: 'x' },
      ctx(),
    );
    expect(r.status).toBe(StepStatus.TIMEOUT);
    expect(r.status).not.toBe(StepStatus.NO_RESULT);
    expect(r.error?.code).toBe('TOOL_TIMEOUT');
  });

  it('reports a disabled tool as UNAVAILABLE without running it', async () => {
    const execute = vi.fn();
    const r = await runTool(
      mk({ unavailableReason: () => 'no API key configured', execute }),
      { q: 'x' },
      ctx(),
    );
    expect(r.status).toBe(StepStatus.UNAVAILABLE);
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns invalid arguments to the model instead of throwing', async () => {
    const r = await runTool(mk(), { wrong: 1 }, ctx());
    expect(r.status).toBe(StepStatus.ERROR);
    expect(r.error?.code).toBe('LLM_BAD_TOOL_ARGS');
    expect(r.error?.message).toMatch(/invalid arguments/);
  });

  it('passes a clean run straight through', async () => {
    const r = await runTool(mk(), { q: 'x' }, ctx());
    expect(r.status).toBe(StepStatus.NO_RESULT);
    expect(r.error).toBeNull();
  });

  it('distinguishes a caller abort from the tool timing out', async () => {
    const ac = new AbortController();
    const pending = runTool(
      mk({
        timeoutMs: 60_000,
        execute: (_a, c) =>
          new Promise((_res, rej) => {
            c.signal.addEventListener('abort', () => rej(new Error('aborted')));
          }),
      }),
      { q: 'x' },
      ctx(ac.signal),
    );
    ac.abort();
    const r = await pending;
    expect(r.status).toBe(StepStatus.ERROR);
  });
});

describe('redactArgs', () => {
  it('redacts marked fields and leaves the rest', () => {
    const t = mk({ redact: ['apiKey'] });
    expect(redactArgs(t, { q: 'poem', apiKey: 'secret' })).toEqual({
      q: 'poem',
      apiKey: '[redacted]',
    });
  });

  it('is a no-op when nothing is marked', () => {
    expect(redactArgs(mk(), { q: 'poem' })).toEqual({ q: 'poem' });
  });
});
