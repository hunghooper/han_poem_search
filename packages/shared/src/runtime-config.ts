/**
 * Runtime configuration — the single definition of what is tunable, shared by the API and the
 * UI so neither can drift from the other.
 *
 * TWO KINDS OF SETTING, and the distinction is load-bearing:
 *
 *   Committed defaults live in `config/runtime.yaml` and are the source of truth. They are the
 *   values every run uses unless someone deliberately says otherwise.
 *
 *   Session overrides come from the UI, travel with a single request, and are NEVER persisted
 *   server-side. CONTRIBUTING.md is explicit that retrieval thresholds "must not be changed
 *   without a calibration run recorded in an ADR", and §8 calls the current numbers
 *   provisional and uncalibrated. A settings panel that quietly rewrote the committed
 *   thresholds would turn "it felt better on a few queries" into the project's configuration,
 *   which is exactly what that rule exists to prevent. So the panel is an EXPERIMENT surface:
 *   change what you like, see what it does, and the next run by anyone else is unaffected.
 *
 * Every numeric carries bounds. An override arrives from a browser, so it is untrusted input,
 * and a threshold of 1e9 or -1 must be rejected at the boundary rather than quietly wedging
 * the confidence policy.
 */

import { z } from 'zod';

export const UI_LANGUAGES = ['vi', 'en', 'zh'] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];

/** exact_ngram is deliberately absent: it is the primary retriever (§7.1), not an option. */
export const SourcesSchema = z.object({
  bm25: z.boolean().default(true),
  vector: z.boolean().default(true),
  reranker: z.boolean().default(true),
});

/** Retrieval shape — how wide the search casts and which sources take part. */
export const RetrievalConfigSchema = z.object({
  /** Candidates into the reranker (§7.2 default 50). */
  fuseTopN: z.number().int().min(1).max(200).default(50),
  /** Results out (§7.2 default 8). */
  topK: z.number().int().min(1).max(50).default(8),
  /** RRF constant; larger flattens the contribution of rank (§7.2). */
  rrfK: z.number().int().min(1).max(1000).default(60),
  /** Index probes per candidate reading — bounds the reorder fan-out (ADR 003). */
  maxWindowsPerReading: z.number().int().min(10).max(2000).default(400),
  /** Candidate readings tried. The first is always `as_written`. */
  maxReadings: z.number().int().min(1).max(24).default(12),
  sources: SourcesSchema.default({}),
});
export type RetrievalConfig = z.infer<typeof RetrievalConfigSchema>;

/** Confidence policy (§8). PROVISIONAL AND UNCALIBRATED — see the note above. */
export const ConfidenceConfigSchema = z.object({
  verifyFloor: z.number().min(0).max(1).default(0.6),
  noiseFloor: z.number().min(0).max(1).default(0.35),
  minAgreeingWindows: z.number().int().min(1).max(10).default(2),
  minLexicalOverlap: z.number().min(0).max(1).default(0.15),
});
export type ConfidenceConfig = z.infer<typeof ConfidenceConfigSchema>;

/** Agent budgets (§12). */
export const AgentConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxIterations: z.number().int().min(1).max(20).default(6),
  maxToolCalls: z.number().int().min(1).max(40).default(12),
  maxWallClockMs: z.number().int().min(1000).max(300_000).default(60_000),
  maxCostUsd: z.number().min(0).max(20).default(0.5),
  /** Skip the agent when the query shares no characters with any candidate. */
  skipWhenNoOverlap: z.boolean().default(true),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

/**
 * Model ids are opaque gateway-specific strings (§4.1 rule 5) — hence z.string(), not an enum.
 * The API reports which ids the gateway actually serves so the UI can offer a list without
 * this schema ever knowing one.
 */
export const ModelConfigSchema = z.object({
  reasoning: z.string().min(1).nullable().default(null),
  answer: z.string().min(1).nullable().default(null),
  verify: z.string().min(1).nullable().default(null),
  rewrite: z.string().min(1).nullable().default(null),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

/** Presentation. Not sent to the server on a search — the browser owns these. */
export const UiConfigSchema = z.object({
  language: z.enum(UI_LANGUAGES).default('vi'),
  /** 直書 — vertical right-to-left, how the poem was originally set. */
  vertical: z.boolean().default(false),
  /** Shows per-step latency, scores, provider, model and raw flags (§14.3). */
  debug: z.boolean().default(false),
  /** Collapse trace steps that did not run. */
  hideSkipped: z.boolean().default(false),
});
export type UiConfig = z.infer<typeof UiConfigSchema>;

export const RuntimeConfigSchema = z.object({
  retrieval: RetrievalConfigSchema.default({}),
  confidence: ConfidenceConfigSchema.default({}),
  agent: AgentConfigSchema.default({}),
  models: ModelConfigSchema.default({}),
  ui: UiConfigSchema.default({}),
});
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

/** What a single search may override. `ui` is absent: presentation never reaches the server. */
export const OverridesSchema = z
  .object({
    // .partial() does not recurse, so `sources` has to be made partial explicitly — without
    // this the TYPE demands all three toggles while the runtime happily accepts one, and the
    // two disagree about the same object.
    retrieval: RetrievalConfigSchema.partial()
      .extend({ sources: SourcesSchema.partial().optional() })
      .optional(),
    confidence: ConfidenceConfigSchema.partial().optional(),
    agent: AgentConfigSchema.partial().optional(),
    models: ModelConfigSchema.partial().optional(),
  })
  .strict();
export type Overrides = z.infer<typeof OverridesSchema>;

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = RuntimeConfigSchema.parse({});

/** Merge session overrides onto the committed defaults. Shallow per section, by design:
 *  a section the caller did not mention keeps every committed value. */
export function applyOverrides(base: RuntimeConfig, over: Overrides | undefined): RuntimeConfig {
  if (!over) return base;
  return {
    retrieval: { ...base.retrieval, ...over.retrieval, sources: { ...base.retrieval.sources, ...over.retrieval?.sources } },
    confidence: { ...base.confidence, ...over.confidence },
    agent: { ...base.agent, ...over.agent },
    models: { ...base.models, ...over.models },
    ui: base.ui,
  };
}
