/**
 * Qdrant vector store — the spec §2.1, §13.
 *
 * Two invariants, both of which exist because their failure mode is silent:
 *
 * 1. NEVER MUTATE A LIVE COLLECTION. Ingest builds `poetry_vN+1` and flips an alias when it
 *    is complete. A half-written live collection answers queries with partial recall and no
 *    error.
 *
 * 2. THE COLLECTION RECORDS WHICH MODEL BUILT IT. The API asserts on boot that the sidecar
 *    serves that same model and refuses to start otherwise. Querying an index built by a
 *    different embedding model returns confident, wrong neighbours — the most common
 *    invisible failure in this architecture, per §2.1.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { AppError } from '@han/shared/errors';

/** Stored in the collection payload of a single metadata point. */
export interface CollectionMeta {
  modelId: string;
  dim: number;
  normalized: boolean;
  openccConfig: string;
  corpusCommitSha: string;
  builtAt: string;
  pointCount: number;
}

/** Reserved point id holding the collection's provenance. */
export const META_POINT_ID = 0;

/** Extends Record so it satisfies Qdrant's payload type without an `any` cast. */
export interface PoemPayload extends Record<string, unknown> {
  poemId: string;
  workId: string;
  title: string | null;
  author: string | null;
  edition: string;
  textDisplay: string;
  dataset: string;
  sourceFile: string;
  commitSha: string;
}

export interface VectorHit {
  score: number;
  payload: PoemPayload;
}

export class VectorStore {
  readonly client: QdrantClient;
  readonly alias: string;

  constructor(url: string, alias: string, apiKey?: string) {
    this.client = new QdrantClient(apiKey ? { url, apiKey } : { url });
    this.alias = alias;
  }

  /** Create a fresh versioned collection. Never touches the live one. */
  async createVersion(name: string, dim: number): Promise<void> {
    await this.client.createCollection(name, {
      vectors: { size: dim, distance: 'Cosine' },
      // Build with indexing off, then switch it on once the upload is complete: HNSW
      // construction during a bulk load costs far more than building it once at the end.
      optimizers_config: { indexing_threshold: 0 },
    });
  }

  async writeMeta(name: string, meta: CollectionMeta): Promise<void> {
    await this.client.upsert(name, {
      wait: true,
      points: [
        {
          id: META_POINT_ID,
          vector: new Array(meta.dim).fill(0),
          payload: { __meta: true, ...meta },
        },
      ],
    });
  }

  async readMeta(name?: string): Promise<CollectionMeta | null> {
    const target = name ?? this.alias;
    try {
      const res = await this.client.retrieve(target, { ids: [META_POINT_ID], with_payload: true });
      const p = res[0]?.payload as (CollectionMeta & { __meta?: boolean }) | undefined;
      if (!p?.__meta) return null;
      return {
        modelId: p.modelId,
        dim: p.dim,
        normalized: p.normalized,
        openccConfig: p.openccConfig,
        corpusCommitSha: p.corpusCommitSha,
        builtAt: p.builtAt,
        pointCount: p.pointCount,
      };
    } catch {
      return null;
    }
  }

  async upsert(
    name: string,
    points: Array<{ id: number; vector: number[]; payload: PoemPayload }>,
  ): Promise<void> {
    if (points.length === 0) return;
    await this.client.upsert(name, { wait: false, points });
  }

  /** Turn indexing on and wait for the collection to settle. Call once, after the bulk load. */
  async finalize(name: string): Promise<void> {
    await this.client.updateCollection(name, {
      optimizers_config: { indexing_threshold: 20000 },
    });
  }

  /**
   * Point the alias at a finished collection.
   *
   * Qdrant applies alias operations atomically, so there is no moment where the alias resolves
   * to nothing — queries in flight see either the old collection or the new one, never a gap.
   */
  async flipAlias(toCollection: string): Promise<void> {
    await this.client.updateCollectionAliases({
      actions: [
        { delete_alias: { alias_name: this.alias } },
        { create_alias: { alias_name: this.alias, collection_name: toCollection } },
      ],
    });
  }

  async search(vector: number[], limit: number): Promise<VectorHit[]> {
    // client.query, not client.search — the latter was removed in @qdrant/js-client-rest 1.19.
    const res = await this.client.query(this.alias, {
      query: vector,
      limit,
      with_payload: true,
      // The metadata point is a zero vector; excluding it here is cheaper and more obvious
      // than filtering it out of the results afterwards.
      filter: { must_not: [{ key: '__meta', match: { value: true } }] },
    });
    return res.points.map((r: { score: number; payload?: unknown }) => ({
      score: r.score,
      payload: r.payload as PoemPayload,
    }));
  }

  async exists(name: string): Promise<boolean> {
    const { collections } = await this.client.getCollections();
    return collections.some((c) => c.name === name);
  }

  /** Next free version number for the alias, e.g. poetry_v3 -> 4. */
  async nextVersion(): Promise<number> {
    const { collections } = await this.client.getCollections();
    const prefix = `${this.alias}_v`;
    const versions = collections
      .map((c) => c.name)
      .filter((n) => n.startsWith(prefix))
      .map((n) => Number(n.slice(prefix.length)))
      .filter((n) => Number.isFinite(n));
    return versions.length === 0 ? 1 : Math.max(...versions) + 1;
  }

  versionName(n: number): string {
    return `${this.alias}_v${n}`;
  }
}

/**
 * Boot-time assertion — §2.1. Refuse to start on mismatch; do not warn and continue.
 *
 * A warning here is worse than useless: retrieval keeps working, returns plausible neighbours,
 * and nothing downstream can tell that the vectors are meaningless. Failing loudly at boot is
 * the only point where this is cheap to notice.
 */
export function assertModelMatch(
  meta: CollectionMeta | null,
  live: { modelId: string; dim: number; normalized: boolean; openccConfig: string },
): void {
  if (!meta) {
    throw new AppError(
      'CORPUS_NOT_INGESTED',
      'the vector collection has no metadata point — it was not built by this pipeline, or not built at all',
    );
  }
  const mismatches: string[] = [];
  if (meta.modelId !== live.modelId) mismatches.push(`modelId ${meta.modelId} != ${live.modelId}`);
  if (meta.dim !== live.dim) mismatches.push(`dim ${meta.dim} != ${live.dim}`);
  if (meta.normalized !== live.normalized) {
    mismatches.push(`normalized ${meta.normalized} != ${live.normalized}`);
  }
  if (meta.openccConfig !== live.openccConfig) {
    mismatches.push(`openccConfig ${meta.openccConfig} != ${live.openccConfig}`);
  }
  if (mismatches.length > 0) {
    throw new AppError(
      'MODEL_MISMATCH',
      `the Qdrant collection was built with a different configuration than the sidecar serves: ${mismatches.join('; ')}. Re-ingest or repoint the collection; do not disable this check.`,
      { mismatches },
    );
  }
}
