import { describe, expect, it } from 'vitest';
import { bigrams, bm25Term, idf, queryTerms, BM25_K1 } from './bm25.js';

describe('bigrams', () => {
  it('is the term unit — a 5-character line yields 4 terms', () => {
    expect(bigrams('細草微風岸')).toEqual(['細草', '草微', '微風', '風岸']);
  });

  it('yields nothing for a single character', () => {
    expect(bigrams('細')).toEqual([]);
    expect(bigrams('')).toEqual([]);
  });
});

describe('queryTerms', () => {
  it('deduplicates repeated bigrams', () => {
    expect(queryTerms('花花花花')).toEqual(['花花']);
  });

  it('caps the term count so a long paste stays bounded', () => {
    const long = Array.from({ length: 200 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join('');
    expect(queryTerms(long).length).toBeLessThanOrEqual(24);
  });

  it('preserves order, so the head of the query is always represented', () => {
    expect(queryTerms('細草微風岸', 2)).toEqual(['細草', '草微']);
  });
});

describe('idf', () => {
  it('gives a rare term more weight than a common one', () => {
    expect(idf(5, 78455)).toBeGreaterThan(idf(50000, 78455));
  });

  it('stays positive for a term present in every document', () => {
    // A negative idf would make a common bigram actively harmful to a document's score,
    // penalising poems for containing ordinary characters.
    expect(idf(78455, 78455)).toBeGreaterThan(0);
  });
});

describe('bm25Term', () => {
  it('saturates with term frequency rather than growing linearly', () => {
    const one = bm25Term(1, 30, 30, 1);
    const two = bm25Term(2, 30, 30, 1);
    const ten = bm25Term(10, 30, 30, 1);
    expect(two).toBeGreaterThan(one);
    // The k1 saturation means the 10th occurrence adds far less than the 2nd.
    expect(ten - two).toBeLessThan(two - one + BM25_K1);
  });

  it('penalises a longer document for the same term frequency', () => {
    expect(bm25Term(1, 20, 30, 1)).toBeGreaterThan(bm25Term(1, 60, 30, 1));
  });

  it('scales with idf', () => {
    expect(bm25Term(1, 30, 30, 2)).toBeCloseTo(2 * bm25Term(1, 30, 30, 1));
  });

  it('does not divide by zero on an empty corpus', () => {
    expect(Number.isFinite(bm25Term(1, 0, 0, 1))).toBe(true);
  });
});
