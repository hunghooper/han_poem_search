import { QdrantClient } from '@qdrant/js-client-rest';
import { AppError } from '@han/shared/errors';

export interface CollectionMeta {
  modelId: string;
  dim: number;
  normalized: boolean;
  openccConfig: string;
  corpusCommitSha: string;
  builtAt: string;
  pointCount: number;
}

export const META_POINT_ID = 0;

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

  async createVersion(name: string, dim: number): Promise<void> {
    await this.client.createCollection(name, {
      vectors: { size: dim, distance: 'Cosine' },
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

  async finalize(name: string): Promise<void> {
    await this.client.updateCollection(name, {
      optimizers_config: { indexing_threshold: 20000 },
    });
  }

  async flipAlias(toCollection: string): Promise<void> {
    await this.client.updateCollectionAliases({
      actions: [
        { delete_alias: { alias_name: this.alias } },
        { create_alias: { alias_name: this.alias, collection_name: toCollection } },
      ],
    });
  }

  async search(vector: number[], limit: number): Promise<VectorHit[]> {
    const res = await this.client.query(this.alias, {
      query: vector,
      limit,
      with_payload: true,
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
