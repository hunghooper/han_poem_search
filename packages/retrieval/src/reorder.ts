/**
 * Reading-order recovery — extends the spec §7.3.
 *
 * §7.3 models damaged input as *reversed line order*, on the reasoning that classical Chinese
 * is written in vertical columns read right to left while transcribers read left to right.
 * That is the right diagnosis and the wrong generalization: line reversal is only the
 * one-column special case.
 *
 * Real transcriptions of a 4x10 column layout arrive as four *rows* — the transcriber walked
 * across the columns instead of down them. Recovering the poem is a GRID TRANSPOSE, and no
 * amount of line reversal will find it. Worked example, from the maintainer's golden set:
 *
 *     地何病著名涌平夜岸細        read columns right-to-left:
 *     一所休官章江野舟危草   ->   細草微風 | 岸危檣獨 | 夜舟星垂 | ...
 *     沙似老應文大闊星檣微        = 細草微風岸，危檣獨夜舟。星垂平野闊，月涌大江流。…
 *     鷗天飄飄豈流月垂獨風        (杜甫《旅夜書懷》)
 *
 * So this module ENUMERATES candidate readings; it does not decide. Deciding is the
 * retriever's job: score each reading by how much of it resolves to a single workId and take
 * the winner. Enumerating here and scoring there keeps the "did the input get reordered?"
 * question answerable with evidence rather than with a heuristic.
 *
 * Pure, synchronous, no I/O. Bounded output — see MAX_READINGS.
 */

import { toMatchForm, visualLines } from './normalize.js';

export type ReorderStrategy =
  | 'as_written'
  | 'line_reverse'
  | 'line_chars_reverse'
  | 'stream_reverse'
  | 'grid_rtl'
  | 'grid_ltr';

export interface Reading {
  strategy: ReorderStrategy;
  /** Match-form character stream to look up. */
  text: string;
  /**
   * For each character of `text`, its index in the `as_written` match stream. Lets a hit on a
   * reordered reading be highlighted on the text the user actually pasted.
   */
  sourceIndex: number[];
  /** Grid width, for the grid strategies. Null otherwise. Surfaced in the trace. */
  cols: number | null;
  /** True for anything other than `as_written` — drives the `input_reordered` flag. */
  reordered: boolean;
}

/** Enumeration is bounded so a pathological paste cannot fan out into thousands of lookups. */
export const MAX_READINGS = 24;

/** Grids narrower than this are noise; a 1-column "grid" is just the stream itself. */
const MIN_COLS = 2;
const MAX_COLS = 12;

const build = (
  strategy: ReorderStrategy,
  chars: readonly { ch: string; src: number }[],
  cols: number | null,
): Reading => ({
  strategy,
  text: chars.map((c) => c.ch).join(''),
  sourceIndex: chars.map((c) => c.src),
  cols,
  reordered: strategy !== 'as_written',
});

/**
 * Reshape a flat stream into `cols` columns and read down each column.
 * `dir: 'rtl'` reads the rightmost column first — the classical layout.
 *
 * Rows are ragged when the length is not a multiple of `cols`; a short final row leaves the
 * leftmost columns one character shorter, which is exactly how a real column layout ends.
 */
const transpose = (
  chars: readonly { ch: string; src: number }[],
  cols: number,
  dir: 'rtl' | 'ltr',
): { ch: string; src: number }[] => {
  const rows = Math.ceil(chars.length / cols);
  const out: { ch: string; src: number }[] = [];
  const order = dir === 'rtl' ? [...Array(cols).keys()].reverse() : [...Array(cols).keys()];
  for (const c of order) {
    for (let r = 0; r < rows; r += 1) {
      const item = chars[r * cols + c];
      if (item) out.push(item);
    }
  }
  return out;
};

/** Candidate grid widths, most likely first: the observed line width, then plausible divisors. */
const candidateCols = (lines: readonly string[], total: number): number[] => {
  const widths = new Set<number>();
  const lens = lines.map((l) => toMatchForm(l).length).filter((n) => n > 0);

  // Uniform line length is the strongest signal that the paste preserved the grid rows.
  const first = lens[0];
  if (first !== undefined && lens.every((n) => n === first) && first >= MIN_COLS) {
    widths.add(first);
  }
  // Otherwise the grid was flattened; try widths that divide the stream cleanly.
  for (let c = MIN_COLS; c <= Math.min(MAX_COLS, total); c += 1) {
    if (total % c === 0) widths.add(c);
  }
  // Classical line lengths, whether or not they divide evenly.
  for (const c of [5, 7, 4]) if (c <= total) widths.add(c);

  return [...widths];
};

/**
 * Enumerate plausible readings of a pasted fragment, most-likely first.
 *
 * The first entry is always `as_written`, so a caller that ignores reordering entirely still
 * behaves correctly — reordering is an addition to the search, never a replacement for it.
 */
export function enumerateReadings(input: string): Reading[] {
  const lines = visualLines(input);
  if (lines.length === 0) return [];

  // The as-written stream, with each character's index in that stream as its identity.
  const perLine = lines.map((l) => toMatchForm(l));
  const flat: { ch: string; src: number }[] = [];
  for (const line of perLine) for (const ch of line) flat.push({ ch, src: flat.length });

  if (flat.length === 0) return [];

  const readings: Reading[] = [build('as_written', flat, null)];
  const seen = new Set<string>([readings[0]!.text]);

  const push = (r: Reading): void => {
    if (readings.length >= MAX_READINGS) return;
    if (r.text.length === 0 || seen.has(r.text)) return;
    seen.add(r.text);
    readings.push(r);
  };

  // Line-level permutations. Cheap, and they cover the vertical-column-of-lines case.
  if (lines.length > 1) {
    const offsets: number[] = [];
    let acc = 0;
    for (const line of perLine) {
      offsets.push(acc);
      acc += line.length;
    }

    const reversedLines: { ch: string; src: number }[] = [];
    for (let i = perLine.length - 1; i >= 0; i -= 1) {
      const line = perLine[i] ?? '';
      const off = offsets[i] ?? 0;
      for (let j = 0; j < line.length; j += 1) reversedLines.push({ ch: line[j]!, src: off + j });
    }
    push(build('line_reverse', reversedLines, null));

    // Each line reversed in place — horizontal right-to-left signage and plaques.
    const charsReversed: { ch: string; src: number }[] = [];
    for (let i = 0; i < perLine.length; i += 1) {
      const line = perLine[i] ?? '';
      const off = offsets[i] ?? 0;
      for (let j = line.length - 1; j >= 0; j -= 1) charsReversed.push({ ch: line[j]!, src: off + j });
    }
    push(build('line_chars_reverse', charsReversed, null));
  }

  push(build('stream_reverse', [...flat].reverse(), null));

  // Grid transposition — the case §7.3 misses.
  for (const cols of candidateCols(lines, flat.length)) {
    push(build('grid_rtl', transpose(flat, cols, 'rtl'), cols));
    push(build('grid_ltr', transpose(flat, cols, 'ltr'), cols));
  }

  return readings;
}

/** Map a span on a reading back onto the as-written stream, for highlighting. */
export function spanToSource(
  reading: Reading,
  start: number,
  end: number,
): { start: number; end: number } | null {
  const slice = reading.sourceIndex.slice(start, end);
  if (slice.length === 0) return null;
  let lo = slice[0]!;
  let hi = slice[0]!;
  for (const i of slice) {
    if (i < lo) lo = i;
    if (i > hi) hi = i;
  }
  return { start: lo, end: hi + 1 };
}
