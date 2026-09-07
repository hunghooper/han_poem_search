import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runAgent, AGENT_BUDGET_EXHAUSTED, type AgentDeps, type AgentEvent } from './loop.js';
import { initialAgentState, compact, type AgentState } from './state.js';
import { DEFAULT_BUDGET } from './budget.js';
import { runTool, type Tool } from './tool.js';
import { StepStatus } from '@han/shared/status';
import type { LlmProvider, LlmResponse } from '@han/llm/provider';

const llmResponse = (over: Partial<LlmResponse> = {}): LlmResponse => ({
  text: null,
  toolCalls: [],
  stopReason: 'end_turn',
  usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
  model: 'test-model',
  provider: 'fake',
  raw: {},
  flags: [],
  ...over,
});

const scriptedProvider = (responses: LlmResponse[]): LlmProvider => {
  let i = 0;
  return {
    name: 'fake',
    supportsTools: true,
    supportsStreaming: false,
    complete: () => Promise.resolve(responses[Math.min(i++, responses.length - 1)]!),
  };
};

const evidenceItem = (source: string, n: number) => ({
  id: `${source}-${n}`,
  source,
  retrievalMethod: 'agent_web_search' as const,
  workId: `w${n}`,
  title: '旅夜書懷',
  author: '杜甫',
  dynasty: '唐',
  edition: null,
  provenance: null,
  url: null,
  content: '細草微風岸，危檣獨夜舟。',
  matchedSpan: null,
  score: 1,
  rerankScore: null,
  metadata: {},
});

const fakeTool = (name: string, status: StepStatus, count = 0): Tool<never> =>
  ({
    name,
    source: name,
    description: `${name} test tool`,
    inputSchema: z.object({ q: z.string().optional() }),
    jsonSchema: { type: 'object', properties: { q: { type: 'string' } } },
    timeoutMs: 1000,
    execute: async () => ({
      toolName: name,
      source: name,
      status,
      resultCount: count,
      results: Array.from({ length: count }, (_, n) => evidenceItem(name, n)),
      latencyMs: 5,
      error: null,
    }),
  }) as unknown as Tool<never>;

const deps = (over: Partial<AgentDeps>): AgentDeps => ({
  provider: scriptedProvider([llmResponse()]),
  model: 'test-model',
  tools: [fakeTool('search_thivien', StepStatus.NO_RESULT)],
  budget: DEFAULT_BUDGET,
  now: () => Date.now(),
  emit: () => {},
  debug: false,
  signal: new AbortController().signal,
  ...over,
});

const state = (): AgentState => initialAgentState('Vietnamese Han-Nom poem', ['no_local_result'], []);
const toolCall = (name: string) =>
  llmResponse({ stopReason: 'tool_use', toolCalls: [{ id: 't1', name, args: {} }] });

describe('runAgent', () => {
  it('stops when the model chooses to finish', async () => {
    const events: AgentEvent[] = [];
    const out = await runAgent(state(), deps({ emit: (e) => events.push(e) }), runTool);
    expect(out.stoppedBecause).toBe('model_finished');
    expect(out.partial).toBe(false);
    expect(events.some((e) => e.kind === 'llm_call')).toBe(true);
  });

  it('calls the tool the model selected and stops once satisfied', async () => {
    const out = await runAgent(
      state(),
      deps({
        provider: scriptedProvider([toolCall('search_thivien')]),
        tools: [fakeTool('search_thivien', StepStatus.HAS_RESULT, 2)],
      }),
      runTool,
    );
    expect(out.stoppedBecause).toBe('satisfied');
    expect(out.state.evidence).toHaveLength(2);
    expect(out.state.flags).toContain('search_thivien_has_result');
  });

  it('stops on budget exhaustion and marks the answer partial (§12)', async () => {
    const events: AgentEvent[] = [];
    const out = await runAgent(
      state(),
      deps({
        provider: scriptedProvider([toolCall('search_thivien')]),
        budget: { ...DEFAULT_BUDGET, maxIterations: 2 },
        emit: (e) => events.push(e),
      }),
      runTool,
    );
    expect(out.stoppedBecause).toBe('budget_exhausted');
    expect(out.partial).toBe(true);
    expect(out.flags).toContain(AGENT_BUDGET_EXHAUSTED);
    // Never fails silently: exhaustion is an event, not only a return value.
    expect(events.some((e) => e.kind === 'budget_exhausted')).toBe(true);
  });

  it('does not offer a tool that cannot run', async () => {
    const disabled = fakeTool('search_google', StepStatus.NO_RESULT);
    (disabled as unknown as { unavailableReason: () => string }).unavailableReason = () => 'no API key';
    const out = await runAgent(state(), deps({ tools: [disabled] }), runTool);
    // Offering it would spend an iteration learning what config already knew.
    expect(out.stoppedBecause).toBe('no_tools_available');
  });

  it('hands a hallucinated tool name back to the model instead of ending the run', async () => {
    const out = await runAgent(
      state(),
      deps({ provider: scriptedProvider([toolCall('search_nonexistent'), llmResponse({ text: 'giving up' })]) }),
      runTool,
    );
    expect(out.stoppedBecause).toBe('model_finished');
  });

  it('reports a tool timeout as a timeout, never as nothing found', async () => {
    const events: AgentEvent[] = [];
    await runAgent(
      state(),
      deps({
        provider: scriptedProvider([toolCall('search_thivien'), llmResponse({ text: 'done' })]),
        tools: [fakeTool('search_thivien', StepStatus.TIMEOUT)],
        emit: (e) => events.push(e),
      }),
      runTool,
    );
    const call = events.find((e) => e.kind === 'tool_call');
    expect(call?.status).toBe(StepStatus.TIMEOUT);
    expect(call?.message).toMatch(/did NOT search/);
  });

  it('records which provider and model served each call', async () => {
    const events: AgentEvent[] = [];
    await runAgent(state(), deps({ emit: (e) => events.push(e) }), runTool);
    const llm = events.find((e) => e.kind === 'llm_call');
    expect(llm?.provider).toBe('fake');
    expect(llm?.model).toBe('test-model');
  });
});

describe('satisfaction is judged on what the AGENT found', () => {
  // REGRESSION, seen against the live gateway. The agent is seeded with the local retrieval
  // summaries so the model can see what has been tried. Judging satisfaction from those meant
  // the agent saw bm25/vector reporting has_result — the very results local evaluation had
  // just called insufficient — and declared success on its first pass, immediately after its
  // one tool call had TIMED OUT. It stopped having achieved nothing and reported success.
  it('does not treat the seeded local results as its own success', async () => {
    const seeded = initialAgentState('a query', ['local_low_confidence'], [
      { source: 'bm25', status: StepStatus.HAS_RESULT, resultCount: 50, latencyMs: 1267 },
      { source: 'vector', status: StepStatus.HAS_RESULT, resultCount: 50, latencyMs: 793 },
    ]);
    const out = await runAgent(
      seeded,
      deps({
        provider: scriptedProvider([toolCall('search_thivien'), llmResponse({ text: 'nothing more to try' })]),
        tools: [fakeTool('search_thivien', StepStatus.TIMEOUT)],
      }),
      runTool,
    );
    // It must keep going after the timeout, then stop because the MODEL finished.
    expect(out.stoppedBecause).toBe('model_finished');
    expect(out.state.evidence).toHaveLength(0);
  });

  it('stops as satisfied only once a tool actually returned evidence', async () => {
    const seeded = initialAgentState('a query', [], [
      { source: 'bm25', status: StepStatus.HAS_RESULT, resultCount: 50, latencyMs: 10 },
    ]);
    const out = await runAgent(
      seeded,
      deps({
        provider: scriptedProvider([toolCall('search_thivien')]),
        tools: [fakeTool('search_thivien', StepStatus.HAS_RESULT, 3)],
      }),
      runTool,
    );
    expect(out.stoppedBecause).toBe('satisfied');
    expect(out.state.evidence).toHaveLength(3);
  });
});

describe('the loop knows nothing about specific tools (§9.2)', () => {
  it('never branches on a tool name — adding a tool requires zero loop changes', () => {
    const src = readFileSync(new URL('./loop.ts', import.meta.url), 'utf8');
    for (const name of [
      'search_local_exact',
      'search_local_semantic',
      'search_thivien',
      'search_ctext',
      'search_souyun',
      'search_google',
      'ask_model',
      'verify_results',
    ]) {
      expect(src.includes(`'${name}'`), `loop.ts references ${name}`).toBe(false);
      expect(src.includes(`"${name}"`), `loop.ts references ${name}`).toBe(false);
    }
  });
});

describe('compaction keeps raw evidence out of the reasoning context (§9.1)', () => {
  it('truncates content to a snippet', () => {
    const long = { ...evidenceItem('thivien', 1), content: '細草微風岸，危檣獨夜舟。'.repeat(20) };
    const c = compact({ ...state(), evidence: [long] });
    expect(c.candidates[0]!.snippet.length).toBeLessThanOrEqual(40);
    expect(JSON.stringify(c).length).toBeLessThan(1000);
  });

  it('caps how many candidates reach the model', () => {
    const many = Array.from({ length: 50 }, (_, i) => evidenceItem('bm25', i));
    expect(compact({ ...state(), evidence: many }).candidates).toHaveLength(5);
  });
});

describe('failures never leave the run unfinished', () => {
  // REGRESSION, seen live. When the reasoning call threw, the error escaped runAgent, escaped
  // the search pipeline, and was swallowed by a .catch() in the server. No final_answer event
  // was ever emitted, so the client waited forever — indistinguishable from a slow run. §1
  // calls opaque failure unacceptable, and this was the most opaque failure available.
  it('converts a reasoning-model failure into a partial outcome instead of throwing', async () => {
    const events: AgentEvent[] = [];
    const exploding: LlmProvider = {
      name: 'fake',
      supportsTools: true,
      supportsStreaming: false,
      complete: () => Promise.reject(Object.assign(new Error('gateway exploded'), { code: 'INTERNAL' })),
    };
    const out = await runAgent(state(), deps({ provider: exploding, emit: (e) => events.push(e) }), runTool);
    expect(out.stoppedBecause).toBe('budget_exhausted');
    expect(out.partial).toBe(true);
    expect(out.flags).toContain(AGENT_BUDGET_EXHAUSTED);
    expect(events.at(-1)?.message).toMatch(/reasoning model failed/);
  });

  it('reports an aborted reasoning call rather than hanging', async () => {
    const aborting: LlmProvider = {
      name: 'fake',
      supportsTools: true,
      supportsStreaming: false,
      complete: () => Promise.reject(Object.assign(new Error('request aborted'), { code: 'TOOL_TIMEOUT' })),
    };
    const out = await runAgent(state(), deps({ provider: aborting }), runTool);
    expect(out.partial).toBe(true);
  });
});
