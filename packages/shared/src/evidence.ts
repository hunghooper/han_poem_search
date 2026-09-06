/**
 * Evidence — the spec §5.3. FROZEN CONTRACT.
 *
 * Every result from every source is normalized into this shape before aggregation.
 * No exceptions.
 */

import { z } from 'zod';

export const RetrievalMethod = z.enum([
  'exact_ngram',
  'bm25',
  'vector',
  'hybrid',
  'agent_web_search',
  'agent_api',
  'model',
]);
export type RetrievalMethod = z.infer<typeof RetrievalMethod>;

/**
 * Provenance is required for local results (§3.1 item 4). The upstream corpus is crawled
 * from the web and contains OCR errors and disputed readings — we surface what the dataset
 * says, pinned to a commit, never "the truth".
 */
export const ProvenanceSchema = z.object({
  dataset: z.string(),
  file: z.string(),
  commitSha: z.string(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const MatchedSpanSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});
export type MatchedSpan = z.infer<typeof MatchedSpanSchema>;

export const EvidenceSchema = z.object({
  id: z.string(),
  source: z.string(),
  retrievalMethod: RetrievalMethod,
  workId: z.string().nullable(), // stable across editions — see §3.1 item 5
  title: z.string().nullable(),
  author: z.string().nullable(),
  dynasty: z.string().nullable(),
  edition: z.string().nullable(), // e.g. "全唐詩" vs "御定全唐詩"
  provenance: ProvenanceSchema.nullable(),
  url: z.string().url().nullable(),
  content: z.string(), // textDisplay — never textMatch
  matchedSpan: MatchedSpanSchema.nullable(),
  score: z.number(),
  rerankScore: z.number().nullable(),
  metadata: z.record(z.unknown()).default({}),
});

export type Evidence = z.infer<typeof EvidenceSchema>;
