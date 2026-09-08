/**
 * What a poem must carry before it may enter the corpus.
 *
 * ONE definition, in the package both sides already depend on. The browser checks a file
 * before anything is uploaded so a person sees the refusals immediately; the server checks it
 * again because a browser check is a convenience, not a guard. Two copies of these rules would
 * drift, and the drift would show up as a row the screen accepted and the server rejected —
 * or worse, the other way round.
 *
 * WHY THEY ARE STRICT. Every result this system returns can say where it came from: a corpus
 * result carries a dataset, a file and a commit; an outside result carries a URL; a model's
 * answer is flagged as a model's answer. An added poem has none of that behind it and will sit
 * in the same index as 78,455 poems that do, returned just as confidently. Without a title and
 * an author it is not a record, it is a fragment.
 */

import { z } from 'zod';

export const REQUIRED_FIELDS = ['title', 'author', 'text'] as const;
export const OPTIONAL_FIELDS = ['dynasty', 'form', 'note', 'source_url'] as const;

export type RequiredField = (typeof REQUIRED_FIELDS)[number];

/**
 * Reasons a row is refused. A code, not a sentence: the sentence belongs to whichever language
 * the reader has chosen, and lives in the UI's label table.
 */
export type RefusalCode =
  | 'title'
  | 'author'
  | 'text'
  | 'text_han'
  | 'text_long'
  | 'title_long';

export interface RowCheck {
  index: number;
  ok: boolean;
  missing: RefusalCode[];
  title: string;
  author: string;
  /** Han characters in the text, which is what the corpus actually indexes. */
  chars: number;
}

const HAN = /\p{Script=Han}/u;

export const hanCount = (s: string): number =>
  [...String(s ?? '')].filter((c) => HAN.test(c)).length;

/**
 * Shortest thing worth indexing. Below four Han characters a "poem" matches half the corpus by
 * coincidence — the same reasoning that gives the exact matcher its five-character floor.
 */
export const MIN_HAN_CHARS = 4;

/** Guards against a whole book pasted into one row, which is a mistake rather than a poem. */
export const MAX_HAN_CHARS = 4000;
export const MAX_TITLE_CHARS = 200;

export function checkRow(row: Record<string, unknown>, index: number): RowCheck {
  const get = (k: string): string => String(row[k] ?? '').trim();
  const missing: RefusalCode[] = REQUIRED_FIELDS.filter((f) => get(f).length === 0);

  const title = get('title');
  const text = get('text');
  const chars = hanCount(text);

  // Only complain about the CONTENT of a field that is present. "text is missing" and "text is
  // there but is not Han verse" are different problems and a reader fixes them differently.
  if (!missing.includes('text')) {
    if (chars < MIN_HAN_CHARS) missing.push('text_han');
    else if (chars > MAX_HAN_CHARS) missing.push('text_long');
  }
  if (!missing.includes('title') && title.length > MAX_TITLE_CHARS) missing.push('title_long');

  return { index, ok: missing.length === 0, missing, title, author: get('author'), chars };
}

/**
 * The wire shape of one submitted poem.
 *
 * `.strict()` on purpose: a field this schema does not know is a field nobody agreed to store,
 * and silently dropping it would let a submitter believe their data went in.
 */
export const CorpusAdditionSchema = z
  .object({
    title: z.string().min(1).max(MAX_TITLE_CHARS),
    author: z.string().min(1).max(200),
    text: z.string().min(1),
    dynasty: z.string().max(100).nullish(),
    form: z.string().max(100).nullish(),
    note: z.string().max(2000).nullish(),
    source_url: z.string().url().nullish(),
  })
  .strict()
  .refine((v) => hanCount(v.text) >= MIN_HAN_CHARS, {
    message: `text must contain at least ${MIN_HAN_CHARS} Han characters`,
    path: ['text'],
  })
  .refine((v) => hanCount(v.text) <= MAX_HAN_CHARS, {
    message: `text must contain at most ${MAX_HAN_CHARS} Han characters`,
    path: ['text'],
  });

export type CorpusAddition = z.infer<typeof CorpusAdditionSchema>;

/** Where a poem came in from. Recorded on the row, and carried into every export. */
export const AdditionOrigin = {
  /** Not added — it came with the corpus. */
  NONE: 'no',
  /** A person uploaded it and vouches for it. */
  USER: 'user',
  /** The verifier proposed it from a run. Never indexed until a person accepts. */
  AGENT: 'agent',
} as const;

export type AdditionOrigin = (typeof AdditionOrigin)[keyof typeof AdditionOrigin];

/**
 * Review state. An agent proposal starts `pending` and is invisible to search until somebody
 * accepts it — see docs/plans/corpus-enrichment.md for why the verifier may propose and may
 * not write.
 */
export const AdditionStatus = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
} as const;

export type AdditionStatus = (typeof AdditionStatus)[keyof typeof AdditionStatus];
