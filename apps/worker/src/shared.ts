/**
 * Types crossing the workflow/activity boundary.
 *
 * Everything here is serialised by Temporal and replayed from history, so it must be plain
 * JSON: no class instances, no functions, no Dates. Keeping the shapes in one file makes that
 * constraint visible rather than something each new field has to remember.
 */

import type { TraceMsg } from '@han/shared/trace';
import type { Evidence } from '@han/shared/evidence';
import type { StepStatus } from '@han/shared/status';
import type { RuntimeConfig } from '@han/shared/runtime-config';
import type { SourceSummary } from '@han/agent/state';

/** What the API hands the workflow to start an agent run. */
export interface AgentRunInput {
  runId: string;
  query: string;
  /** Flags and per-source outcomes from the local retrieval that already ran. */
  flags: string[];
  sources: SourceSummary[];
  /** Committed defaults with this request's session overrides already applied. */
  config: RuntimeConfig;
  debug: boolean;
}

export interface AgentRunOutput {
  evidence: Evidence[];
  flags: string[];
  stoppedBecause: string;
  /**
   * Why it stopped, in words, for the one terminal event the caller emits.
   *
   * Returned rather than emitted from inside the workflow on purpose. A terminal event
   * emitted by the workflow races its own return: the caller tears the Redis relay down the
   * instant the workflow resolves, and an event still in flight is simply lost. That is not a
   * cosmetic loss — the run whose agent gave up would report no reason at all, which §11's
   * authoritative log cannot afford. Progress events, which are not in that race, still go
   * out as they happen.
   */
  stopDetail?: string;
  partial: boolean;
  iterations: number;
}

/** A decision the reasoning model made — the activity returns data, never a live object. */
export interface ReasonResult {
  text: string | null;
  toolCalls: Array<{ id: string; name: string; args: unknown }>;
  provider: string;
  model: string;
  costUsd: number | null;
  flags: string[];
  /** Serialised assistant turn, so the workflow can build the next request without an SDK. */
  messages: Array<{ role: string; content: string | null; toolCalls?: unknown; toolCallId?: string }>;
}

export interface ToolCallResult {
  toolName: string;
  source: string;
  status: StepStatus;
  resultCount: number;
  results: Evidence[];
  latencyMs: number;
  error: { code: string; message: string } | null;
  costUsd: number | null | undefined;
}

/**
 * An event the workflow wants recorded and streamed.
 *
 * Emission is I/O, so it is an activity — but the workflow decides WHAT is emitted and in what
 * order, which is what keeps the trace a faithful account of the run rather than of the
 * worker's scheduling.
 */
export interface WorkflowEvent {
  runId: string;
  step: 'agent' | 'tool_call';
  source: string;
  phase: 'started' | 'completed' | 'failed';
  status?: StepStatus;
  flags?: string[];
  agentIteration?: number;
  message: string;
  /** The same message as a code the reader's language can render (@han/shared/trace). */
  messageTrace?: TraceMsg;
  metadata?: Record<string, unknown>;
}
