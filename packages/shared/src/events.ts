/**
 * Search events — the spec §5.2. FROZEN CONTRACT.
 *
 * The event log is append-only and authoritative. Never UPDATE an event; corrections are
 * new events (§11). SearchRunState must be derivable by folding this stream — see state.ts.
 */

import { z } from 'zod';
import { StepStatus } from './status.js';

export const SearchStep = z.enum([
  'query_understanding',
  'normalization',
  'local_search',
  'exact',
  'bm25',
  'vector',
  'hybrid',
  'reranker',
  'local_evaluation',
  'agent',
  'tool_call',
  'aggregation',
  'rule_verification',
  'llm_verification',
  'final_answer',
]);
export type SearchStep = z.infer<typeof SearchStep>;

export const EventPhase = z.enum(['started', 'completed', 'failed']);
export type EventPhase = z.infer<typeof EventPhase>;

export const EventMetadataSchema = z
  .object({
    latencyMs: z.number().optional(),
    resultCount: z.number().optional(),
    topScore: z.number().optional(),
    confidence: z.number().min(0).max(1).optional(),
    query: z.string().optional(),
    normalizedQuery: z.string().optional(),
    rewrittenQuery: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    tokensIn: z.number().optional(),
    tokensOut: z.number().optional(),
    costUsd: z.number().optional(),
    retryCount: z.number().optional(),
    errorCode: z.string().optional(),
    errorMessage: z.string().optional(),
  })
  .default({});
export type EventMetadata = z.infer<typeof EventMetadataSchema>;

export const SearchEventSchema = z.object({
  eventId: z.string().uuid(),
  runId: z.string().uuid(),
  seq: z.number().int().nonnegative(), // monotonic per run; the UI orders by this
  ts: z.string().datetime(),
  step: SearchStep,
  source: z.string(),
  phase: EventPhase,
  status: z.nativeEnum(StepStatus).optional(),
  flags: z.array(z.string()).default([]),
  agentIteration: z.number().int().nonnegative().optional(),
  message: z.string().optional(), // human-readable, shown in the simple UI
  metadata: EventMetadataSchema,
});

export type SearchEvent = z.infer<typeof SearchEventSchema>;
