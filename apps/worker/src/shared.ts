import type { TraceMsg } from '@han/shared/trace';
import type { Evidence } from '@han/shared/evidence';
import type { StepStatus } from '@han/shared/status';
import type { RuntimeConfig } from '@han/shared/runtime-config';
import type { SourceSummary } from '@han/agent/state';

export interface AgentRunInput {
  runId: string;
  query: string;
  flags: string[];
  sources: SourceSummary[];
  config: RuntimeConfig;
  debug: boolean;
}

export interface AgentRunOutput {
  evidence: Evidence[];
  flags: string[];
  stoppedBecause: string;
  stopDetail?: string;
  partial: boolean;
  iterations: number;
}

export interface ReasonResult {
  text: string | null;
  toolCalls: Array<{ id: string; name: string; args: unknown }>;
  provider: string;
  model: string;
  costUsd: number | null;
  flags: string[];
  messages: Array<{
    role: string;
    content: string | null;
    toolCalls?: unknown;
    toolCallId?: string;
  }>;
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

export interface WorkflowEvent {
  runId: string;
  step: 'agent' | 'tool_call';
  source: string;
  phase: 'started' | 'completed' | 'failed';
  status?: StepStatus;
  flags?: string[];
  agentIteration?: number;
  message: string;
  messageTrace?: TraceMsg;
  metadata?: Record<string, unknown>;
}
