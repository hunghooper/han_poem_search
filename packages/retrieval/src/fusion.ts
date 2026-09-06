/**
 * Reciprocal Rank Fusion — the spec §7.2.
 *
 *     rrfScore(doc) = Σ over lists  1 / (k + rank_in_list(doc))
 *
 * RRF needs no score calibration, which is the entire point: BM25 scores are unbounded sums
 * of idf terms, cosine similarity is in [-1, 1], and exact-match run length is a character
 * count. Normalising three incomparable scales into one would require calibration data we do
 * not have (§8 says the thresholds are uncalibrated). Rank is the only thing all three agree
 * on, so fuse on rank and let the reranker do the scoring.
 *
 * Consequence worth stating plainly: RRF discards magnitude. A document ranked first by a
 * retriever that is certain and a document ranked first by a retriever that is guessing
 * contribute identically. That is why fusion feeds a reranker rather than the answer, and why
 * the confidence policy reads rerank scores rather than RRF scores.
 */

/** Default from the brief; configurable per §7.2. Larger k flattens the contribution of rank. */
export const RRF_K = 60;

export interface RankedList<T> {
  source: string;
  /** Descending by that source's own relevance. Ranks are assigned from this order. */
  items: T[];
}

export interface FusedItem<T> {
  item: T;
  score: number;
  /** Rank in each list that contributed, keyed by source. 1-based. */
  ranks: Record<string, number>;
  /** How many retrievers found this at all — a useful signal the score alone hides. */
  agreement: number;
}

/**
 * Fuse ranked lists. `key` maps an item to its identity across lists; items sharing a key are
 * the same document seen by different retrievers.
 *
 * `merge` decides which representation survives when two lists disagree about the same
 * document — normally the richer one, since retrievers return different fields.
 */
export function reciprocalRankFusion<T>(
  lists: ReadonlyArray<RankedList<T>>,
  key: (item: T) => string,
  merge: (a: T, b: T) => T = (a) => a,
  k: number = RRF_K,
): Array<FusedItem<T>> {
  const acc = new Map<string, FusedItem<T>>();

  for (const list of lists) {
    list.items.forEach((item, index) => {
      const rank = index + 1;
      const id = key(item);
      const existing = acc.get(id);
      const contribution = 1 / (k + rank);

      if (existing) {
        existing.score += contribution;
        existing.ranks[list.source] = rank;
        existing.agreement += 1;
        existing.item = merge(existing.item, item);
      } else {
        acc.set(id, {
          item,
          score: contribution,
          ranks: { [list.source]: rank },
          agreement: 1,
        });
      }
    });
  }

  return [...acc.values()].sort(
    // Ties on score are common with few lists; agreement breaks them in favour of the document
    // more than one retriever found, which is the whole reason for running more than one.
    (a, b) => b.score - a.score || b.agreement - a.agreement,
  );
}
