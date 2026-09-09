import { z } from 'zod';
import { StepStatus } from './status.js';
import { EvidenceSchema } from './evidence.js';

export const ToolErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type ToolError = z.infer<typeof ToolErrorSchema>;

export const ToolResultSchema = z.object({
  toolName: z.string(),
  source: z.string(),
  status: z.nativeEnum(StepStatus),
  resultCount: z.number().int().nonnegative(),
  results: z.array(EvidenceSchema),
  latencyMs: z.number(),
  error: ToolErrorSchema.nullable(),
  raw: z.unknown().optional(), // debug mode only — must never reach the default UI
});

export type ToolResult = z.infer<typeof ToolResultSchema>;

export const assertConsistent = (r: ToolResult): ToolResult => {
  const hasRows = r.results.length > 0;
  if (r.status === StepStatus.NO_RESULT && hasRows) {
    throw new Error(`${r.toolName}: NO_RESULT with ${r.results.length} results`);
  }
  if (r.status === StepStatus.HAS_RESULT && !hasRows) {
    throw new Error(`${r.toolName}: HAS_RESULT with no results`);
  }
  if (r.resultCount !== r.results.length) {
    throw new Error(
      `${r.toolName}: resultCount ${r.resultCount} != results.length ${r.results.length}`,
    );
  }
  return r;
};
