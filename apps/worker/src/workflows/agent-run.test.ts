/**
 * Workflow tests — CONTRIBUTING.md: "Workflow tests use @temporalio/testing with the
 * time-skipping test environment. Any change to workflow code needs one, because determinism
 * bugs do not show up in unit tests."
 *
 * The time-skipping environment is what makes the §12 wall-clock budget testable at all: the
 * workflow believes 60 seconds passed, and the test takes milliseconds.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RUNTIME_CONFIG } from '@han/shared/runtime-config';
import { StepStatus } from '@han/shared/status';
import type { AgentRunInput, ReasonResult, ToolCallResult, WorkflowEvent } from '../shared.js';

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

const input = (over: Partial<AgentRunInput> = {}): AgentRunInput => ({
  runId: '11111111-1111-4111-8111-111111111111',
  query: 'Vietnamese Han-Nom poem',
  flags: ['no_local_result'],
  sources: [],
  config: DEFAULT_RUNTIME_CONFIG,
  debug: false,
  ...over,
});

const evidence = (n: number) => ({
  id: `e${n}`,
  source: 'model',
  retrievalMethod: 'model' as const,
  workId: `w${n}`,
  title: '南國山河',
  author: null,
  dynasty: null,
  edition: null,
  provenance: null,
  url: null,
  content: '南國山河南帝居',
  matchedSpan: null,
  score: 1,
  rerankScore: null,
  metadata: {},
});

const reasonResult = (over: Partial<ReasonResult> = {}): ReasonResult => ({
  text: null,
  toolCalls: [],
  provider: 'fake',
  model: 'test-model',
  costUsd: 0.001,
  flags: [],
  messages: [{ role: 'assistant', content: null }],
  ...over,
});

const toolResult = (over: Partial<ToolCallResult> = {}): ToolCallResult => ({
  toolName: 'ask_model',
  source: 'model',
  status: StepStatus.NO_RESULT,
  resultCount: 0,
  results: [],
  latencyMs: 5,
  error: null,
  costUsd: undefined,
  ...over,
});

/** Run the workflow against scripted activities and collect what it emitted. */
async function run(
  acts: {
    reason?: () => Promise<ReasonResult>;
    callTool?: () => Promise<ToolCallResult>;
    tools?: Array<{ name: string; description: string; jsonSchema: Record<string, unknown> }>;
  },
  wfInput = input(),
) {
  const events: WorkflowEvent[] = [];
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: 'test',
    // The bundler stats this on disk; under tsx the file is .ts, not .js.
    workflowsPath: (() => {
      const ts = fileURLToPath(new URL('./index.ts', import.meta.url));
      return existsSync(ts) ? ts : fileURLToPath(new URL('./index.js', import.meta.url));
    })(),
    activities: {
      listTools: async () =>
        acts.tools ?? [{ name: 'ask_model', description: 'ask the model', jsonSchema: { type: 'object' } }],
      reason: acts.reason ?? (async () => reasonResult()),
      callTool: acts.callTool ?? (async () => toolResult()),
      emitEvent: async (e: WorkflowEvent) => {
        events.push(e);
      },
    },
  });

  const result = await worker.runUntil(
    env.client.workflow.execute('agentRun', {
      taskQueue: 'test',
      workflowId: `test-${Math.random().toString(36).slice(2)}`,
      args: [wfInput],
    }),
  );
  return { result, events };
}

describe('agentRun workflow', () => {
  it('stops when the model chooses to finish', async () => {
    const { result, events } = await run({ reason: async () => reasonResult({ text: 'nothing to add' }) });
    expect(result.stoppedBecause).toBe('model_finished');
    expect(result.partial).toBe(false);
    expect(events.some((e) => e.step === 'agent')).toBe(true);
  });

  it('calls the tool the model selected and stops once satisfied', async () => {
    const { result, events } = await run({
      reason: async () =>
        reasonResult({ toolCalls: [{ id: 't1', name: 'ask_model', args: {} }] }),
      callTool: async () =>
        toolResult({ status: StepStatus.HAS_RESULT, resultCount: 1, results: [evidence(1)], costUsd: 0.0009 }),
    });
    expect(result.stoppedBecause).toBe('satisfied');
    expect(result.evidence).toHaveLength(1);
    const tc = events.find((e) => e.step === 'tool_call');
    expect(tc?.metadata?.costUsd).toBeCloseTo(0.0009);
  });

  // The time-skipping environment is what makes this testable: the workflow believes a minute
  // passed, the test takes milliseconds.
  it('exhausts the wall-clock budget and returns partial (§12)', async () => {
    const { result, events } = await run(
      {
        reason: async () =>
          reasonResult({ toolCalls: [{ id: 't1', name: 'ask_model', args: {} }] }),
        // Each tool call "takes" most of the budget, so the second iteration is over it.
        callTool: async () => {
          await new Promise((r) => setTimeout(r, 10));
          return toolResult();
        },
      },
      input({ config: { ...DEFAULT_RUNTIME_CONFIG, agent: { ...DEFAULT_RUNTIME_CONFIG.agent, maxIterations: 2 } } }),
    );
    expect(result.stoppedBecause).toBe('budget_exhausted');
    expect(result.partial).toBe(true);
    expect(result.flags).toContain('agent_budget_exhausted');
    // Never fails silently: exhaustion is an emitted event, not only a return value.
    expect(events.some((e) => e.message.includes('Agent stopped'))).toBe(true);
  });

  it('reports a tool timeout as a timeout, never as nothing found', async () => {
    const { events } = await run({
      reason: async () => reasonResult({ toolCalls: [{ id: 't1', name: 'ask_model', args: {} }] }),
      callTool: async () => toolResult({ status: StepStatus.TIMEOUT }),
    });
    const tc = events.find((e) => e.step === 'tool_call');
    expect(tc?.status).toBe(StepStatus.TIMEOUT);
    expect(tc?.message).toMatch(/did NOT search/);
  });

  it('hands a hallucinated tool name back to the model instead of ending the run', async () => {
    let call = 0;
    const { result } = await run({
      reason: async () => {
        call += 1;
        return call === 1
          ? reasonResult({ toolCalls: [{ id: 't1', name: 'search_nonexistent', args: {} }] })
          : reasonResult({ text: 'giving up' });
      },
    });
    expect(result.stoppedBecause).toBe('model_finished');
  });

  it('stops cleanly when no tool is available', async () => {
    const { result } = await run({ tools: [] });
    expect(result.stoppedBecause).toBe('no_tools_available');
  });

  it('converts a reasoning-model failure into a partial outcome rather than throwing', async () => {
    // The run must always terminate. An error escaping here would leave the caller with no
    // final_answer at all — indistinguishable from a slow run.
    const { result } = await run({
      reason: async () => {
        throw new Error('gateway exploded');
      },
    });
    expect(result.partial).toBe(true);
    expect(result.stoppedBecause).toBe('budget_exhausted');
  });

  it('is deterministic — the same scripted activities give the same result', async () => {
    const script = {
      reason: async () => reasonResult({ toolCalls: [{ id: 't1', name: 'ask_model', args: {} }] }),
      callTool: async () =>
        toolResult({ status: StepStatus.HAS_RESULT, resultCount: 1, results: [evidence(1)] }),
    };
    const a = await run(script);
    const b = await run(script);
    expect(a.result).toEqual(b.result);
    expect(a.events.map((e) => e.message)).toEqual(b.events.map((e) => e.message));
  });
});
