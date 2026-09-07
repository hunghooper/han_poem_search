import { describe, expect, it } from 'vitest';
import { analyseForm, FORM_LABEL, formCompatible, isRegulated } from './form.js';
import { verifyCandidate } from './index.js';
import { checkRhyme, checkTone, prosodyStats, rhymeGroupOf, toneOf } from './prosody.js';

const LU_YE = ['細草微風岸', '危檣獨夜舟', '星垂平野闊', '月湧大江流', '名豈文章著', '官應老病休', '飄飄何所似', '天地一沙鷗'];
const XUN_YONG = ['羣峭碧摩天', '逍遙不記年', '撥雲尋古道', '倚石聽流泉', '花暖青牛臥', '松高白鶴眠', '語來江色暮', '獨自下寒烟'];

describe('analyseForm', () => {
  it('classifies the regulated forms by shape', () => {
    expect(analyseForm(LU_YE).form).toBe('wulu');
    expect(FORM_LABEL[analyseForm(LU_YE).form]).toBe('五言律詩');
    expect(analyseForm(LU_YE.slice(0, 4)).form).toBe('wujue');
    expect(analyseForm(['白日依山盡', '黃河入海流', '欲窮千里目', '更上一層樓']).form).toBe('wujue');
    expect(analyseForm(Array(4).fill('朝辭白帝彩雲間')).form).toBe('qijue');
    expect(analyseForm(Array(8).fill('風急天高猿嘯哀')).form).toBe('qilu');
  });

  it('recognises 詞 by its deliberate irregularity', () => {
    // 如夢令 — uneven by design; that irregularity is the identifying feature, not damage.
    expect(analyseForm(['常記溪亭日暮', '沉醉不知歸路', '興盡晚回舟', '誤入藕花深處', '爭渡', '爭渡']).form).toBe('ci');
  });

  it('falls back to 古詩 for regular lines in an irregular count', () => {
    expect(analyseForm(Array(6).fill('細草微風岸')).form).toBe('gushi');
    expect(analyseForm(Array(4).fill('細草微風岸邊')).form).toBe('gushi'); // 6 characters
  });

  it('returns unknown for nothing', () => {
    expect(analyseForm([]).form).toBe('unknown');
  });

  it('marks the regulated forms', () => {
    expect(isRegulated('wulu')).toBe(true);
    expect(isRegulated('ci')).toBe(false);
    expect(isRegulated('gushi')).toBe(false);
  });
});

describe('formCompatible', () => {
  // §10.1: "a candidate whose form does not match the input's shape is almost certainly wrong"
  it('rejects a 七言 candidate for a 五言 input', () => {
    const input = analyseForm(['細草微風岸', '危檣獨夜舟']);
    const wrong = analyseForm(Array(8).fill('風急天高猿嘯哀'));
    expect(formCompatible(input, wrong)).toBe(false);
  });

  it('accepts a full poem as the answer to a two-line fragment of it', () => {
    // A pasted fragment is usually partial, so line COUNT mismatch proves nothing.
    const input = analyseForm(LU_YE.slice(2, 4));
    expect(formCompatible(input, analyseForm(LU_YE))).toBe(true);
  });

  it('abstains when either side has no dominant line length', () => {
    const ci = analyseForm(['爭渡', '常記溪亭日暮', '興盡晚回舟']);
    expect(formCompatible(ci, analyseForm(LU_YE))).toBe(true);
  });
});

describe('prosody tables', () => {
  it('was derived from the corpus and covers a useful vocabulary', () => {
    const s = prosodyStats();
    expect(s.toneChars).toBeGreaterThan(5000);
    expect(s.rhymeChars).toBeGreaterThan(800);
  });

  it('places the classic 東韻 characters in one class', () => {
    const g = rhymeGroupOf('東');
    expect(g).not.toBeNull();
    for (const ch of ['同', '中', '風', '空', '紅', '終', '宮', '窮']) {
      expect(rhymeGroupOf(ch)).toBe(g);
    }
  });

  it('separates 東韻 from 陽韻 — the check has discriminating power', () => {
    expect(rhymeGroupOf('東')).not.toBe(rhymeGroupOf('陽'));
    expect(rhymeGroupOf('光')).toBe(rhymeGroupOf('陽'));
  });

  it('reports 多音字 as either rather than forcing a tone', () => {
    // Forcing a majority tone on these would reject correct regulated verse.
    expect(['ping', 'ze', 'either']).toContain(toneOf('東'));
    expect(toneOf('龘')).toBe('unknown');
  });
});

describe('checkRhyme', () => {
  it('accepts a real 律詩', () => {
    // 舟/流/休/鷗 all rhyme in 尤韻.
    const r = checkRhyme(LU_YE);
    expect(r.rhymeChars).toEqual(['舟', '流', '休', '鷗']);
    expect(r.consistent).toBe(true);
  });

  it('rejects a deliberately mismatched candidate — the §16 Phase 2 criterion', () => {
    const broken = [...LU_YE];
    broken[3] = '月湧大江東'; // 東韻 where 尤韻 is required
    broken[5] = '官應老病陽'; // 陽韻
    expect(checkRhyme(broken).consistent).toBe(false);
  });

  it('abstains rather than failing when it lacks data', () => {
    // Abstaining and failing mean opposite things; conflating them would quietly downgrade
    // correct answers whose rhyme characters the derived table never saw.
    expect(checkRhyme(['細草微風岸']).consistent).toBeNull();
    expect(checkRhyme([]).consistent).toBeNull();
    expect(checkRhyme(['龘龘龘龘龘', '龘龘龘龘龘', '龘龘龘龘龘', '龘龘龘龘龘']).consistent).toBeNull();
  });
});

describe('checkTone', () => {
  it('accepts genuine regulated verse', () => {
    for (const poem of [LU_YE, XUN_YONG]) {
      const r = checkTone(poem);
      // Either it passes, or it abstains — it must not reject a real 律詩 by 杜甫 or 李白.
      expect(r.consistent === true || r.consistent === null).toBe(true);
    }
  });

  it('abstains on text it has no tone data for', () => {
    expect(checkTone(['龘龘龘龘龘', '齾齾齾齾齾']).consistent).toBeNull();
  });

  it('reports coverage so a weak judgement is visible as weak', () => {
    expect(checkTone(LU_YE).coverage).toBeGreaterThan(0);
  });
});

describe('verifyCandidate on reordered input', () => {
  // REGRESSION, seen in a live trace. The grid-transposed 旅夜書懷 query resolved CORRECTLY to
  // 杜甫《旅夜書懷》 and the trace then said "Form check failed". The pasted grid has ten
  // characters per row; the poem has five per line. Comparing those shapes is meaningless
  // precisely when input_reordered is set, because the input's line structure is the damage.
  it('abstains on the input-shape check rather than reporting a false failure', () => {
    const gridRows = ['地何病著名涌平夜岸細', '一所休官章江野舟危草', '沙似老應文大闊星檣微', '鷗天飄飄豈流月垂獨風'];
    const poem = ['細草微風岸', '危檣獨夜舟', '星垂平野闊', '月湧大江流', '名豈文章著', '官應老病休', '飄飄何所似', '天地一沙鷗'];

    const naive = verifyCandidate(gridRows, poem);
    expect(naive.checks.find((c) => c.name === 'form')?.outcome).toBe('fail');

    const aware = verifyCandidate(gridRows, poem, true);
    expect(aware.checks.find((c) => c.name === 'form')?.outcome).toBe('abstain');
    expect(aware.outcome).not.toBe('fail');
  });

  it('still checks the candidate is well formed in itself', () => {
    // Abstaining on input shape must not disable rhyme and tone on the candidate.
    const poem = ['細草微風岸', '危檣獨夜舟', '星垂平野闊', '月湧大江流', '名豈文章著', '官應老病休', '飄飄何所似', '天地一沙鷗'];
    const r = verifyCandidate(['短'], poem, true);
    expect(r.checks.some((c) => c.name === 'rhyme' && c.outcome !== 'abstain')).toBe(true);
  });
});

/**
 * MEASURED, not argued — scripts/prosody-calibration.ts over 25,000 corpus poems, ADR 011.
 * Every poem there is a correct answer by construction, so every `fail` is a false negative.
 */
describe('what prosody is allowed to reject', () => {
  // 靜夜思 is a 五言古絕: four lines of five characters, so the shape classifier calls it
  // 五言絕句, and its 平仄 does not follow the regulated pattern. Shape cannot tell 古絕 from
  // 近體絕句 — the only thing that can is the tone pattern being tested, which makes rejecting
  // on it circular. 22% of shape-classified regulated poems fail their own tone check.
  it('never rejects a candidate on 平仄 alone', () => {
    const lines = ['牀前看月光', '疑是地上霜', '舉頭望山月', '低頭思故鄉'];
    const v = verifyCandidate(lines, lines);
    expect(v.checks.find((c) => c.name === 'tone')?.outcome).not.toBe('fail');
    expect(v.outcome).not.toBe('fail');
    expect(v.flags).not.toContain('rule_verify_fail');
  });

  it('still reports what the tone check found, so the information is not lost', () => {
    const lines = ['牀前看月光', '疑是地上霜', '舉頭望山月', '低頭思故鄉'];
    const tone = verifyCandidate(lines, lines).checks.find((c) => c.name === 'tone');
    expect(tone?.detail).toMatch(/平仄/u);
  });

  // `analyseForm` calls any uniform 5- or 7-character poem of more than eight lines 排律, and
  // in this corpus most of those are 古詩. Rhyme fails on 10% of 五排 and 72% of 七排 there,
  // against 1-3% for 絕句 and 律詩, so a failure inside that bucket is evidence about the
  // shape guess rather than about the match.
  it('does not reject a 排律-shaped candidate on rhyme', () => {
    const lines = Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? '春眠不覺曉' : '處處聞啼鳥'));
    const v = verifyCandidate(lines, lines);
    expect(v.checks.find((c) => c.name === 'rhyme')?.outcome).toBe('abstain');
    expect(v.outcome).not.toBe('fail');
  });

  // The other half. Verification still has to be able to say no, and the form comparison —
  // the one check that actually compares the input against the candidate — is what does it.
  it('still rejects a candidate whose shape cannot hold the input', () => {
    const input = ['牀前看月光', '疑是地上霜'];
    const candidate = ['羣峭碧摩天逍遙不記年', '撥雲尋古道倚石聽流泉'];
    const v = verifyCandidate(input, candidate);
    expect(v.checks.find((c) => c.name === 'form')?.outcome).toBe('fail');
    expect(v.outcome).toBe('fail');
    expect(v.flags).toContain('rule_verify_fail');
  });
});
