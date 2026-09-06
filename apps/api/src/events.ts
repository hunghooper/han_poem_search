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

export interface EmitInput {
  step: SearchStep;
  source: string;
  phase: 'started' | 'completed' | 'failed';
  status?: StepStatus;
  flags?: string[];
  message?: string;
  metadata?: SearchEvent['metadata'];
}

type Listener = (e: SearchEvent) => void;

/**
 * In-memory run store. Phase 4 moves this behind Redis for fan-out across API instances
 * (§14.1); the interface is deliberately the same so that swap does not touch callers.
 */
export class RunStore {
  private readonly events = new Map<string, SearchEvent[]>();
  private readonly listeners = new Map<string, Set<Listener>>();

  create(): string {
    const runId = randomUUID();
    this.events.set(runId, []);
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
      ...(input.message ? { message: input.message } : {}),
      metadata: input.metadata ?? {},
    };
    list.push(event);
    this.events.set(runId, list);
    for (const l of this.listeners.get(runId) ?? []) l(event);
    return event;
  }

  /** Everything after `afterSeq`. This is what makes reconnect lossless (§14.1). */
  since(runId: string, afterSeq: number): SearchEvent[] {
    return (this.events.get(runId) ?? []).filter((e) => e.seq > afterSeq);
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
