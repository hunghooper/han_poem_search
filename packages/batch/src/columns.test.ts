import { describe, expect, it } from 'vitest';
import { cjkRatio, scanColumns } from './columns.js';

describe('cjkRatio', () => {
  it('scores classical Chinese at 1', () => {
    expect(cjkRatio('床前明月光')).toBe(1);
  });

  it('ignores whitespace', () => {
    expect(cjkRatio('床前明月光 疑是地上霜')).toBe(1);
  });

  it('scores Vietnamese and ids at 0', () => {
    expect(cjkRatio('Nam quoc son ha')).toBe(0);
    expect(cjkRatio('row-00412')).toBe(0);
  });

  // Kana and hangul are not classical Chinese poetry. Counting them would rank a Japanese
  // column above the real one in a mixed-language file.
  it('does not count kana or hangul', () => {
    expect(cjkRatio('ひらがな')).toBe(0);
    expect(cjkRatio('한글')).toBe(0);
  });

  it('counts ideographs beyond the BMP', () => {
    expect(cjkRatio('\u{20000}\u{20001}')).toBe(1);
  });

  it('is empty-safe', () => {
    expect(cjkRatio('')).toBe(0);
    expect(cjkRatio('   ')).toBe(0);
  });
});

describe('scanColumns', () => {
  const rows = [
    { id: 'r1', poem: '床前明月光，疑是地上霜', note: 'from an album' },
    { id: 'r2', poem: '舉頭望明月，低頭思故鄉', note: 'scroll 3' },
    { id: 'r3', poem: '春眠不覺曉，處處聞啼鳥', note: '' },
  ];

  it('suggests the Chinese column', () => {
    const scan = scanColumns(rows);
    expect(scan.suggested).toBe('poem');
  });

  it('profiles every column so the picker can show all of them', () => {
    const scan = scanColumns(rows);
    expect(scan.columns.map((c) => c.name)).toEqual(['id', 'poem', 'note']);
    expect(scan.columns.find((c) => c.name === 'note')?.filled).toBeCloseTo(2 / 3);
  });

  // The whole point of the module. A confident wrong default gets clicked through, the batch
  // runs against the wrong column, and 50,000 rows come back no_result — which reads as
  // "the corpus does not have these poems" rather than "you searched the wrong column".
  it('abstains when no column is Chinese at all', () => {
    const scan = scanColumns([{ id: 'r1', title: 'Bonjour' }]);
    expect(scan.suggested).toBeNull();
    expect(scan.abstainReason).toBe('no_cjk');
  });

  it('abstains when two Chinese columns are too close to call', () => {
    const scan = scanColumns([
      { title: '靜夜思', body: '床前明月光' },
      { title: '春曉', body: '春眠不覺曉' },
    ]);
    expect(scan.suggested).toBeNull();
    expect(scan.abstainReason).toBe('ambiguous');
  });

  it('prefers the body over the title when the body is decisively longer', () => {
    const scan = scanColumns([
      { title: '靜夜思', body: '床前明月光，疑是地上霜。舉頭望明月，低頭思故鄉。' },
      { title: '春曉', body: '春眠不覺曉，處處聞啼鳥。夜來風雨聲，花落知多少。' },
    ]);
    expect(scan.suggested).toBe('body');
  });

  it('will not suggest a mostly empty column', () => {
    const sparse = [{ poem: '床前明月光' }, { poem: '' }, { poem: '' }, { poem: '' }];
    expect(scanColumns(sparse).suggested).toBeNull();
  });
});
