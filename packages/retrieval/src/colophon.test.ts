import { describe, expect, it } from 'vitest';
import {
  colophonScore,
  COLOPHON_THRESHOLD,
  extractCyclicalDate,
  hasCyclicalDate,
  splitColophon,
} from './colophon.js';

describe('干支 dates', () => {
  it('recognises a stem-branch pair', () => {
    expect(hasCyclicalDate('辛亥年')).toBe(true);
    expect(hasCyclicalDate('己亥年秋')).toBe(true);
    expect(hasCyclicalDate('細草微風岸')).toBe(false);
  });

  it('extracts the date with its trailing marker', () => {
    expect(extractCyclicalDate('辛亥年秋月書')).toBe('辛亥年秋月');
    expect(extractCyclicalDate('歲次甲子春')).toBe('甲子春');
    expect(extractCyclicalDate('細草微風岸')).toBeNull();
  });

  it('does not fire on a stem or branch alone', () => {
    expect(hasCyclicalDate('子規啼夜月')).toBe(false);
    expect(hasCyclicalDate('甲光向日金鱗開')).toBe(false);
  });
});

describe('colophonScore', () => {
  it('scores verse below the threshold', () => {
    for (const line of ['細草微風岸', '危檣獨夜舟', '羣峭碧摩天', '逍遙不記年']) {
      expect(colophonScore(line)).toBeLessThan(COLOPHON_THRESHOLD);
    }
  });

  it('scores an inscription line above the threshold', () => {
    for (const line of ['辛亥年秋月書', '杜甫詩', '己亥年', '節錄杜甫旅夜書懷']) {
      expect(colophonScore(line)).toBeGreaterThanOrEqual(COLOPHON_THRESHOLD);
    }
  });
});

describe('splitColophon', () => {
  it('keeps the verse and separates the signature', () => {
    const r = splitColophon('細草微風岸\n危檣獨夜舟\n星垂平野闊\n月湧大江流\n杜甫詩\n辛亥年秋月書');
    expect(r.body).toEqual(['細草微風岸', '危檣獨夜舟', '星垂平野闊', '月湧大江流']);
    expect(r.colophonLines).toEqual(['杜甫詩', '辛亥年秋月書']);
    expect(r.cyclicalDate).toBe('辛亥年秋月');
  });

  it('separates a leading title as well as a trailing signature', () => {
    const r = splitColophon('杜甫詩\n細草微風岸\n危檣獨夜舟\n星垂平野闊\n辛亥年書');
    expect(r.title).toBe('杜甫詩');
    expect(r.body).toEqual(['細草微風岸', '危檣獨夜舟', '星垂平野闊']);
  });

  it('strips the 干支 lines from a signature block, keeping what could be verse', () => {
    const r = splitColophon('辛亥月\n鶴舞飛翔\n己亥年');
    expect(r.body).toEqual(['鶴舞飛翔']);
    expect(r.colophonLines).toEqual(['辛亥月', '己亥年']);
    expect(r.cyclicalDate).not.toBeNull();
  });

  it('leaves an ordinary poem untouched', () => {
    const poem = '羣峭碧摩天\n逍遙不記年\n撥雲尋古道\n倚石聽流泉';
    const r = splitColophon(poem);
    expect(r.body).toEqual(poem.split('\n'));
    expect(r.colophonLines).toEqual([]);
  });

  it('does not strip an inscription-like line from the middle of a poem', () => {
    const r = splitColophon('羣峭碧摩天\n杜甫詩\n撥雲尋古道\n倚石聽流泉');
    expect(r.body).toContain('杜甫詩');
    expect(r.colophonLines).toEqual([]);
  });

  it('returns empty structure for blank input', () => {
    expect(splitColophon('   \n  ').body).toEqual([]);
  });
});
