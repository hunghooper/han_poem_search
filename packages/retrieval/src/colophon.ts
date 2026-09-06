/**
 * 落款 detection — the inscription block a calligrapher signs a work with.
 *
 * A transcription of a hanging scroll is rarely just the poem. The 正文 (the verse) is followed
 * by a 落款: the title, the poet, who wrote the scroll, a 干支 date, and sometimes a seal
 * legend. Pasted into a search box it looks like part of the poem, and it is not:
 *
 *     旅夜書懷        <- title
 *     細草微風岸…      <- 正文, the only part that should be fragment-matched
 *     杜甫詩          <- attribution
 *     辛亥年秋月書     <- 干支 date
 *
 * Feeding the whole thing to the n-gram index does two kinds of damage. The date and signature
 * contribute windows that match nothing, wasting the query budget; worse, a title or poet name
 * is short and common enough to match unrelated poems, which is how a search for one poem
 * returns a different poet's work with apparent confidence.
 *
 * So this module SPLITS the input; it does not interpret it. The 正文 goes to the fragment
 * matcher and the 落款 becomes metadata that can corroborate a candidate — never a match on
 * its own, because a scroll's attribution is a claim by the calligrapher, not evidence.
 */

import { toMatchForm, visualLines } from './normalize.js';

/** 天干 and 地支 — a 干支 year is one of each, in order. */
const STEMS = '甲乙丙丁戊己庚辛壬癸';
const BRANCHES = '子丑寅卯辰巳午未申酉戌亥';

/** 年 / 月 / 日 markers that follow a cyclical date, plus the seasons used in 落款. */
const DATE_TAIL = '年月日春夏秋冬';

/** Verbs and nouns that mark a line as inscription rather than verse. */
const COLOPHON_MARKERS = [
  '書', '寫', '題', '錄', '録', '臨', '作', '撰', '並書', '敬書', '謹書', '節錄', '節録',
  '印', '鈐', '篆', '刻',
  '先生', '女士', '雅正', '清賞', '惠存', '正之', '指正',
  '詩', '詞', '句', '聯',
];

export interface Colophon {
  /** The verse body — what the fragment matcher should see. */
  body: string[];
  /** Lines identified as inscription, in input order. */
  colophonLines: string[];
  /** A 干支 date found in the colophon, if any. */
  cyclicalDate: string | null;
  /** Candidate author name, if one could be isolated. */
  author: string | null;
  /** Candidate title, if one could be isolated. */
  title: string | null;
}

/** True if the text contains a 干支 pair — 辛亥, 己亥, 甲子 … */
export function hasCyclicalDate(text: string): boolean {
  for (let i = 0; i + 1 < text.length; i += 1) {
    if (STEMS.includes(text[i]!) && BRANCHES.includes(text[i + 1]!)) return true;
  }
  return false;
}

export function extractCyclicalDate(text: string): string | null {
  for (let i = 0; i + 1 < text.length; i += 1) {
    if (STEMS.includes(text[i]!) && BRANCHES.includes(text[i + 1]!)) {
      let end = i + 2;
      while (end < text.length && DATE_TAIL.includes(text[end]!)) end += 1;
      return text.slice(i, end);
    }
  }
  return null;
}

/**
 * Score how strongly a line reads as inscription rather than verse.
 *
 * Deliberately conservative. A false positive silently deletes a line of the poem from the
 * search, which is worse than leaving a signature in: the extra windows merely cost time,
 * whereas a dropped line costs a match.
 */
export function colophonScore(line: string): number {
  const m = toMatchForm(line);
  if (m.length === 0) return 0;

  let score = 0;
  if (hasCyclicalDate(m)) score += 3;
  for (const marker of COLOPHON_MARKERS) if (m.includes(marker)) score += 1;

  // Verse lines are 4-9 characters and come in even-length groups; a 2-3 character line is
  // almost always a name, a seal, or a fragment of a signature.
  if (m.length <= 3) score += 1;
  // Long prose-like runs are 題跋, not 五言 or 七言.
  if (m.length > 12) score += 1;

  return score;
}

/** A line scoring at or above this is treated as inscription. */
export const COLOPHON_THRESHOLD = 2;

/**
 * Split pasted input into 正文 and 落款.
 *
 * The colophon sits at the END of a scroll, so scanning backwards from the last line and
 * stopping at the first line that reads as verse keeps an inscription-like line INSIDE the
 * poem safe. 「白頭不老」 mid-poem stays; the same words after the last verse line do not.
 *
 * A title may also sit at the head, which is why the leading line is considered separately.
 */
export function splitColophon(input: string): Colophon {
  const lines = visualLines(input);
  if (lines.length === 0) {
    return { body: [], colophonLines: [], cyclicalDate: null, author: null, title: null };
  }

  // Everything, top to bottom, scoring as inscription — used only when nothing is verse.
  const scores = lines.map((l) => colophonScore(l));
  const allColophon = scores.every((s) => s >= COLOPHON_THRESHOLD);
  if (allColophon) {
    const joined = lines.join(' ');
    return {
      body: [],
      colophonLines: lines,
      cyclicalDate: extractCyclicalDate(toMatchForm(joined)),
      author: null,
      title: null,
    };
  }

  let end = lines.length;
  while (end > 0 && (scores[end - 1] ?? 0) >= COLOPHON_THRESHOLD) end -= 1;

  let start = 0;
  // A 干支 date is never verse, wherever it appears, so a leading one is stripped outright.
  // Everything else at the head is only treated as a title when enough verse follows to be
  // sure we are not eating half of a couplet — dropping a real line costs a match, while
  // keeping a signature only costs a few wasted windows.
  while (start < end && hasCyclicalDate(toMatchForm(lines[start] ?? ''))) start += 1;
  if (end - start > 2 && (scores[start] ?? 0) >= COLOPHON_THRESHOLD) start += 1;

  const body = lines.slice(start, end);
  const colophonLines = [...lines.slice(0, start), ...lines.slice(end)];
  const joined = colophonLines.join(' ');

  return {
    body,
    colophonLines,
    cyclicalDate: colophonLines.length ? extractCyclicalDate(toMatchForm(joined)) : null,
    author: null,
    title: start > 0 ? (lines[0] ?? null) : null,
  };
}
