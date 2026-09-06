import { describe, expect, it } from 'vitest';
import { enumerateReadings, MAX_READINGS, spanToSource } from './reorder.js';
import { toMatchForm } from './normalize.js';

/** 杜甫《旅夜書懷》 — gq-09 in the golden set. */
const LU_YE_GRID = '地何病著名涌平夜岸細\n一所休官章江野舟危草\n沙似老應文大闊星檣微\n鷗天飄飄豈流月垂獨風';
// Compared in MATCH form, never raw: OpenCC maps 涌 -> 湧, and the corpus goes through the
// same normalize(). Asserting against raw text is the exact mistake CONTRIBUTING.md warns
// about — it would fail here for a reason that has nothing to do with reading order.
const LU_YE_TEXT = toMatchForm('細草微風岸，危檣獨夜舟。星垂平野闊，月涌大江流。名豈文章著，官應老病休。飄飄何所似，天地一沙鷗。');

/** 杜甫 五律 — gq-03, damaged by reversed line order. */
const REVERSED_LINES = '話涕霑巾\n諫丹墀有故人向來論社稷爲\n猶戀主久客羨歸秦黃閣長司\n羣盜至今在先朝赤子存君王';

describe('enumerateReadings', () => {
  it('always offers the as-written reading first', () => {
    const [first] = enumerateReadings('群峭碧摩天');
    expect(first?.strategy).toBe('as_written');
    expect(first?.reordered).toBe(false);
    expect(first?.text).toBe('群峭碧摩天');
  });

  it('recovers 旅夜書懷 from the column grid — the case line reversal cannot reach', () => {
    const readings = enumerateReadings(LU_YE_GRID);
    const grid = readings.find((r) => r.strategy === 'grid_rtl' && r.cols === 10);
    expect(grid).toBeDefined();

    // The transcription carries three character transpositions, so this asserts recovery,
    // not equality: 34 of 40 characters land correctly, leaving a 16-character exact prefix
    // and an 8-character exact tail. Both runs are far above the 5-character short-circuit
    // threshold of §7.1, which is what makes this findable at all.
    expect(grid?.text.startsWith(LU_YE_TEXT.slice(0, 16))).toBe(true);
    expect(grid?.text.endsWith(LU_YE_TEXT.slice(-8))).toBe(true);

    const mismatches = [...(grid?.text ?? '')].filter((ch, i) => ch !== LU_YE_TEXT[i]).length;
    expect(mismatches).toBe(6);
  });

  it('line reversal alone does NOT recover the grid case — the reason this module exists', () => {
    const lineReverse = enumerateReadings(LU_YE_GRID).find((r) => r.strategy === 'line_reverse');
    expect(lineReverse?.text.startsWith('細草微風')).toBe(false);
  });

  // Note the folded forms: 羣 -> 群 and 爲 -> 為 come from variants.json, applied to
  // textMatch. Matching against unfolded input is the bug this asserts against.
  it('recovers reversed line order', () => {
    const reading = enumerateReadings(REVERSED_LINES).find((r) => r.strategy === 'line_reverse');
    expect(reading?.text).toBe('群盜至今在先朝赤子存君王猶戀主久客羨歸秦黃閣長司諫丹墀有故人向來論社稷為話涕霑巾');
  });

  it('joins a one-character-per-line vertical transcription into a single stream', () => {
    const readings = enumerateReadings('水\n秋\n無\n淨\n泥\n春\n花\n開\n落\n自');
    expect(readings[0]?.text).toBe('水秋無淨泥春花開落自');
    expect(readings.some((r) => r.text === '自落開花春泥淨無秋水')).toBe(true);
  });

  it('tries both plausible grid widths when the layout is ambiguous', () => {
    // 12 characters factor as 3x4 and 4x3; the original layout is lost, so guessing is wrong.
    const cols = new Set(
      enumerateReadings('客\n莫\n基\n東\n幹\n觀\n歎\n執\n軍\n成\n名\n木')
        .filter((r) => r.strategy === 'grid_rtl')
        .map((r) => r.cols),
    );
    expect(cols).toContain(3);
    expect(cols).toContain(4);
  });

  it('strips punctuation and normalizes script before enumerating', () => {
    const [first] = enumerateReadings('群峭碧摩天，逍遥不记年。');
    expect(first?.text).toBe('群峭碧摩天逍遥不記年');
  });

  it('emits no duplicate readings', () => {
    const texts = enumerateReadings(LU_YE_GRID).map((r) => r.text);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('stays bounded on a large paste', () => {
    const big = Array.from({ length: 200 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join('\n');
    expect(enumerateReadings(big).length).toBeLessThanOrEqual(MAX_READINGS);
  });

  it('returns nothing for input with no CJK', () => {
    expect(enumerateReadings('hello world')).toEqual([]);
    expect(enumerateReadings('   \n  ')).toEqual([]);
  });

  it('marks every non-identity reading as reordered', () => {
    for (const r of enumerateReadings(LU_YE_GRID).slice(1)) expect(r.reordered).toBe(true);
  });
});

describe('spanToSource', () => {
  it('maps a hit on a reordered reading back onto what the user pasted', () => {
    const reading = enumerateReadings(LU_YE_GRID).find((r) => r.strategy === 'grid_rtl' && r.cols === 10);
    expect(reading).toBeDefined();
    // 細 is the last character of the first pasted line -> as-written index 9.
    const span = spanToSource(reading!, 0, 1);
    expect(span).toEqual({ start: 9, end: 10 });
  });

  it('returns null for an empty span', () => {
    const [first] = enumerateReadings('群峭碧摩天');
    expect(spanToSource(first!, 2, 2)).toBeNull();
  });
});
