import { describe, expect, it } from 'vitest';
import { isOutOfOrder, windows, MAX_WINDOW_CHARS, MIN_WINDOW_CHARS } from './exact-ngram.js';

describe('windows', () => {
  // REGRESSION. Windows are matched against poem_line.text_match, where a line is 5-7
  // characters. Generating windows up to the full input length meant the query budget was
  // consumed entirely by windows too long to fit inside any line, and every fragment lookup
  // returned zero rows — reported as `no_local_result`, indistinguishable from a genuine miss.
  it('never produces a window longer than a line can hold', () => {
    const long = '細草微風岸危檣獨夜舟星垂平野闊月湧大江流名豈文章著官應老病休';
    const ws = windows(long);
    expect(ws.length).toBeGreaterThan(0);
    for (const w of ws) expect(w.length).toBeLessThanOrEqual(MAX_WINDOW_CHARS);
  });

  it('emits longest first so a decisive hit can stop the sweep early', () => {
    const ws = windows('群峭碧摩天逍遙不記年');
    expect(ws[0]!.length).toBe(10);
    expect(ws.at(-1)!.length).toBe(MIN_WINDOW_CHARS);
  });

  it('covers every position at each length', () => {
    expect(windows('群峭碧摩天', 4, 4)).toEqual(['群峭碧摩', '峭碧摩天']);
  });

  it('deduplicates repeated windows', () => {
    const ws = windows('花花花花花花', 4, 4);
    expect(ws).toEqual(['花花花花']);
  });

  it('returns nothing for input shorter than the minimum window', () => {
    expect(windows('群峭')).toEqual([]);
  });
});

describe('isOutOfOrder', () => {
  // REGRESSION. Detecting reordering by "which reorder strategy won" misses scrambled input
  // that still matches as-written because one segment survived intact — which is exactly the
  // §16 acceptance fragment. Order disagreement catches it without any strategy firing.
  it('detects the §16 李白 fragment, whose segments match as-written but out of sequence', () => {
    // Line numbers of 尋雍尊師隱居 in the order the pasted fragment reaches them.
    const order = [
      { inputPos: 0, lineNo: 7 },
      { inputPos: 5, lineNo: 5 },
      { inputPos: 10, lineNo: 6 },
      { inputPos: 19, lineNo: 3 },
      { inputPos: 24, lineNo: 4 },
      { inputPos: 28, lineNo: 0 },
      { inputPos: 33, lineNo: 1 },
    ];
    expect(isOutOfOrder(order)).toBe(true);
  });

  it('does not flag input that reads in the poem order', () => {
    const order = [0, 1, 2, 3, 4].map((n) => ({ inputPos: n * 5, lineNo: n }));
    expect(isOutOfOrder(order)).toBe(false);
  });

  it('does not flag fewer than three distinct lines', () => {
    // A two-line swap is as likely to be a couplet transcribed either way as it is damage.
    expect(isOutOfOrder([{ inputPos: 0, lineNo: 1 }, { inputPos: 5, lineNo: 0 }])).toBe(false);
  });

  it('tolerates a single local swap without crying reorder', () => {
    const order = [
      { inputPos: 0, lineNo: 0 },
      { inputPos: 5, lineNo: 2 },
      { inputPos: 10, lineNo: 1 },
      { inputPos: 15, lineNo: 3 },
      { inputPos: 20, lineNo: 4 },
      { inputPos: 25, lineNo: 5 },
    ];
    expect(isOutOfOrder(order)).toBe(false);
  });

  it('flags a fully reversed reading', () => {
    const order = [0, 1, 2, 3, 4].map((n) => ({ inputPos: n * 5, lineNo: 4 - n }));
    expect(isOutOfOrder(order)).toBe(true);
  });

  it('uses the earliest input position when a line matches several windows', () => {
    const order = [
      { inputPos: 30, lineNo: 0 },
      { inputPos: 2, lineNo: 0 },
      { inputPos: 10, lineNo: 1 },
      { inputPos: 20, lineNo: 2 },
    ];
    // Line 0 first appears at position 2, so the sequence is in order.
    expect(isOutOfOrder(order)).toBe(false);
  });
});
