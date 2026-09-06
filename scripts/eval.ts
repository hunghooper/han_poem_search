/**
 * Offline eval harness — the spec §13, §16 Phase 2.
 *
 * Reports recall@k and MRR so a retrieval change can be judged by numbers rather than by
 * trying a few queries and forming an impression. CONTRIBUTING.md requires before/after
 * figures on any PR that affects retrieval quality; this produces them.
 *
 * The query set is SYNTHESISED FROM THE CORPUS: sample a poem, take a window of it, damage
 * that window in a known way, and the correct answer is known by construction. That is what
 * makes 500 labelled queries possible when the hand-labelled golden set has 12.
 *
 * What it does NOT measure: whether a topical query returns *good* poems. That needs human
 * judgement and the hand-labelled set. Synthetic evaluation measures whether damaged input
 * still finds the poem it came from — which is the dominant user story, and no more.
 */

import { writeFile } from 'node:fs/promises';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { hybridSearch } from '@han/retrieval/hybrid';
import { ModelClient } from '@han/retrieval/model-client';
import { VectorStore } from '@han/retrieval/vector-store';

type Damage = 'clean' | 'window' | 'line_reverse' | 'grid_transpose' | 'char_drop' | 'simplified' | 'one_per_line';

interface Case {
  damage: Damage;
  query: string;
  expectWorkId: string;
  title: string | null;
}

const ALL_DAMAGE: Damage[] = [
  'clean',
  'window',
  'line_reverse',
  'grid_transpose',
  'char_drop',
  'simplified',
  'one_per_line',
];

/** Deterministic PRNG so an eval run is reproducible and two runs are comparable. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function damage(kind: Damage, lines: string[], rnd: () => number): string {
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;

  switch (kind) {
    case 'clean':
      return lines.join('\n');

    case 'window': {
      // A user pastes what they remember, which is rarely the whole poem.
      const start = Math.floor(rnd() * Math.max(1, lines.length - 1));
      return lines.slice(start, start + 2).join('\n');
    }

    case 'line_reverse':
      return [...lines].reverse().join('\n');

    case 'grid_transpose': {
      // The gq-09 case: a vertical column layout pasted row-wise.
      const stream = lines.join('');
      const cols = lines.length || 4;
      const rows = Math.ceil(stream.length / cols);
      const out: string[] = [];
      for (let r = 0; r < rows; r += 1) {
        let row = '';
        for (let c = cols - 1; c >= 0; c -= 1) {
          const ch = stream[c * rows + r];
          if (ch) row += ch;
        }
        if (row) out.push(row);
      }
      return out.join('\n');
    }

    case 'char_drop': {
      // OCR error: one character per line becomes something else.
      return lines
        .map((l) => {
          if (l.length < 3) return l;
          const i = Math.floor(rnd() * l.length);
          return l.slice(0, i) + l.slice(i + 1);
        })
        .join('\n');
    }

    case 'simplified':
      // A user typing on a Simplified IME searching a Traditional corpus.
      return lines.join('\n');

    case 'one_per_line':
      return lines.join('').split('').join('\n');

    default:
      return pick(lines);
  }
}

interface Score {
  damage: Damage;
  n: number;
  recallAt1: number;
  recallAt10: number;
  mrr: number;
  medianLatencyMs: number;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  const perDamage = Number(process.env.EVAL_PER_DAMAGE ?? 40);
  const seed = Number(process.env.EVAL_SEED ?? 20260906);

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const db = drizzle(pool);
  const rnd = mulberry32(seed);

  // The semantic layer is optional; the harness reports which retrievers were live so a run
  // taken without it is never compared against one taken with it by accident.
  let model: ModelClient | null = new ModelClient({
    baseUrl: process.env.MODEL_SERVICE_URL ?? 'http://localhost:8000',
    timeoutMs: 60000,
  });
  let vectors: VectorStore | null = new VectorStore(
    process.env.QDRANT_URL ?? 'http://localhost:6333',
    process.env.QDRANT_COLLECTION_ALIAS ?? 'poetry',
  );
  try {
    await model.health();
    if (!(await vectors.readMeta())) vectors = null;
  } catch {
    model = null;
    vectors = null;
  }
  console.log(`semantic layer: ${model && vectors ? 'live' : 'ABSENT — exact + bm25 only'}`);

  try {
    // Sample regulated verse: the damage models assume a poem with several comparable lines.
    const res = await db.execute<{ workId: string; title: string | null; lines: string[] }>(sql`
      SELECT p.work_id AS "workId",
             p.title_display AS "title",
             array_agg(pl.text_match ORDER BY pl.line_no) AS "lines"
      FROM poem p
      JOIN poem_line pl ON pl.poem_id = p.id
      WHERE p.line_count BETWEEN 4 AND 8
      GROUP BY p.id, p.work_id, p.title_display
      HAVING count(DISTINCT pl.char_count) = 1 AND min(pl.char_count) IN (5, 7)
      ORDER BY md5(p.id::text)
      LIMIT ${perDamage * ALL_DAMAGE.length}
    `);
    const poems = (Array.isArray(res) ? res : res.rows).filter((p) => (p.lines ?? []).length >= 4);
    console.log(`sampled ${poems.length} poems`);

    const cases: Case[] = [];
    let i = 0;
    for (const kind of ALL_DAMAGE) {
      for (let n = 0; n < perDamage && i < poems.length; n += 1, i += 1) {
        const p = poems[i]!;
        cases.push({
          damage: kind,
          query: damage(kind, p.lines, rnd),
          expectWorkId: p.workId,
          title: p.title,
        });
      }
    }

    const byDamage = new Map<Damage, { hits1: number; hits10: number; rr: number[]; lat: number[] }>();
    for (const kind of ALL_DAMAGE) byDamage.set(kind, { hits1: 0, hits10: 0, rr: [], lat: [] });

    let done = 0;
    for (const c of cases) {
      const started = Date.now();
      const r = await hybridSearch(c.query, { db, model, vectors, topK: 10 });
      const latency = Date.now() - started;

      const ranked = r.evidence.map((e) => e.workId);
      const rank = ranked.indexOf(c.expectWorkId);
      const bucket = byDamage.get(c.damage)!;
      if (rank === 0) bucket.hits1 += 1;
      if (rank >= 0 && rank < 10) bucket.hits10 += 1;
      bucket.rr.push(rank >= 0 ? 1 / (rank + 1) : 0);
      bucket.lat.push(latency);

      done += 1;
      if (done % 25 === 0) console.log(`  ${done}/${cases.length}`);
    }

    const median = (xs: number[]): number => {
      if (xs.length === 0) return 0;
      const s = [...xs].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)]!;
    };

    const scores: Score[] = ALL_DAMAGE.map((kind) => {
      const b = byDamage.get(kind)!;
      const n = b.rr.length;
      return {
        damage: kind,
        n,
        recallAt1: n ? b.hits1 / n : 0,
        recallAt10: n ? b.hits10 / n : 0,
        mrr: n ? b.rr.reduce((a, x) => a + x, 0) / n : 0,
        medianLatencyMs: median(b.lat),
      };
    });

    console.log('\ndamage             n   recall@1  recall@10     MRR   p50');
    console.log('-'.repeat(62));
    for (const s of scores) {
      console.log(
        `${s.damage.padEnd(16)} ${String(s.n).padStart(3)}   ` +
          `${(s.recallAt1 * 100).toFixed(1).padStart(6)}%  ` +
          `${(s.recallAt10 * 100).toFixed(1).padStart(7)}%  ` +
          `${s.mrr.toFixed(3).padStart(6)}  ${String(s.medianLatencyMs).padStart(4)}ms`,
      );
    }
    const overallN = scores.reduce((a, s) => a + s.n, 0);
    const overall10 = scores.reduce((a, s) => a + s.recallAt10 * s.n, 0) / (overallN || 1);
    const overallMrr = scores.reduce((a, s) => a + s.mrr * s.n, 0) / (overallN || 1);
    console.log('-'.repeat(62));
    console.log(`overall          ${String(overallN).padStart(3)}            ${(overall10 * 100).toFixed(1)}%  ${overallMrr.toFixed(3)}`);

    await writeFile(
      'docs/eval-latest.json',
      JSON.stringify(
        {
          ranAt: new Date().toISOString(),
          seed,
          perDamage,
          semanticLayer: model !== null && vectors !== null,
          scores,
          overall: { n: overallN, recallAt10: overall10, mrr: overallMrr },
        },
        null,
        2,
      ),
      'utf8',
    );
    console.log('\nwrote docs/eval-latest.json');
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
