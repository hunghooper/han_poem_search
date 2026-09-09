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
  agentIteration?: number;
  message?: string;
  messageTrace?: TraceMsg;
  metadata?: SearchEvent['metadata'];
}

type Listener = (e: SearchEvent) => void;

export class RunStore {
  private readonly events = new Map<string, SearchEvent[]>();
  private readonly outcomes = new Map<string, unknown>();
  private readonly listeners = new Map<string, Set<Listener>>();

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
    for (const l of this.listeners.get(runId) ?? []) l(event);
    this.sink.event(event);
    return event;
  }

  since(runId: string, afterSeq: number): SearchEvent[] {
    return (this.events.get(runId) ?? []).filter((e) => e.seq > afterSeq);
  }

  setOutcome(runId: string, outcome: unknown): void {
    this.outcomes.set(runId, outcome);
  }

  finalize(record: RunRecord): void {
    this.sink.runFinished(record);
  }

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
