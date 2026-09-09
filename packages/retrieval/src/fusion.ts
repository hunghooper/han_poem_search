export const RRF_K = 60;

export interface RankedList<T> {
  source: string;
  items: T[];
}

export interface FusedItem<T> {
  item: T;
  score: number;
  ranks: Record<string, number>;
  agreement: number;
}

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

  return [...acc.values()].sort((a, b) => b.score - a.score || b.agreement - a.agreement);
}
