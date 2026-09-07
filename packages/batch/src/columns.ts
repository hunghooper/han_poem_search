/**
 * Which column holds the poetry?
 *
 * The user picks it, always. This module only ranks the candidates so the picker opens on the
 * right one, and it ABSTAINS when nothing is clearly a poetry column rather than nominating
 * the least bad option. A confident wrong default is worse than no default here: the user
 * clicks through it, the batch runs against an id column, and every row comes back
 * `no_result` — which reads as "the corpus does not have these poems".
 *
 * That is §5's distinction applied to a UI affordance: "I do not know which column" and "this
 * column" are different answers and must look different.
 */

/**
 * Han script, via the Unicode property rather than a hand-written range list.
 *
 * `\p{Script=Han}` covers every extension block, including the ones beyond the BMP that a
 * hand-rolled surrogate-pair pattern gets wrong under the `u` flag — which is how the first
 * version of this failed its own test. It also excludes kana and hangul for free: a Japanese
 * or Korean column is not a classical Chinese poetry column, and counting them would rank it
 * above the real one in a mixed-language file.
 */
const HAN = /\p{Script=Han}/gu;

/** Punctuation and whitespace are evidence neither way, so they leave the denominator. */
const NOISE = /[\s\p{P}\p{S}]/gu;

/** Ratio of Han characters to meaningful characters. 0 when there is nothing to measure. */
export function cjkRatio(value: string): number {
  const dense = value.replace(NOISE, '');
  const chars = [...dense];
  if (chars.length === 0) return 0;
  return (dense.match(HAN)?.length ?? 0) / chars.length;
}

export interface ColumnProfile {
  name: string;
  /** Mean CJK ratio over the non-empty sampled values. */
  cjkRatio: number;
  /** Share of sampled rows where this column has a value at all. */
  filled: number;
  /** Mean length in characters of the non-empty values. */
  meanLength: number;
  /** A few real values, for the picker to show. */
  samples: string[];
  /** Why this column is or is not a plausible poetry column. */
  score: number;
}

export interface ColumnScan {
  columns: ColumnProfile[];
  /** The column to preselect, or null when nothing is clearly it. */
  suggested: string | null;
  /** Present when `suggested` is null: what to tell the user. */
  abstainReason?: 'no_cjk' | 'ambiguous';
}

/**
 * A column has to clear this mean CJK ratio to be nominated at all. Poetry columns in real
 * files sit near 1.0; a mixed column with a Vietnamese gloss beside the Chinese still clears
 * this comfortably, and an id or date column is nowhere near it.
 */
const MIN_CJK_RATIO = 0.5;

/** Below this the column is mostly blank and nominating it would waste the whole run. */
const MIN_FILLED = 0.5;

/**
 * How much better the winner must score than the runner-up to be nominated. Two columns of
 * Chinese — say `poem` and `title` — is the ordinary case in real files, and picking one by a
 * hair is exactly the confident wrong default this module exists to avoid.
 */
const DECISIVE_MARGIN = 1.5;

export function scanColumns(rows: Array<Record<string, unknown>>, names?: string[]): ColumnScan {
  const columnNames = names ?? unionOfKeys(rows);
  const columns = columnNames.map((name) => profile(name, rows));

  const eligible = columns
    .filter((c) => c.cjkRatio >= MIN_CJK_RATIO && c.filled >= MIN_FILLED)
    .sort((a, b) => b.score - a.score);

  if (eligible.length === 0) {
    return { columns, suggested: null, abstainReason: 'no_cjk' };
  }
  const [best, second] = eligible;
  if (second && best!.score < second.score * DECISIVE_MARGIN) {
    return { columns, suggested: null, abstainReason: 'ambiguous' };
  }
  return { columns, suggested: best!.name };
}

function profile(name: string, rows: Array<Record<string, unknown>>): ColumnProfile {
  const values = rows.map((r) => cellText(r[name]));
  const nonEmpty = values.filter((v) => v.length > 0);
  const filled = values.length === 0 ? 0 : nonEmpty.length / values.length;
  const ratio =
    nonEmpty.length === 0 ? 0 : nonEmpty.reduce((s, v) => s + cjkRatio(v), 0) / nonEmpty.length;
  const meanLength =
    nonEmpty.length === 0 ? 0 : nonEmpty.reduce((s, v) => s + v.length, 0) / nonEmpty.length;

  return {
    name,
    cjkRatio: ratio,
    filled,
    meanLength,
    samples: nonEmpty.slice(0, 3),
    // Length breaks the tie between a title column and a body column: both are Chinese, and
    // the one with more characters per row is the one worth searching. Damped, because a
    // column of whole poems should not beat a column of single lines by an order of magnitude.
    score: ratio * filled * Math.log1p(meanLength),
  };
}

/** First-seen key order across the sample, so the picker lists columns as the file does. */
export function unionOfKeys(rows: Array<Record<string, unknown>>): string[] {
  const seen = new Set<string>();
  for (const row of rows) for (const k of Object.keys(row)) seen.add(k);
  return [...seen];
}

/**
 * A cell as searchable text.
 *
 * Numbers and booleans stringify; objects and arrays do NOT. A column of nested objects is not
 * a poetry column, and `[object Object]` scoring 0 for CJK is the correct outcome rather than
 * something to code around.
 */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}
