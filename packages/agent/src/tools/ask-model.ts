/**
 * ask_model — the spec §9.2.
 *
 * Direct model knowledge, CLEARLY FLAGGED AS UNSOURCED. This is the tool most likely to
 * produce a confident wrong answer, because a model asked about an obscure Tang poem will
 * generally produce something poem-shaped rather than admit ignorance.
 *
 * So its Evidence carries retrievalMethod 'model', a null provenance, and a null url — and
 * §10.3 requires the answer to flag `model_has_result` when it leans on this. A citation-free
 * answer without that flag is a bug (`final_answer_uncited`).
 */

import { z } from 'zod';
import type { LlmProvider } from '@han/llm/provider';
import { StepStatus } from '@han/shared/status';
import { okResult, type Tool, type ToolContext } from '../tool.js';

const Args = z.object({
  // 500 was arbitrary and too small: the model wrote a longer question, the call was rejected,
  // and an agent iteration was spent learning our own limit.
  question: z.string().min(1).max(4000),
});

export function createAskModelTool(provider: LlmProvider | null, model: string | null): Tool<z.infer<typeof Args>> {
  return {
    name: 'ask_model',
    source: 'model',
    description:
      'Ask the language model directly, from its own training. GOOD FOR: well-known poems, ' +
      'famous poets, general historical context, and translation. BAD FOR: obscure works, ' +
      'exact wording, attribution disputes, and anything where being wrong matters — the model ' +
      'will produce a plausible poem rather than admit it does not know. Results from this tool ' +
      'are UNSOURCED and are marked as such to the user.',
    inputSchema: Args,
    jsonSchema: {
      type: 'object',
      properties: { question: { type: 'string', description: 'The question to ask' } },
      required: ['question'],
    },
    // Must fit INSIDE the agent's wall-clock budget (§12: 60s), or the tool can never finish
    // and every call is cut off by the run rather than by its own timeout. Reasoning models
    // also need room to think before emitting, so the token budget rises as the clock falls —
    // a generous token budget is useless if the wall clock ends the call first.
    timeoutMs: 25_000,
    unavailableReason: () =>
      provider && model ? null : 'no LLM provider configured — set RAMCLOUDS_API_KEY and LLM_MODEL_ANSWER',

    async execute(args, ctx: ToolContext) {
      const started = ctx.now();
      const res = await provider!.complete(
        {
          model: model!,
          messages: [
            {
              role: 'system',
              content:
                'Answer about classical Chinese poetry from your own knowledge. If you are not ' +
                'confident, say so plainly rather than guessing — a wrong attribution is worse ' +
                'than no answer. Do not invent poem text.',
            },
            { role: 'user', content: args.question },
          ],
          maxTokens: 2048,
        },
        ctx.signal,
      );

      const text = res.text?.trim();
      if (!text) return okResult({ name: 'ask_model', source: 'model' }, [], ctx.now() - started);

      return {
        toolName: 'ask_model',
        source: 'model',
        status: StepStatus.HAS_RESULT,
        resultCount: 1,
        results: [
          {
            id: `model:${res.model}`,
            source: 'model',
            retrievalMethod: 'model' as const,
            workId: null,
            title: null,
            author: null,
            dynasty: null,
            edition: null,
            // Null provenance is the point: there is no source file and no commit to cite.
            provenance: null,
            url: null,
            content: text,
            matchedSpan: null,
            score: 0,
            rerankScore: null,
            metadata: { unsourced: true, provider: res.provider, model: res.model },
          },
        ],
        latencyMs: ctx.now() - started,
        error: null,
        ...(ctx.debug ? { raw: res.raw } : {}),
      };
    },
  };
}
