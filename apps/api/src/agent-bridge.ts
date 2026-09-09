/**
 * Bridge between the Temporal worker and this API's event stream — §14.1, Phase 4.
 *
 * The worker is a separate process, so the WebSocket subscribers it needs to reach are not in
 * its memory. §14.1 answers this: "With multiple API instances, fan out through Redis." The
 * worker publishes each workflow event to `run:<runId>`; every API instance subscribes for the
 * runs it is serving and re-emits into its own RunStore, which fans out to sockets and writes
 * the durable copy.
 *
 * Redis is optional. Without it the agent still runs to completion and its evidence still
 * reaches the answer — only the intermediate trace is missing, and the run says so rather than
 * appearing to stall.
 */

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

  /**
   * Relay this run's workflow events until `stop()` is called.
   *
   * Subscribing per run rather than to a pattern keeps an API instance from re-emitting events
   * for runs another instance is serving — which would duplicate them in that run's log, and
   * (run_id, seq) would reject the duplicates while the seq numbers silently diverged.
   */
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
        // A malformed message must not tear down the relay and silence the rest of the run.
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
