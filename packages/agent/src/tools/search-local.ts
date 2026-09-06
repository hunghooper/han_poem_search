/**
 * search_local_exact and search_local_semantic — the spec §9.2.
 *
 * The agent gets the local corpus as tools too, not just as the thing that ran before it. It
 * may have rewritten the query, translated it, or realised the user meant a different poem,
 * and in each case it needs to search again with different input.
 */

import { z } from 'zod';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { exactNgramSearch } from '@han/retrieval/sources/exact-ngram';
import { hybridSearch } from '@han/retrieval/hybrid';
import type { ModelClient } from '@han/retrieval/model-client';
import type { VectorStore } from '@han/retrieval/vector-store';
import type { Evidence } from '@han/shared/evidence';
import { StepStatus } from '@han/shared/status';
import { okResult, type Tool, type ToolContext } from '../tool.js';

const ExactArgs = z.object({
  fragment: z.string().min(2).max(500),
});

export function createSearchLocalExactTool(db: NodePgDatabase<Record<string, never>>): Tool<z.infer<typeof ExactArgs>> {
  return {
    name: 'search_local_exact',
    source: 'exact',
    description:
      'Find a poem in the local corpus (全唐詩 and 宋詞) by an exact fragment of its text. ' +
      'GOOD FOR: a remembered line, even with wrong character order, missing punctuation, ' +
      'simplified/traditional mismatch, or a few wrong characters — it tolerates all of those. ' +
      'BAD FOR: descriptions of a poem, topics, moods, or anything not quoting the text. ' +
      'The corpus is Tang and Song Chinese only: no Vietnamese Han-Nom, no Ming or Qing verse.',
    inputSchema: ExactArgs,
    jsonSchema: {
      type: 'object',
      properties: { fragment: { type: 'string', description: 'Characters quoted from the poem' } },
      required: ['fragment'],
    },
    timeoutMs: 8_000,

    async execute(args, ctx: ToolContext) {
      const started = ctx.now();
      const m = await exactNgramSearch(db, args.fragment);
      const byWork = new Map<string, Evidence>();
      for (const h of m.hits) {
        if (byWork.has(h.workId)) continue;
        byWork.set(h.workId, {
          id: h.workId,
          source: 'exact',
          retrievalMethod: 'exact_ngram',
          workId: h.workId,
          title: h.title,
          author: h.author,
          dynasty: null,
          edition: h.edition,
          provenance: { dataset: h.dataset, file: h.sourceFile, commitSha: h.commitSha },
          url: null,
          content: h.poemTextDisplay,
          matchedSpan: null,
          score: m.longestRun,
          rerankScore: null,
          metadata: { matchKind: m.kind, reordered: m.reading?.reordered ?? false },
        });
      }
      return okResult({ name: 'search_local_exact', source: 'exact' }, [...byWork.values()], ctx.now() - started);
    },
  };
}

const SemanticArgs = z.object({
  query: z.string().min(2).max(500),
});

export function createSearchLocalSemanticTool(
  db: NodePgDatabase<Record<string, never>>,
  model: ModelClient | null,
  vectors: VectorStore | null,
): Tool<z.infer<typeof SemanticArgs>> {
  return {
    name: 'search_local_semantic',
    source: 'hybrid',
    description:
      'Search the local corpus (全唐詩 and 宋詞) by topic, mood or description rather than exact ' +
      'wording. GOOD FOR: "poems about autumn moonlight", "a poem where a traveller misses home". ' +
      'BAD FOR: finding a specific poem from a quoted line — use search_local_exact for that, it ' +
      'is far more precise. Dense retrieval is weak on five-character classical lines, so treat ' +
      'a low-scoring result here as a hint rather than an answer.',
    inputSchema: SemanticArgs,
    jsonSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'A description of the poem you want' } },
      required: ['query'],
    },
    timeoutMs: 15_000,
    unavailableReason: () =>
      model && vectors ? null : 'the model sidecar or vector index is not available',

    async execute(args, ctx: ToolContext) {
      const started = ctx.now();
      const r = await hybridSearch(args.query, { db, model, vectors, topK: 8 });
      // A hybrid run that produced candidates but nothing convincing is LOW_CONFIDENCE, not
      // NO_RESULT — the agent must be able to tell "nothing there" from "nothing good enough".
      if (r.evidence.length > 0 && r.rerankScores.length > 0 && (r.rerankScores[0] ?? 0) < 0.35) {
        return {
          toolName: 'search_local_semantic',
          source: 'hybrid',
          status: StepStatus.LOW_CONFIDENCE,
          resultCount: r.evidence.length,
          results: r.evidence,
          latencyMs: ctx.now() - started,
          error: null,
        };
      }
      return okResult({ name: 'search_local_semantic', source: 'hybrid' }, r.evidence, ctx.now() - started);
    },
  };
}
