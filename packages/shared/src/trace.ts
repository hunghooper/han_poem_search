import { z } from 'zod';

export interface TraceMsg {
  code: string;
  params?: Record<string, string | number>;
  parts?: TraceMsg[];
}

export const TraceMsgSchema: z.ZodType<TraceMsg> = z.lazy(() =>
  z.object({
    code: z.string().min(1).max(80),
    params: z.record(z.union([z.string(), z.number()])).optional(),
    parts: z.array(TraceMsgSchema).max(12).optional(),
  }),
);

export const msg = (
  code: string,
  params?: Record<string, string | number>,
  parts?: TraceMsg[],
): TraceMsg => ({
  code,
  ...(params ? { params } : {}),
  ...(parts ? { parts } : {}),
});

const PART_SEPARATOR = '; ';

export function renderTrace(
  m: TraceMsg | null | undefined,
  lookup: (code: string) => string | null,
  fallback: string | null = null,
): string | null {
  if (!m) return fallback;
  const template = lookup(m.code);
  if (template === null) return fallback;

  const parts = (m.parts ?? [])
    .map((p) => renderTrace(p, lookup, null))
    .filter((s): s is string => s !== null && s.length > 0);

  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    if (name === 'parts') return parts.join(PART_SEPARATOR);
    const v = m.params?.[name];
    return v === undefined ? whole : String(v);
  });
}

export const TRACE_CODES = [
  'trace.readingQuery',
  'trace.colophon',
  'trace.colophonDated',
  'trace.normalised',
  'trace.searching',

  'trace.src.skippedShort',
  'trace.src.skipped',
  'trace.src.unavailable',
  'trace.src.timeout',
  'trace.src.failed',
  'trace.src.none',
  'trace.src.count',
  'trace.src.noneRaw',
  'trace.src.countRaw',
  'trace.srcName.exact',
  'trace.srcName.bm25',
  'trace.srcName.vector',
  'trace.srcName.reranker',

  'trace.conf.exactBelowFloor',
  'trace.conf.exactSingle',
  'trace.conf.exactAmbiguous',
  'trace.conf.windowsAgree',
  'trace.conf.noCandidates',
  'trace.conf.unscored',
  'trace.conf.overlapBelowFloor',
  'trace.conf.belowNoiseFloor',
  'trace.conf.scoredClears',
  'trace.conf.scoredBetween',

  'trace.verify.failed',
  'trace.verify.passed',
  'trace.verify.abstained',
  'trace.verify.formReordered',
  'trace.verify.formMatches',
  'trace.verify.formDiffers',
  'trace.verify.notRegulated',
  'trace.verify.shapeGuess',
  'trace.verify.toneBroken',
  'trace.rhyme.tooFew',
  'trace.rhyme.notInTable',
  'trace.rhyme.share',
  'trace.rhyme.differ',
  'trace.tone.tooFew',
  'trace.tone.clean',
  'trace.tone.broken',
  'trace.nothingToVerify',

  'trace.agent.off',
  'trace.agent.noGateway',
  'trace.agent.tookOver',
  'trace.agent.noRelay',
  'trace.agent.skippedNoOverlap',
  'trace.agent.failed',
  'trace.agent.found',
  'trace.agent.stopped',
  'trace.agent.chose',
  'trace.agent.finishing',

  'trace.tool.count',
  'trace.tool.none',
  'trace.tool.lowConfidence',
  'trace.tool.timeout',
  'trace.tool.unavailable',
  'trace.tool.failed',
  'trace.tool.other',

  'trace.judge.checking',
  'trace.judge.unreachable',
  'trace.judge.sufficient',
  'trace.judge.insufficient',
  'trace.judge.conflicting',
  'trace.judge.proposed',
  'trace.judge.declined',
  'trace.propose.notSufficient',
  'trace.propose.localAnswered',
  'trace.propose.urlNotRetrieved',
  'trace.propose.failsRules',
  'trace.propose.duplicate',

  'trace.answer.none',
  'trace.answer.nothingMatches',
  'trace.answer.local',
  'trace.answer.outside',
  'trace.answer.partialSuffix',
] as const;

export type TraceCode = (typeof TRACE_CODES)[number];
