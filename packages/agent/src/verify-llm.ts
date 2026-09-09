import { z } from 'zod';
import type { LlmProvider } from '@han/llm/provider';
import type { Evidence } from '@han/shared/evidence';

export const ProposalSchema = z.object({
  title: z.string().min(1).max(200),
  author: z.string().min(1).max(200),
  text: z.string().min(1).max(8000),
  dynasty: z.string().max(100).nullish(),
  source_url: z.string().max(500).nullish(),
});

export type Proposal = z.infer<typeof ProposalSchema>;

export const VerdictSchema = z.object({
  verdict: z.enum(['sufficient', 'insufficient', 'conflicting']),
  confidence: z.number().min(0).max(1),
  gaps: z.array(z.string()).max(6).default([]),
  notes: z.string().max(600).default(''),
  propose: ProposalSchema.nullish(),
});

export type Verdict = z.infer<typeof VerdictSchema>;

export interface VerifyResult {
  verdict: Verdict;
  costUsd: number | null;
  model: string;
  provider: string;
}

const SYSTEM = `You judge whether a body of evidence identifies a piece of classical Chinese poetry. You do not search and you have no tools; you only read what is in front of you.

Answer with JSON only, no prose around it:
{"verdict":"sufficient"|"insufficient"|"conflicting","confidence":0.0-1.0,"gaps":["..."],"notes":"..."}

  sufficient    the evidence names one work, and the evidence supports that naming
  insufficient  the evidence does not settle it — including when a model REFUSED to identify
                the text, said it did not recognise it, or said the input looked corrupted.
                A refusal is not a finding.
  conflicting   the sources name different works and nothing decides between them

Judge the EVIDENCE, not the plausibility of the query. A confident-sounding sentence with no
work named is insufficient. A candidate that shares few characters with the query is
insufficient however fluent the prose around it.

OPTIONALLY, add "propose": {"title","author","text","dynasty","source_url"} — but ONLY when
ALL of these hold:

  - your verdict is "sufficient"
  - the identified poem came from an OUTSIDE source in the evidence, not from the local corpus
  - that outside source gave a real URL
  - you can copy the poem's text, title and author from the evidence rather than recalling them

If you are working from memory rather than from a source in the evidence, do not propose. Omit
the field or set it to null; null is the normal answer.

`;

export async function verifyWithLlm(
  input: { query: string; evidence: readonly Evidence[]; flags: readonly string[] },
  deps: { provider: LlmProvider; model: string; signal: AbortSignal },
): Promise<VerifyResult | null> {
  const shown = input.evidence.slice(0, 6).map((e, i) => ({
    n: i + 1,
    source: e.source,
    method: e.retrievalMethod,
    title: e.title,
    author: e.author,
    text: e.content.slice(0, 240),
  }));

  const user = [
    `QUERY (what the user pasted):\n${input.query.slice(0, 600)}`,
    `\nFLAGS the run recorded: ${input.flags.join(', ') || '(none)'}`,
    `\nEVIDENCE:\n${JSON.stringify(shown, null, 1)}`,
  ].join('\n');

  try {
    const res = await deps.provider.complete(
      {
        model: deps.model,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: user },
        ],
        maxTokens: 2048,
      },
      deps.signal,
    );

    const parsed = parseVerdict(res.text);
    if (!parsed) return null;
    return {
      verdict: parsed,
      costUsd: res.usage.costUsd,
      model: res.model,
      provider: res.provider,
    };
  } catch {
    return null;
  }
}

export function parseVerdict(text: string | null): Verdict | null {
  if (!text) return null;
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return VerdictSchema.parse(JSON.parse(text.slice(start, i + 1)));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
