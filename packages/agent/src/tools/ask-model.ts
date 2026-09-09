import { z } from 'zod';
import type { LlmProvider } from '@han/llm/provider';
import { StepStatus } from '@han/shared/status';
import { okResult, type Tool, type ToolContext } from '../tool.js';

const Args = z.object({
  question: z.string().min(1).max(4000),
});

export function createAskModelTool(
  provider: LlmProvider | null,
  model: string | null,
): Tool<z.infer<typeof Args>> {
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
    timeoutMs: 40_000,
    unavailableReason: () =>
      provider && model
        ? null
        : 'no LLM provider configured — set RAMCLOUDS_API_KEY and LLM_MODEL_ANSWER',

    async execute(args, ctx: ToolContext) {
      const started = ctx.now();
      const res = await provider!.complete(
        {
          model: model!,
          messages: [
            {
              role: 'system',
              content:
                'Answer about classical Chinese poetry from your own knowledge. Be BRIEF: at ' +
                'most 80 words. Give the title, author and origin, nothing more. If you are not ' +
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
            provenance: null,
            url: null,
            content: text,
            matchedSpan: null,
            score: 0,
            rerankScore: null,
            metadata: {
              unsourced: true,
              provider: res.provider,
              model: res.model,
              costUsd: res.usage.costUsd,
              inputTokens: res.usage.inputTokens,
              outputTokens: res.usage.outputTokens,
            },
          },
        ],
        latencyMs: ctx.now() - started,
        error: null,
        ...(ctx.debug ? { raw: res.raw } : {}),
      };
    },
  };
}
