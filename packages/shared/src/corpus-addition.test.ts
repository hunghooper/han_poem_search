import { describe, expect, it } from 'vitest';
import { CorpusAdditionSchema, checkRow, hanCount, MIN_HAN_CHARS } from './corpus-addition.js';

const good = {
  title: '靜夜思',
  author: '李白',
  text: '床前明月光，疑是地上霜。',
};

describe('checkRow', () => {
  it('accepts a row with title, author and enough Han text', () => {
    const c = checkRow(good, 0);
    expect(c.ok).toBe(true);
    expect(c.missing).toEqual([]);
    expect(c.chars).toBe(10);
  });

  it('names every missing required field, not just the first', () => {
    expect(checkRow({ text: '床前明月光' }, 0).missing.sort()).toEqual(['author', 'title']);
  });

  it('separates an absent text from a text that is not Han verse', () => {
    expect(checkRow({ ...good, text: '' }, 0).missing).toEqual(['text']);
    expect(checkRow({ ...good, text: 'hello there' }, 0).missing).toEqual(['text_han']);
  });

  it('refuses text below the four-character floor', () => {
    expect(checkRow({ ...good, text: '明月' }, 0).ok).toBe(false);
    expect(checkRow({ ...good, text: '床前明月' }, 0).ok).toBe(true);
  });

  it('refuses a whole book pasted into one row', () => {
    expect(checkRow({ ...good, text: '月'.repeat(5000) }, 0).missing).toEqual(['text_long']);
  });

  it('trims before judging, so whitespace is not a value', () => {
    expect(checkRow({ ...good, author: '   ' }, 0).missing).toEqual(['author']);
  });

  it('counts Han characters, not punctuation or spaces', () => {
    expect(hanCount('床前明月光，疑是地上霜。')).toBe(10);
    expect(hanCount('abc 123')).toBe(0);
  });
});

describe('CorpusAdditionSchema', () => {
  it('accepts a well-formed poem', () => {
    expect(CorpusAdditionSchema.safeParse(good).success).toBe(true);
  });

  it('refuses unknown fields rather than dropping them', () => {
    const r = CorpusAdditionSchema.safeParse({ ...good, translation: 'Trước giường ánh trăng' });
    expect(r.success).toBe(false);
  });

  it('applies the same Han floor the browser check applies', () => {
    const r = CorpusAdditionSchema.safeParse({ ...good, text: '月' });
    expect(r.success).toBe(false);
    expect(r.success === false && r.error.issues[0]?.message).toContain(String(MIN_HAN_CHARS));
  });

  it('refuses a source_url that is not a url', () => {
    expect(CorpusAdditionSchema.safeParse({ ...good, source_url: 'not a url' }).success).toBe(
      false,
    );
    expect(
      CorpusAdditionSchema.safeParse({ ...good, source_url: 'https://a.example/1' }).success,
    ).toBe(true);
  });
});
