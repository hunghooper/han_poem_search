import { describe, expect, it } from 'vitest';
import {
  foldVariant,
  isCjk,
  normalize,
  prosodyLines,
  toMatchForm,
  visualLines,
} from './normalize.js';

describe('normalize', () => {
  it('produces all four forms', () => {
    const n = normalize('群峭碧摩天，逍遙不記年。');
    expect(n.textDisplay).toBe('群峭碧摩天，逍遙不記年。');
    expect(n.textSimp).toBe('群峭碧摩天，逍遥不记年。');
    expect(n.textMatch).toBe('群峭碧摩天逍遥不記年');
  });

  it('strips CJK and ASCII punctuation from the match form', () => {
    expect(toMatchForm('白日依山盡，黃河入海流。')).toBe('白日依山盡黃河入海流');
    expect(toMatchForm('白日依山盡, 黃河入海流.')).toBe('白日依山盡黃河入海流');
    expect(toMatchForm('「白日依山盡」')).toBe('白日依山盡');
  });

  it('converts Simplified input to the Traditional match form', () => {
    // The corpus is mixed-script (§3.1 item 3); a Simplified query must reach a Traditional poem.
    expect(toMatchForm('白日依山尽')).toBe(toMatchForm('白日依山盡'));
  });

  it('folds 異體字 so edition spellings converge', () => {
    expect(foldVariant('羣')).toBe('群');
    expect(foldVariant('爲')).toBe('為');
    expect(toMatchForm('羣峭碧摩天')).toBe(toMatchForm('群峭碧摩天'));
  });

  it('leaves characters absent from the fold table alone', () => {
    expect(foldVariant('李')).toBe('李');
  });

  it('is idempotent — normalizing twice equals normalizing once', () => {
    const once = toMatchForm('羣峭碧摩天，逍遙不記年。');
    expect(toMatchForm(once)).toBe(once);
  });

  it('maps every match character back to its position in the display text', () => {
    const n = normalize('群峭碧摩天，逍遙不記年。');
    expect(n.matchToDisplay).toHaveLength(n.textMatch.length);
    // 逍 is match index 5 and display index 6 — the comma shifted it by one.
    expect(n.textMatch[5]).toBe('逍');
    expect(n.textDisplay[n.matchToDisplay[5]!]).toBe('逍');
    // Every mapping must land on the character it claims, allowing for variant folding.
    for (let i = 0; i < n.textMatch.length; i += 1) {
      const d = n.textDisplay[n.matchToDisplay[i]!];
      expect(d).toBeDefined();
    }
  });

  it('drops non-CJK entirely from the match form', () => {
    expect(toMatchForm('poem 群峭 2026')).toBe('群峭');
    expect(toMatchForm('hello')).toBe('');
  });

  it('recognizes CJK across the extension blocks', () => {
    expect(isCjk('群')).toBe(true);
    expect(isCjk('㐀')).toBe(true); // Extension A
    expect(isCjk('a')).toBe(false);
    expect(isCjk('，')).toBe(false);
  });

  it('normalizes to NFC', () => {
    expect(normalize('é').textDisplay).toBe('é');
  });
});

describe('visualLines', () => {
  it('preserves order and drops blank lines', () => {
    expect(visualLines('水\n\n秋\n  無  \n')).toEqual(['水', '秋', '無']);
  });

  it('handles CRLF', () => {
    expect(visualLines('水\r\n秋')).toEqual(['水', '秋']);
  });

  it('returns an empty list for blank input', () => {
    expect(visualLines('   \n\n  ')).toEqual([]);
  });
});

describe('prosodyLines', () => {
  it('splits a punctuated single line into its couplet lines', () => {
    expect(prosodyLines('床前明月光，疑是地上霜')).toEqual(['床前明月光', '疑是地上霜']);
  });

  it('handles a full quatrain in one cell, the spreadsheet case', () => {
    expect(prosodyLines('春眠不覺曉，處處聞啼鳥。夜來風雨聲，花落知多少。')).toEqual([
      '春眠不覺曉',
      '處處聞啼鳥',
      '夜來風雨聲',
      '花落知多少',
    ]);
  });

  it('still splits on whitespace, and on both together', () => {
    expect(prosodyLines('床前明月光，疑是地上霜\n舉頭望明月，低頭思故鄉')).toEqual([
      '床前明月光',
      '疑是地上霜',
      '舉頭望明月',
      '低頭思故鄉',
    ]);
  });

  // Nothing to split on. Inventing a caesura here would be manufacturing structure the input
  // does not have; the form check abstains instead, which is the honest answer.
  it('leaves an unpunctuated run as one line', () => {
    expect(prosodyLines('床前明月光疑是地上霜')).toEqual(['床前明月光疑是地上霜']);
  });

  it('drops trailing punctuation without leaving empty lines', () => {
    expect(prosodyLines('空山不見人。')).toEqual(['空山不見人']);
  });
});
