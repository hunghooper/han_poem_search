import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';

interface StrainRecord {
  id?: string;
  strains?: string[];
}

class DisjointSet {
  private readonly parent = new Map<string, string>();

  find(x: string): string {
    const p = this.parent.get(x);
    if (p === undefined) {
      this.parent.set(x, x);
      return x;
    }
    if (p === x) return x;
    const root = this.find(p);
    this.parent.set(x, root);
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }

  groups(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const key of this.parent.keys()) {
      const root = this.find(key);
      const list = out.get(root) ?? [];
      list.push(key);
      out.set(root, list);
    }
    return out;
  }
}

async function buildToneTable(
  root: string,
  textById: Map<string, string>,
): Promise<Record<string, { ping: number; ze: number }>> {
  const dir = join(root, 'strains', 'json');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  const table: Record<string, { ping: number; ze: number }> = {};
  let aligned = 0;
  let skipped = 0;

  for (const file of files) {
    const rows = JSON.parse(await readFile(join(dir, file), 'utf8')) as StrainRecord[];
    if (!Array.isArray(rows)) continue;

    for (const row of rows) {
      if (!row.id || !Array.isArray(row.strains)) continue;
      const text = textById.get(row.id);
      if (!text) continue;

      const tones = row.strains.join('').replace(/[，。！？；、]/gu, '');
      if (tones.length !== text.length) {
        skipped += 1;
        continue;
      }

      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i]!;
        const t = tones[i]!;
        if (t !== '平' && t !== '仄') continue;
        const entry = table[ch] ?? { ping: 0, ze: 0 };
        if (t === '平') entry.ping += 1;
        else entry.ze += 1;
        table[ch] = entry;
      }
      aligned += 1;
    }
  }

  console.log(
    `tone: aligned ${aligned} poems, skipped ${skipped} misaligned, ${Object.keys(table).length} characters`,
  );
  return table;
}

const MIN_EDGE_WEIGHT = 4;

function buildRhymeGroups(poems: Array<{ finals: string[] }>): Record<string, number> {
  const edges = new Map<string, number>();
  let used = 0;

  for (const p of poems) {
    const finals = [...new Set(p.finals.filter(Boolean))];
    if (finals.length < 2) continue;
    used += 1;
    for (let i = 0; i < finals.length; i += 1) {
      for (let j = i + 1; j < finals.length; j += 1) {
        const a = finals[i]!;
        const b = finals[j]!;
        const key = a < b ? a + b : b + a;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
  }

  const ds = new DisjointSet();
  let kept = 0;
  for (const [key, weight] of edges) {
    if (weight < MIN_EDGE_WEIGHT) continue;
    ds.union(key.slice(0, 1), key.slice(1));
    kept += 1;
  }

  const groups = ds.groups();
  const out: Record<string, number> = {};
  let id = 0;
  const sizes: number[] = [];
  for (const [, members] of groups) {
    if (members.length < 3) continue;
    for (const m of members) out[m] = id;
    sizes.push(members.length);
    id += 1;
  }

  sizes.sort((a, b) => b - a);
  console.log(
    `rhyme: ${used} poems, ${edges.size} candidate edges, ${kept} above weight ${MIN_EDGE_WEIGHT}, ` +
      `${id} classes covering ${Object.keys(out).length} characters; largest ${sizes.slice(0, 8).join(', ')}`,
  );
  return out;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const root = process.env.CORPUS_DATA_DIR ?? './data/chinese-poetry';
  const outDir = fileURLToPath(new URL('../../retrieval/src/data/', import.meta.url));
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const db = drizzle(pool);

  try {
    const poemsRes = await db.execute<{ upstreamId: string; textMatch: string }>(sql`
      SELECT upstream_id AS "upstreamId", text_match AS "textMatch"
      FROM poem WHERE upstream_id IS NOT NULL
    `);
    const poemRows = Array.isArray(poemsRes) ? poemsRes : poemsRes.rows;
    const textById = new Map(poemRows.map((r) => [r.upstreamId, r.textMatch]));
    console.log(`poems with upstream id: ${textById.size}`);

    const tone = await buildToneTable(root, textById);

    const rhymeRes = await db.execute<{ poemId: string; finals: string[] }>(sql`
      SELECT p.id AS "poemId", array_agg(pl.rhyme_char ORDER BY pl.line_no) AS "finals"
      FROM poem p
      JOIN poem_line pl ON pl.poem_id = p.id
      WHERE p.line_count IN (4, 8)
        AND pl.line_no % 2 = 1
        AND pl.rhyme_char IS NOT NULL
        AND p.id IN (
          SELECT poem_id FROM poem_line
          GROUP BY poem_id
          HAVING count(DISTINCT char_count) = 1 AND min(char_count) IN (5, 7)
        )
      GROUP BY p.id
    `);
    const rhymeRows = Array.isArray(rhymeRes) ? rhymeRes : rhymeRes.rows;
    const rhyme = buildRhymeGroups(rhymeRows.map((r) => ({ finals: r.finals ?? [] })));

    const payload = {
      $comment:
        'DERIVED FROM THE CORPUS, not from an authoritative 平水韻 table — see ADR 007. tone[ch] counts how often strains/ marked that character 平 vs 仄; a character with both is genuinely 多音. rhyme[ch] is an empirical 韻部 class id from the transitive closure of even-line finals in regulated verse.',
      $corpusCommit: process.env.CORPUS_COMMIT_SHA ?? '',
      $builtAt: new Date().toISOString(),
      tone,
      rhyme,
    };

    await mkdir(dirname(join(outDir, 'prosody.json')), { recursive: true });
    await writeFile(join(outDir, 'prosody.json'), JSON.stringify(payload), 'utf8');
    console.log(`wrote ${outDir}/prosody.json`);
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
