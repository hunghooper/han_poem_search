import { z } from 'zod';

export const UI_LANGUAGES = ['vi', 'en', 'zh'] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];

export const SourcesSchema = z.object({
  bm25: z.boolean().default(true),
  vector: z.boolean().default(true),
  reranker: z.boolean().default(true),
});

export const RetrievalConfigSchema = z.object({
  fuseTopN: z.number().int().min(1).max(200).default(50),
  topK: z.number().int().min(1).max(50).default(8),
  rrfK: z.number().int().min(1).max(1000).default(60),
  maxWindowsPerReading: z.number().int().min(10).max(2000).default(400),
  maxReadings: z.number().int().min(1).max(24).default(12),
  sources: SourcesSchema.default({}),
});
export type RetrievalConfig = z.infer<typeof RetrievalConfigSchema>;

export const ConfidenceConfigSchema = z.object({
  verifyFloor: z.number().min(0).max(1).default(0.6),
  noiseFloor: z.number().min(0).max(1).default(0.35),
  minAgreeingWindows: z.number().int().min(1).max(10).default(2),
  minLexicalOverlap: z.number().min(0).max(1).default(0.15),
});
export type ConfidenceConfig = z.infer<typeof ConfidenceConfigSchema>;

export const AgentConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxIterations: z.number().int().min(1).max(20).default(6),
  maxToolCalls: z.number().int().min(1).max(40).default(12),
  maxWallClockMs: z.number().int().min(1000).max(300_000).default(60_000),
  maxCostUsd: z.number().min(0).max(20).default(0.5),
  skipWhenNoOverlap: z.boolean().default(true),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const ModelConfigSchema = z.object({
  reasoning: z.string().min(1).nullable().default(null),
  answer: z.string().min(1).nullable().default(null),
  verify: z.string().min(1).nullable().default(null),
  rewrite: z.string().min(1).nullable().default(null),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export const UiConfigSchema = z.object({
  language: z.enum(UI_LANGUAGES).default('vi'),
  vertical: z.boolean().default(false),
  debug: z.boolean().default(false),
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

export const OverridesSchema = z
  .object({
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

export function applyOverrides(base: RuntimeConfig, over: Overrides | undefined): RuntimeConfig {
  if (!over) return base;
  return {
    retrieval: {
      ...base.retrieval,
      ...over.retrieval,
      sources: { ...base.retrieval.sources, ...over.retrieval?.sources },
    },
    confidence: { ...base.confidence, ...over.confidence },
    agent: { ...base.agent, ...over.agent },
    models: { ...base.models, ...over.models },
    ui: base.ui,
  };
}
