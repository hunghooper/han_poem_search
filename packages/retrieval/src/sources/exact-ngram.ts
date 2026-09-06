/**
 * exact_ngram — the spec §7.1. The PRIMARY retriever, not a fallback.
 *
 * For fragment_lookup this runs first and, in the majority of expected traffic, answers alone
 * in under 100ms with no LLM call at all.
 *
 * It is also where reading-order recovery is DECIDED. reorder.ts enumerates candidate readings
 * (ADR 003); this module scores each one by how much of it resolves to a single workId and
 * takes the winner. That is what makes `input_reordered` evidence rather than a guess.
 */

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { AggregateFlag } from '@han/shared/flags';
import { enumerateReadings, spanToSource, type Reading } from '../reorder.js';

/** §7.1: a contiguous match of >= 5 characters resolving to one workId short-circuits. */
export const MIN_SHORTCIRCUIT_CHARS = 5;
/** Below this, a window is too common to carry information (每, 不, 一 appear everywhere). */
export const MIN_WINDOW_CHARS = 4;

export type ExactMatchKind = 'full' | 'partial' | 'ambiguous' | 'none';

export interface LineHit extends Record<string, unknown> {
  poemId: string;
  workId: string;
  lineNo: number;
  textDisplay: string;
  textMatch: string;
  title: string | null;
  author: string | null;
  edition: string;
  dataset: string;
  sourceFile: string;
  commitSha: string;
  poemTextDisplay: string;
}

export interface ExactMatch {
  kind: ExactMatchKind;
  workIds: string[];
  /** The reading that produced the match. `as_written` unless the input was reordered. */
  reading: Reading | null;
  /** Distinct windows of the reading that resolved to the winning workId. */
  windowsMatched: number;
  /** Longest contiguous run, in characters, that matched a single line. */
  longestRun: number;
  hits: LineHit[];
  flags: string[];
  latencyMs: number;
}


/**
 * A window must be able to FIT INSIDE a line to match against poem_line.
 *
 * This is the constraint that makes the whole retriever work, and getting it wrong is silent:
 * a 40-character window LIKE-matched against 5-character lines returns zero rows forever, and
 * the run reports `no_local_result` — indistinguishable from a fragment that genuinely is not
 * in the corpus. The longest line in the corpus is a 詞 line; 12 characters covers it.
 */
export const MAX_WINDOW_CHARS = 12;

/**
 * Every contiguous window of `text`, longest first, bounded by MAX_WINDOW_CHARS.
 *
 * Longest-first matters: a 10-character window that hits is worth far more than the ten
 * 4-character windows inside it, and a decisive long hit lets the caller stop early.
 */
export function windows(text: string, min = MIN_WINDOW_CHARS, max = MAX_WINDOW_CHARS): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let len = Math.min(max, text.length); len >= min; len -= 1) {
    for (let i = 0; i + len <= text.length; i += 1) {
      const w = text.slice(i, i + len);
      if (seen.has(w)) continue;
      seen.add(w);
      out.push(w);
    }
  }
  return out;
}

/**
 * One round trip for the whole window sweep.
 *
 * Issuing a query per window turned a fragment lookup into hundreds of round trips; a lateral
 * join over unnest lets the planner probe the pg_bigm index once per pattern inside a single
 * statement, and keeps which-window-matched attributable.
 */
const sweepQuery = (winList: string[], perWindow: number) => sql`
  SELECT
    w.win             AS "win",
    pl.poem_id        AS "poemId",
    pl.work_id        AS "workId",
    pl.line_no        AS "lineNo",
    pl.text_display   AS "textDisplay",
    pl.text_match     AS "textMatch",
    p.title_display   AS "title",
    a.name_display    AS "author",
    p.edition         AS "edition",
    p.dataset         AS "dataset",
    p.source_file     AS "sourceFile",
    p.commit_sha      AS "commitSha",
    p.text_display    AS "poemTextDisplay"
  FROM unnest(${sql.param(winList)}::text[]) AS w(win)
  CROSS JOIN LATERAL (
    SELECT id, poem_id, work_id, line_no, text_display, text_match
    FROM poem_line
    WHERE text_match LIKE '%' || w.win || '%'
    LIMIT ${perWindow}
  ) pl
  JOIN poem p ON p.id = pl.poem_id
  JOIN work wk ON wk.id = pl.work_id
  LEFT JOIN author a ON a.id = wk.author_id
`;

/** Score one reading: how much of it resolves, and to how many distinct works. */
interface ReadingScore {
  reading: Reading;
  outOfOrder: boolean;
  workIds: string[];
  windowsMatched: number;
  longestRun: number;
  hits: LineHit[];
  span: { start: number; end: number } | null;
}

interface SweepRow extends LineHit {
  win: string;
}

interface WorkEvidence {
  hits: LineHit[];
  wins: Set<string>;
  longest: number;
  /** Where each matched window sat in the input, against where it sits in the poem. */
  order: Array<{ inputPos: number; lineNo: number }>;
}

/**
 * Is the input out of order relative to the poem?
 *
 * Detected from ORDER DISAGREEMENT rather than from "which reorder strategy won". Those are
 * different questions, and the strategy answer is wrong in a common case: a scrambled paste
 * whose segments happen to contain one intact run matches as-written, so no strategy "wins",
 * yet the input is plainly reordered. Comparing where each matched window sits in the input
 * against where it sits in the poem catches that, and needs no strategy to have fired.
 *
 * Requires at least three distinct lines: with two, a single swap is as likely to be a
 * transcription of a couplet in either order as it is to be damage.
 */
export function isOutOfOrder(order: ReadonlyArray<{ inputPos: number; lineNo: number }>): boolean {
  const firstPosByLine = new Map<number, number>();
  for (const o of order) {
    const prev = firstPosByLine.get(o.lineNo);
    if (prev === undefined || o.inputPos < prev) firstPosByLine.set(o.lineNo, o.inputPos);
  }
  if (firstPosByLine.size < 3) return false;

  const seq = [...firstPosByLine.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([lineNo]) => lineNo);

  // Count inversions: pairs that appear in the input in the opposite order to the poem.
  let inversions = 0;
  let pairs = 0;
  for (let i = 0; i < seq.length; i += 1) {
    for (let j = i + 1; j < seq.length; j += 1) {
      pairs += 1;
      if (seq[i]! > seq[j]!) inversions += 1;
    }
  }
  // A third of pairs out of order is well past what a single mis-split can produce.
  return pairs > 0 && inversions / pairs > 0.33;
}

async function scoreReading(
  db: NodePgDatabase<Record<string, never>>,
  reading: Reading,
  maxWindows: number,
  perWindow: number,
): Promise<ReadingScore> {
  const winList = windows(reading.text).slice(0, maxWindows);
  const empty: ReadingScore = {
    reading,
    outOfOrder: false,
    workIds: [],
    windowsMatched: 0,
    longestRun: 0,
    hits: [],
    span: null,
  };
  if (winList.length === 0) return empty;

  const res = await db.execute<SweepRow>(sweepQuery(winList, perWindow));
  const rows: SweepRow[] = Array.isArray(res) ? res : res.rows;
  if (rows.length === 0) return empty;

  const byWork = new Map<string, WorkEvidence>();
  for (const row of rows) {
    const entry = byWork.get(row.workId) ?? { hits: [], wins: new Set<string>(), longest: 0, order: [] };
    entry.hits.push(row);
    entry.wins.add(row.win);
    if (row.win.length > entry.longest) entry.longest = row.win.length;
    const at = reading.text.indexOf(row.win);
    if (at >= 0) entry.order.push({ inputPos: at, lineNo: row.lineNo });
    byWork.set(row.workId, entry);
  }

  const ranked = [...byWork.entries()].sort(
    (a, b) => b[1].longest - a[1].longest || b[1].wins.size - a[1].wins.size,
  );
  // A work is a rival only if it ties on BOTH the longest run and the number of distinct
  // windows it explains. Longest run alone is not enough: one Song poem quoting a Tang line
  // ties on run length with the Tang poem it quotes, while explaining one window against the
  // original's five. Calling that "ambiguous" would refuse to answer a question the
  // evidence answers clearly. Genuine ties — the same poem in two editions — still survive.
  const top = ranked[0]![1];
  const tied = ranked.filter(([, v]) => v.longest === top.longest && v.wins.size === top.wins.size);
  const topLongest = top.longest;

  // The span to highlight is the longest window that resolved to the winning work.
  const bestWin = [...tied[0]![1].wins].reduce((a, b) => (b.length > a.length ? b : a));
  const at = reading.text.indexOf(bestWin);
  const span = at >= 0 ? spanToSource(reading, at, at + bestWin.length) : null;

  return {
    reading,
    outOfOrder: isOutOfOrder(tied[0]![1].order),
    workIds: tied.map(([id]) => id),
    windowsMatched: Math.max(...tied.map(([, v]) => v.wins.size)),
    longestRun: topLongest,
    hits: tied.flatMap(([, v]) => v.hits),
    span,
  };
}

/**
 * Classify a scored reading. The three questions of §7.4 stay separate: this answers only
 * "did the index return rows, and how decisively" — relevance and final confidence belong to
 * the confidence policy.
 */
function classify(s: ReadingScore): ExactMatchKind {
  if (s.workIds.length === 0) return 'none';
  if (s.longestRun >= MIN_SHORTCIRCUIT_CHARS) {
    return s.workIds.length === 1 ? 'full' : 'ambiguous';
  }
  return s.windowsMatched >= 2 ? 'partial' : 'none';
}

export interface ExactOptions {
  /** Cap on index probes per reading. Bounds the fan-out from reorder enumeration. */
  maxWindowsPerReading?: number;
  /** Rows fetched per window. Bounds the payload when a window is very common. */
  hitsPerWindow?: number;
  /** Cap on readings tried. The first is always `as_written`. */
  maxReadings?: number;
}

export async function exactNgramSearch(
  db: NodePgDatabase<Record<string, never>>,
  query: string,
  opts: ExactOptions = {},
): Promise<ExactMatch> {
  const started = Date.now();
  const maxWindows = opts.maxWindowsPerReading ?? 400;
  const readings = enumerateReadings(query).slice(0, opts.maxReadings ?? 12);

  const empty: ExactMatch = {
    kind: 'none',
    workIds: [],
    reading: null,
    windowsMatched: 0,
    longestRun: 0,
    hits: [],
    flags: [],
    latencyMs: Date.now() - started,
  };
  if (readings.length === 0) return empty;

  let best: ReadingScore | null = null;
  for (const reading of readings) {
    const score = await scoreReading(db, reading, maxWindows, opts.hitsPerWindow ?? 20);
    if (best === null || score.longestRun > best.longestRun) best = score;

    // The as-written reading resolving decisively means the input was never damaged; trying
    // reorderings past that point can only invent a worse explanation for a fine input.
    if (!reading.reordered && score.longestRun >= MIN_SHORTCIRCUIT_CHARS && score.workIds.length === 1) {
      break;
    }
  }
  if (best === null || best.longestRun === 0) return empty;

  const kind = classify(best);
  const flags: string[] = [];
  if (kind === 'full') flags.push(AggregateFlag.EXACT_FULL_MATCH);
  if (kind === 'partial') flags.push(AggregateFlag.EXACT_PARTIAL_MATCH);
  if (kind === 'ambiguous') flags.push(AggregateFlag.EXACT_AMBIGUOUS);
  // Either signal is sufficient: a reorder strategy had to win, OR the matched windows land
  // on the poem out of sequence. The second catches scrambled input that still matched
  // as-written because one segment survived intact — which the strategy signal alone misses.
  if (kind !== 'none' && (best.reading.reordered || best.outOfOrder)) {
    flags.push(AggregateFlag.INPUT_REORDERED);
  }

  return {
    kind,
    workIds: kind === 'none' ? [] : best.workIds,
    reading: best.reading,
    windowsMatched: best.windowsMatched,
    longestRun: best.longestRun,
    hits: best.hits,
    flags,
    latencyMs: Date.now() - started,
  };
}
