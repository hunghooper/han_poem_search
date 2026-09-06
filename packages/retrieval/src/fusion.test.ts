import { describe, expect, it } from 'vitest';
import { reciprocalRankFusion, RRF_K } from './fusion.js';

const id = (s: { id: string }) => s.id;
const doc = (i: string) => ({ id: i });

describe('reciprocalRankFusion', () => {
  it('scores a single list by reciprocal rank', () => {
    const [first, second] = reciprocalRankFusion([{ source: 'bm25', items: [doc('a'), doc('b')] }], id);
    expect(first!.score).toBeCloseTo(1 / (RRF_K + 1));
    expect(second!.score).toBeCloseTo(1 / (RRF_K + 2));
  });

  it('rewards a document that several retrievers agree on', () => {
    const fused = reciprocalRankFusion(
      [
        { source: 'bm25', items: [doc('a'), doc('shared')] },
        { source: 'vector', items: [doc('b'), doc('shared')] },
      ],
      id,
    );
    // 'shared' is second in both lists, so it beats either list's first place.
    expect(fused[0]!.item.id).toBe('shared');
    expect(fused[0]!.agreement).toBe(2);
    expect(fused[0]!.ranks).toEqual({ bm25: 2, vector: 2 });
  });

  it('needs no score calibration — only order matters', () => {
    // Same order, wildly different underlying scales.
    const a = reciprocalRankFusion([{ source: 'x', items: [doc('p'), doc('q')] }], id);
    const b = reciprocalRankFusion([{ source: 'y', items: [doc('p'), doc('q')] }], id);
    expect(a.map((f) => f.item.id)).toEqual(b.map((f) => f.item.id));
    expect(a[0]!.score).toBeCloseTo(b[0]!.score);
  });

  it('breaks score ties by agreement', () => {
    const fused = reciprocalRankFusion(
      [
        { source: 'a', items: [doc('solo')] },
        { source: 'b', items: [doc('both')] },
        { source: 'c', items: [doc('both')] },
      ],
      id,
    );
    expect(fused[0]!.item.id).toBe('both');
  });

  it('merges representations of the same document', () => {
    const fused = reciprocalRankFusion<{ id: string; title?: string; author?: string }>(
      [
        { source: 'exact', items: [{ id: 'x', title: '旅夜書懷' }] },
        { source: 'vector', items: [{ id: 'x', author: '杜甫' }] },
      ],
      (d) => d.id,
      (a, b) => ({ ...b, ...a }),
    );
    expect(fused[0]!.item).toEqual({ id: 'x', title: '旅夜書懷', author: '杜甫' });
  });

  it('handles empty and single-item lists without special-casing', () => {
    expect(reciprocalRankFusion([], id)).toEqual([]);
    expect(reciprocalRankFusion([{ source: 'a', items: [] }], id)).toEqual([]);
    expect(reciprocalRankFusion([{ source: 'a', items: [doc('only')] }], id)).toHaveLength(1);
  });

  it('is deterministic for the same input', () => {
    const lists = [
      { source: 'bm25', items: [doc('a'), doc('b'), doc('c')] },
      { source: 'vector', items: [doc('c'), doc('a')] },
    ];
    expect(reciprocalRankFusion(lists, id)).toEqual(reciprocalRankFusion(lists, id));
  });
});
