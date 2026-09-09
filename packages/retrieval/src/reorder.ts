import { toMatchForm, visualLines } from './normalize.js';

export type ReorderStrategy =
  'as_written' | 'line_reverse' | 'line_chars_reverse' | 'stream_reverse' | 'grid_rtl' | 'grid_ltr';

export interface Reading {
  strategy: ReorderStrategy;
  text: string;
  sourceIndex: number[];
  cols: number | null;
  reordered: boolean;
}

export const MAX_READINGS = 24;

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

const candidateCols = (lines: readonly string[], total: number): number[] => {
  const widths = new Set<number>();
  const lens = lines.map((l) => toMatchForm(l).length).filter((n) => n > 0);

  const first = lens[0];
  if (first !== undefined && lens.every((n) => n === first) && first >= MIN_COLS) {
    widths.add(first);
  }
  for (let c = MIN_COLS; c <= Math.min(MAX_COLS, total); c += 1) {
    if (total % c === 0) widths.add(c);
  }
  for (const c of [5, 7, 4]) if (c <= total) widths.add(c);

  return [...widths];
};

export function enumerateReadings(input: string): Reading[] {
  const lines = visualLines(input);
  if (lines.length === 0) return [];

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

    const charsReversed: { ch: string; src: number }[] = [];
    for (let i = 0; i < perLine.length; i += 1) {
      const line = perLine[i] ?? '';
      const off = offsets[i] ?? 0;
      for (let j = line.length - 1; j >= 0; j -= 1)
        charsReversed.push({ ch: line[j]!, src: off + j });
    }
    push(build('line_chars_reverse', charsReversed, null));
  }

  push(build('stream_reverse', [...flat].reverse(), null));

  for (const cols of candidateCols(lines, flat.length)) {
    push(build('grid_rtl', transpose(flat, cols, 'rtl'), cols));
    push(build('grid_ltr', transpose(flat, cols, 'ltr'), cols));
  }

  return readings;
}

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
