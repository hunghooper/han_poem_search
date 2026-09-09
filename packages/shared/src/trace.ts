/**
 * Trace messages that can be read in a language other than the one they were written in.
 *
 * WHY THIS EXISTS. §17 puts Vietnamese, English and Chinese in scope, and the interface is
 * translated — but every sentence in the trace was built on the server as English prose and
 * shipped as a finished string. A Vietnamese reader got a Vietnamese page wrapped around an
 * English explanation of the one thing they most need to understand: why the system decided
 * what it decided.
 *
 * WHY NOT TRANSLATE ON THE SERVER. The event log is authoritative and replayable (§5.2). A run
 * is searched once and read many times — reopened later, folded into a batch export, looked at
 * by somebody else. If the server renders the sentence, the run is frozen in whatever language
 * it happened to be searched in, forever. So the server records WHAT IT MEANT and the reader
 * renders it.
 *
 * WHY THE MESSAGES COMPOSE. The prosody summary is built from its check details, which are
 * built from the rhyme and tone reasons. Flattening that into one code per final sentence would
 * need a code for every combination. `parts` keeps the nesting, and the renderer walks it.
 *
 * The English string still travels beside the code. It is what a log, an old event, or a reader
 * whose language lacks a label falls back to — never a raw key on screen.
 */

import { z } from 'zod';

/**
 * One trace message: a code, its values, and any messages composed into it.
 *
 * Zod cannot infer a recursive type, so the TS interface is declared and the schema is tied to
 * it with `z.ZodType`. Both are exported: the interface for producers, the schema for the wire.
 */
export interface TraceMsg {
  /** A key in the label tables. Unknown codes fall back to the English string. */
  code: string;
  /** Substituted into the template as `{name}`. */
  params?: Record<string, string | number>;
  /** Rendered and joined into the template's `{parts}`. */
  parts?: TraceMsg[];
}

export const TraceMsgSchema: z.ZodType<TraceMsg> = z.lazy(() =>
  z.object({
    code: z.string().min(1).max(80),
    params: z.record(z.union([z.string(), z.number()])).optional(),
    parts: z.array(TraceMsgSchema).max(12).optional(),
  }),
);

/** Convenience for the producers, which build these inline and often. */
export const msg = (
  code: string,
  params?: Record<string, string | number>,
  parts?: TraceMsg[],
): TraceMsg => ({
  code,
  ...(params ? { params } : {}),
  ...(parts ? { parts } : {}),
});

/** How `parts` are joined when a template has no separator of its own. */
const PART_SEPARATOR = '; ';

/**
 * Render a message into one language.
 *
 * `lookup` returns the template for a code, or null when the language has no label for it —
 * which is the case that matters. A missing label must produce the English fallback, not
 * `trace.someCode` on screen: a reader seeing a raw key learns nothing, while a reader seeing
 * English at least learns what happened.
 */
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
    // An unfilled placeholder is a producer bug. Leaving the literal `{name}` visible is the
    // honest failure: it says a value was expected and is missing, rather than quietly
    // rendering a sentence with a hole where a number should be.
    return v === undefined ? whole : String(v);
  });
}

/**
 * Every code any producer can emit.
 *
 * This list is the contract, and `i18n.test.ts` checks each language against it. That test is
 * the whole reason the list exists: a code added on the server with no label added beside it
 * shows up as English inside a Vietnamese page, which reads as a bug in the translation rather
 * than the omission it is — and nothing else would catch it.
 */
export const TRACE_CODES = [
  // query and normalisation
  'trace.readingQuery',
  'trace.colophon',
  'trace.colophonDated',
  'trace.normalised',
  'trace.searching',

  // one retrieval source reporting in
  'trace.src.skippedShort',
  'trace.src.skipped',
  'trace.src.unavailable',
  'trace.src.timeout',
  'trace.src.failed',
  'trace.src.none',
  'trace.src.count',
  // Used when a source has no label of its own; it carries the raw name instead.
  'trace.src.noneRaw',
  'trace.src.countRaw',
  'trace.srcName.exact',
  'trace.srcName.bm25',
  'trace.srcName.vector',
  'trace.srcName.reranker',

  // the confidence policy explaining itself
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

  // prosody: the summary, its checks, and the reasons underneath
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

  // the agent
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

  // one tool reporting back, from inside the durable workflow
  'trace.tool.count',
  'trace.tool.none',
  'trace.tool.lowConfidence',
  'trace.tool.timeout',
  'trace.tool.unavailable',
  'trace.tool.failed',
  'trace.tool.other',

  // the verifier, and what it proposed
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

  // the answer line
  'trace.answer.none',
  'trace.answer.nothingMatches',
  'trace.answer.local',
  'trace.answer.outside',
  'trace.answer.partialSuffix',
] as const;

export type TraceCode = (typeof TRACE_CODES)[number];
