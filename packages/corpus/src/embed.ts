/**
 * Vector index build — the spec §13.
 *
 *   read poems -> embed via the sidecar -> write poetry_vN+1 -> flip the alias
 *
 * Never mutates the live collection. If this crashes halfway, the alias still points at the
 * previous complete index and search keeps working with the old data — which is a far better
 * failure than a live index with a hole in it.
 *
 * What gets embedded is the poem's DISPLAY text, not textMatch. Punctuation and script carry
 * meaning to a language model, and stripping them for the vector index would throw away the
 * exact signal the dense retriever is supposed to add over the n-gram index.
 */

import { sql } from 'drizzle-orm';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { ModelClient } from '@han/retrieval/model-client';
import { VectorStore, type PoemPayload } from '@han/retrieval/vector-store';

const EMBED_BATCH = 64;
const UPSERT_BATCH = 256;

interface Row extends Record<string, unknown> {
  id: string;
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

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const modelUrl = process.env.MODEL_SERVICE_URL ?? 'http://localhost:8000';
  const qdrantUrl = process.env.QDRANT_URL ?? 'http://localhost:6333';
  const alias = process.env.QDRANT_COLLECTION_ALIAS ?? 'poetry';
  const commitSha = process.env.CORPUS_COMMIT_SHA ?? '';
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : null;

  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

    // Generous: a 64-poem batch on a contended GPU can exceed two minutes, and an abort here
  // wastes the whole run. The build is long and unattended; failing it on a slow batch is the
  // wrong trade.
  const model = new ModelClient({ baseUrl: modelUrl, timeoutMs: 600000 });
  const health = await model.health();
  console.log(`sidecar: ${health.modelId} dim=${health.dim} device=${health.device}`);

  const store = new VectorStore(qdrantUrl, alias);
  const version = await store.nextVersion();
  const collection = store.versionName(version);
  console.log(`building ${collection}`);

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const db = drizzle(pool);

  try {
    const res = await db.execute<Row>(sql`
      SELECT
        p.id            AS "id",
        p.id            AS "poemId",
        p.work_id       AS "workId",
        p.title_display AS "title",
        a.name_display  AS "author",
        p.edition       AS "edition",
        p.text_display  AS "textDisplay",
        p.dataset       AS "dataset",
        p.source_file   AS "sourceFile",
        p.commit_sha    AS "commitSha"
      FROM poem p
      JOIN work w ON w.id = p.work_id
      LEFT JOIN author a ON a.id = w.author_id
      ORDER BY p.id
      ${limit ? sql`LIMIT ${limit}` : sql``}
    `);
    const rows: Row[] = Array.isArray(res) ? res : res.rows;
    console.log(`embedding ${rows.length} poems`);

    await store.createVersion(collection, health.dim);

    const started = Date.now();
    let done = 0;
    // Point ids start at 1: id 0 is reserved for the collection metadata point.
    let pointId = 1;
    let pending: Array<{ id: number; vector: number[]; payload: PoemPayload }> = [];

    for (let i = 0; i < rows.length; i += EMBED_BATCH) {
      const batch = rows.slice(i, i + EMBED_BATCH);
      // Title and author go into the embedded text: a topical query like "poems about autumn
      // moonlight by 李白" carries both, and a body-only embedding cannot represent the author.
      const texts = batch.map((r) =>
        [r.title, r.author, r.textDisplay].filter(Boolean).join('\n'),
      );
      const vectors = await model.embed(texts);

      for (let j = 0; j < batch.length; j += 1) {
        const r = batch[j]!;
        const vector = vectors[j];
        if (!vector) continue;
        pending.push({
          id: pointId,
          vector,
          payload: {
            poemId: r.poemId,
            workId: r.workId,
            title: r.title,
            author: r.author,
            edition: r.edition,
            textDisplay: r.textDisplay,
            dataset: r.dataset,
            sourceFile: r.sourceFile,
            commitSha: r.commitSha,
          },
        });
        pointId += 1;
      }

      if (pending.length >= UPSERT_BATCH) {
        await store.upsert(collection, pending);
        pending = [];
      }

      done += batch.length;
      if (i % (EMBED_BATCH * 20) === 0) {
        const rate = done / ((Date.now() - started) / 1000);
        const eta = Math.round((rows.length - done) / (rate || 1));
        console.log(`  ${done}/${rows.length}  ${rate.toFixed(0)}/s  eta ${eta}s`);
      }
    }
    if (pending.length > 0) await store.upsert(collection, pending);

    await store.writeMeta(collection, {
      modelId: health.modelId,
      dim: health.dim,
      normalized: health.normalized,
      openccConfig: health.openccConfig,
      corpusCommitSha: commitSha,
      builtAt: new Date().toISOString(),
      pointCount: pointId - 1,
    });
    await store.finalize(collection);

    // Alias flip is the last step and the only step that makes the new index visible.
    await store.flipAlias(collection);
    console.log(`alias ${alias} -> ${collection} (${pointId - 1} points, ${Math.round((Date.now() - started) / 1000)}s)`);
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
