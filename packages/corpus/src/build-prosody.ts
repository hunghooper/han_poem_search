/**
 * Derive prosody tables FROM the corpus — answers §18 Q6.
 *
 * ADR 004 established that `chinese-poetry` contains no 平水韻 rhyme table. The obvious
 * response is to source one externally. The better one is to notice that the corpus already
 * contains the information, twice over, and only needs it inverted:
 *
 * 1. TONE. `strains/` gives 平/仄 per character per poem, aligned to `poet.*.json` by id.
 *    Inverting that alignment yields a character -> tone table covering every character the
 *    corpus uses, derived from the same texts we search.
 *
 * 2. RHYME. In regulated verse the final characters of even-numbered lines share a 韻部. That
 *    is a rule the corpus obeys tens of thousands of times. Treating each well-formed poem as
 *    an assertion that its rhyme characters belong together, and taking the transitive closure
 *    with union-find, reconstructs the rhyme classes empirically.
 *
 * What this is NOT: an authoritative 平水韻. It is what THIS corpus behaves as if it believes,
 * which is the right standard for verifying candidates FROM this corpus — a candidate is being
 * checked for consistency with its own tradition, not against an external authority.
 *
 * Ambiguity is kept rather than resolved. 多音字 have both tones, and the tone table records
 * both with counts; a verifier that demands a single tone for 看 or 過 will reject correct
 * poems, because those characters genuinely take either.
 */

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

/** Union-find over rhyme characters. */
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

/** Build the character -> tone table from strains/, aligned to poem text by upstream id. */
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

      // The strain string carries the same punctuation as the poem, so both reduce to the same
      // length under the same stripping. When they do not, the record is misaligned and using
      // it would attribute every tone to the wrong character — skip rather than guess.
      const tones = row.strains.join('').replace(/[，。！？；、]/gu, '');
      if (tones.length !== text.length) {
        skipped += 1;
        continue;
      }

      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i]!;
        const t = tones[i]!;
        // ○ and ？ mark positions the source could not determine. Counting them as either tone
        // would poison the table with the corpus's own uncertainty.
        if (t !== '平' && t !== '仄') continue;
        const entry = table[ch] ?? { ping: 0, ze: 0 };
        if (t === '平') entry.ping += 1;
        else entry.ze += 1;
        table[ch] = entry;
      }
      aligned += 1;
    }
  }

  console.log(`tone: aligned ${aligned} poems, skipped ${skipped} misaligned, ${Object.keys(table).length} characters`);
  return table;
}

/**
 * Build empirical 韻部 classes from even-line finals of regulated verse.
 *
 * MEASURED FAILURE, then fixed. The first implementation took the transitive closure of every
 * co-rhyming pair. Over 37,801 poems that collapsed into 7 classes, the largest holding 3,445
 * of ~3,455 characters — a single chain of noisy links joined nearly every rhyme character in
 * the corpus. Union-find has no notion of evidence strength, so one 通韻 poem, one OCR error,
 * or one mis-segmented 古詩 permanently welds two genuine classes together.
 *
 * So edges are WEIGHTED by how many poems assert them, and only edges asserted at least
 * MIN_EDGE_WEIGHT times are unioned. A wrong pairing appears once or twice; a real 韻部
 * relation appears hundreds of times. The threshold is the whole difference between a rhyme
 * table and one enormous equivalence class.
 */
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
    // Singletons and pairs are not classes; they are characters we lack evidence about, and
    // recording them would let checkRhyme claim a judgement it cannot support.
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
  // Resolved from this module, not from cwd: the script runs under pnpm --filter, whose cwd
  // is the package directory, and a cwd-relative path silently writes the table into a nested
  // packages/retrieval/ inside packages/corpus/ where nothing will ever read it.
  const outDir = fileURLToPath(new URL('../../retrieval/src/data/', import.meta.url));
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const db = drizzle(pool);

  try {
    // Poems with an upstream id, for the tone alignment.
    const poemsRes = await db.execute<{ upstreamId: string; textMatch: string }>(sql`
      SELECT upstream_id AS "upstreamId", text_match AS "textMatch"
      FROM poem WHERE upstream_id IS NOT NULL
    `);
    const poemRows = Array.isArray(poemsRes) ? poemsRes : poemsRes.rows;
    const textById = new Map(poemRows.map((r) => [r.upstreamId, r.textMatch]));
    console.log(`poems with upstream id: ${textById.size}`);

    const tone = await buildToneTable(root, textById);

    // Even-line finals from perfectly regular 5- or 7-character poems of 4 or 8 lines. The
    // strictness is the point: only well-formed regulated verse asserts a rhyme relation, and
    // admitting 古詩 here is what would collapse every class into one.
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
