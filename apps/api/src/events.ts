/**
 * Event emission and the run store.
 *
 * The event log is authoritative (§11). Everything the UI shows is a fold over it, so a step
 * that does not emit is a step the user cannot see — including failures. Emitting is therefore
 * not optional bookkeeping; it is the observability contract from §1's second failure mode.
 */

import { randomUUID } from 'node:crypto';
import type { SearchEvent, SearchStep } from '@han/shared/events';
import type { StepStatus } from '@han/shared/status';
import type { TraceMsg } from '@han/shared/trace';
import { nullSink, type EventSink, type RunRecord } from './event-sink.js';

export interface EmitInput {
  step: SearchStep;
  source: string;
  phase: 'started' | 'completed' | 'failed';
  status?: StepStatus;
  flags?: string[];
  /** Which agent iteration produced this, for the trace (§5.2). */
  agentIteration?: number;
  message?: string;
  /** The same message as a code the reader's language can render — see @han/shared/trace. */
  messageTrace?: TraceMsg;
  metadata?: SearchEvent['metadata'];
}

type Listener = (e: SearchEvent) => void;

/**
 * In-memory run store. Phase 4 moves this behind Redis for fan-out across API instances
 * (§14.1); the interface is deliberately the same so that swap does not touch callers.
 */
export class RunStore {
  private readonly events = new Map<string, SearchEvent[]>();
  private readonly outcomes = new Map<string, unknown>();
  private readonly listeners = new Map<string, Set<Listener>>();

  /**
   * Memory is the READ path — the live WebSocket stream and reconnect replay both serve from
   * it, and a database round trip per reconnect would be a poor trade. The sink is a
   * write-through so the log outlives the process (§11).
   */
  constructor(private readonly sink: EventSink = nullSink) {}

  create(query = ''): string {
    const runId = randomUUID();
    this.events.set(runId, []);
    this.sink.runStarted(runId, query);
    return runId;
  }

  emit(runId: string, input: EmitInput): SearchEvent {
    const list = this.events.get(runId) ?? [];
    const event: SearchEvent = {
      eventId: randomUUID(),
      runId,
      seq: list.length,
      ts: new Date().toISOString(),
      step: input.step,
      source: input.source,
      phase: input.phase,
      ...(input.status ? { status: input.status } : {}),
      flags: input.flags ?? [],
      ...(input.agentIteration !== undefined ? { agentIteration: input.agentIteration } : {}),
      ...(input.message ? { message: input.message } : {}),
      ...(input.messageTrace ? { messageTrace: input.messageTrace } : {}),
      metadata: input.metadata ?? {},
    };
    list.push(event);
    this.events.set(runId, list);
    // Subscribers first, sink second: the user is waiting on the stream, not on the write.
    for (const l of this.listeners.get(runId) ?? []) l(event);
    this.sink.event(event);
    return event;
  }

  /** Everything after `afterSeq`. This is what makes reconnect lossless (§14.1). */
  since(runId: string, afterSeq: number): SearchEvent[] {
    return (this.events.get(runId) ?? []).filter((e) => e.seq > afterSeq);
  }

  /** The settled result. Kept beside the log, never in place of it — the log stays authoritative. */
  setOutcome(runId: string, outcome: unknown): void {
    this.outcomes.set(runId, outcome);
  }

  /** Materialize search_run.final_* (§11). The fold over the events must reproduce these. */
  finalize(record: RunRecord): void {
    this.sink.runFinished(record);
  }

  /** Flush pending writes — for tests and graceful shutdown. */
  flush(): Promise<void> {
    return this.sink.drain();
  }

  outcome(runId: string): unknown {
    return this.outcomes.get(runId) ?? null;
  }

  has(runId: string): boolean {
    return this.events.has(runId);
  }

  subscribe(runId: string, listener: Listener): () => void {
    const set = this.listeners.get(runId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(runId, set);
    return () => set.delete(listener);
  }
}
