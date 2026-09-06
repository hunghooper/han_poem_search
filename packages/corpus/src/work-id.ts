/**
 * workId derivation — the spec §3.1 item 5.
 *
 * The brief requires a workId "stable across editions", but the upstream data does not supply
 * one. Verified against the pinned corpus:
 *
 *   全唐诗/poet.*.json   has a uuid `id`, but it is per-record, not per-work
 *   宋词/ci.song.*.json  has NO id field at all
 *   御定全唐詩/json/*    has NO id field at all
 *
 * So the key is derived from content. This is a PROVISIONAL rule — see ADR 004. True edition
 * linking needs a similarity pass, because two editions of the same poem differ by exactly the
 * textual variants we are trying to surface, and a hash cannot be tolerant of that.
 */

import { createHash } from 'node:crypto';
import { toMatchForm } from '@han/retrieval/normalize';

export interface WorkKeyInput {
  author: string | null;
  title: string | null;
  /** Match-form text of the first 句. */
  firstLine: string;
}

/**
 * Author + title + first line, all in match form.
 *
 * Author and title alone are not enough: 無題 and 雜詩 recur across hundreds of poems, and 詞
 * titles are 詞牌 shared by every poet who used the form. The first line disambiguates those.
 * It also means an edition whose variant falls in the first line will NOT link — accepted for
 * now, and the reason ADR 004 marks this provisional.
 */
export function deriveWorkKey(input: WorkKeyInput): string {
  const parts = [
    toMatchForm(input.author ?? ''),
    toMatchForm(input.title ?? ''),
    input.firstLine,
  ];
  return createHash('sha256').update(parts.join('|'), 'utf8').digest('hex').slice(0, 32);
}

/** Ingest idempotency key (§13): the full record, so any textual change re-ingests. */
export function contentHash(edition: string, sourceFile: string, textMatch: string, title: string | null): string {
  return createHash('sha256')
    .update([edition, sourceFile, title ?? '', textMatch].join('|'), 'utf8')
    .digest('hex');
}
