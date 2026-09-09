import type { TraceMsg } from '@han/shared/trace';
import { Redis } from 'ioredis';
import type { SearchStep } from '@han/shared/events';
import type { StepStatus } from '@han/shared/status';
import type { RunStore } from './events.js';

interface WorkflowEvent {
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

export class AgentEventBridge {
  private readonly sub: Redis | null;

  constructor(
    redisUrl: string | undefined,
    private readonly store: RunStore,
    private readonly onError: (e: unknown) => void,
  ) {
    this.sub = redisUrl ? new Redis(redisUrl) : null;
    this.sub?.on('error', (e) => this.onError(e));
  }

  get available(): boolean {
    return this.sub !== null;
  }

  async relay(runId: string): Promise<() => Promise<void>> {
    if (!this.sub) return async () => {};
    const channel = `run:${runId}`;
    const conn = this.sub.duplicate();

    conn.on('message', (_ch, payload) => {
      try {
        const e = JSON.parse(payload) as WorkflowEvent;
        this.store.emit(runId, {
          step: e.step as SearchStep,
          source: e.source,
          phase: e.phase,
          ...(e.status ? { status: e.status } : {}),
          flags: e.flags ?? [],
          ...(e.agentIteration !== undefined ? { agentIteration: e.agentIteration } : {}),
          message: e.message,
          ...(e.messageTrace ? { messageTrace: e.messageTrace } : {}),
          metadata: (e.metadata ?? {}) as never,
        });
      } catch (err) {
        this.onError(err);
      }
    });

    await conn.subscribe(channel);
    return async () => {
      await conn.unsubscribe(channel).catch(() => {});
      conn.disconnect();
    };
  }

  async close(): Promise<void> {
    this.sub?.disconnect();
  }
}
