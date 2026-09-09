import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { normalize, toMatchForm } from '@han/retrieval/normalize';
import { author, ingestRun, poem, poemLine, schema, work } from '@han/db/schema';
import { paragraphsToLines } from './lines.js';
import { contentHash, deriveWorkKey } from './work-id.js';
import { readAuthors, readQuanTangShi, readSongCi, type RawPoem } from './parse.js';

const BATCH = 500;

interface Options {
  root: string;
  commitSha: string;
  databaseUrl: string;
  limit: number | null;
}

interface Prepared {
  work: { workKey: string; title: string | null; authorId: string | null; dynasty: string | null };
  poem: {
    edition: string;
    upstreamId: string | null;
    titleDisplay: string | null;
    titleMatch: string | null;
    rhythmic: string | null;
    textDisplay: string;
    textTrad: string;
    textSimp: string;
    textMatch: string;
    charCount: number;
    lineCount: number;
    dataset: string;
    sourceFile: string;
    commitSha: string;
    contentHash: string;
  };
  lines: Array<{ display: string; match: string }>;
}

function prepare(
  raw: RawPoem,
  commitSha: string,
  authorIdByName: Map<string, string>,
): Prepared | null {
  const sentences = paragraphsToLines(raw.paragraphs);
  if (sentences.length === 0) return null;

  const lines = sentences
    .map((s) => ({ display: s, match: toMatchForm(s) }))
    .filter((l) => l.match.length > 0);
  if (lines.length === 0) return null;

  const full = normalize(raw.paragraphs.join(''));
  if (full.textMatch.length === 0) return null;

  const firstLine = lines[0]?.match ?? '';
  const workKey = deriveWorkKey({ author: raw.author, title: raw.title, firstLine });

  return {
    work: {
      workKey,
      title: raw.title,
      authorId: raw.author ? (authorIdByName.get(toMatchForm(raw.author)) ?? null) : null,
      dynasty: raw.edition === '宋詞' ? '宋' : '唐',
    },
    poem: {
      edition: raw.edition,
      upstreamId: raw.upstreamId,
      titleDisplay: raw.title,
      titleMatch: raw.title ? toMatchForm(raw.title) : null,
      rhythmic: raw.rhythmic,
      textDisplay: raw.paragraphs.join('\n'),
      textTrad: full.textTrad,
      textSimp: full.textSimp,
      textMatch: full.textMatch,
      charCount: full.textMatch.length,
      lineCount: lines.length,
      dataset: 'chinese-poetry',
      sourceFile: raw.sourceFile,
      commitSha,
      contentHash: contentHash(raw.edition, raw.sourceFile, full.textMatch, raw.title),
    },
    lines,
  };
}

async function run(opts: Options): Promise<void> {
  const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: 4 });
  const db = drizzle(pool, { schema });
  const started = Date.now();

  const runRow = await db
    .insert(ingestRun)
    .values({ commitSha: opts.commitSha, collections: ['全唐詩', '宋詞'] })
    .returning({ id: ingestRun.id });
  const runId = runRow[0]?.id;

  try {
    const rawAuthors = await readAuthors(opts.root);
    const authorIdByName = new Map<string, string>();
    for (let i = 0; i < rawAuthors.length; i += BATCH) {
      const rows = rawAuthors.slice(i, i + BATCH).map((a) => ({
        nameDisplay: a.name,
        nameMatch: toMatchForm(a.name),
        dynasty: a.edition === '宋詞' ? '宋' : null,
        bio: a.bio,
        dataset: 'chinese-poetry',
        sourceFile: a.sourceFile,
        commitSha: opts.commitSha,
      }));
      const inserted = await db
        .insert(author)
        .values(rows)
        .returning({ id: author.id, nameMatch: author.nameMatch });
      for (const r of inserted)
        if (!authorIdByName.has(r.nameMatch)) authorIdByName.set(r.nameMatch, r.id);
    }
    console.log(`authors: ${rawAuthors.length}`);

    const collections: Array<[string, () => Promise<RawPoem[]>]> = [
      ['全唐詩', () => readQuanTangShi(opts.root, 'tang')],
      ['宋詞', () => readSongCi(opts.root)],
    ];

    let poemCount = 0;
    let lineCount = 0;

    for (const [label, load] of collections) {
      const all = await load();
      const raws = opts.limit === null ? all : all.slice(0, opts.limit);
      console.log(`${label}: ingesting ${raws.length} of ${all.length} records`);

      for (let i = 0; i < raws.length; i += BATCH) {
        const prepared = raws
          .slice(i, i + BATCH)
          .map((raw) => prepare(raw, opts.commitSha, authorIdByName))
          .filter((p): p is Prepared => p !== null);
        if (prepared.length === 0) continue;

        const uniqueWorks = new Map(prepared.map((p) => [p.work.workKey, p.work]));
        const workRows = await db
          .insert(work)
          .values([...uniqueWorks.values()])
          .onConflictDoUpdate({ target: work.workKey, set: { title: sql`excluded.title` } })
          .returning({ id: work.id, workKey: work.workKey });
        const workIdByKey = new Map(workRows.map((w) => [w.workKey, w.id]));

        const uniquePoems = new Map(prepared.map((p) => [p.poem.contentHash, p]));
        const poemRows = await db
          .insert(poem)
          .values(
            [...uniquePoems.values()].map((p) => ({
              ...p.poem,
              workId: workIdByKey.get(p.work.workKey) ?? '',
            })),
          )
          .onConflictDoNothing({ target: poem.contentHash })
          .returning({ id: poem.id, contentHash: poem.contentHash, workId: poem.workId });

        const lineValues = poemRows.flatMap((row) => {
          const p = uniquePoems.get(row.contentHash);
          if (!p) return [];
          return p.lines.map((l, n) => ({
            poemId: row.id,
            workId: row.workId,
            lineNo: n,
            textDisplay: l.display,
            textMatch: l.match,
            charCount: l.match.length,
            rhymeChar: l.match.slice(-1) || null,
          }));
        });

        for (let j = 0; j < lineValues.length; j += BATCH) {
          await db
            .insert(poemLine)
            .values(lineValues.slice(j, j + BATCH))
            .onConflictDoNothing();
        }

        poemCount += poemRows.length;
        lineCount += lineValues.length;
        if (i % (BATCH * 20) === 0) console.log(`  ${i + prepared.length}/${raws.length}`);
      }
      console.log(`  ${label} done — running total ${poemCount} poems, ${lineCount} lines`);
    }

    if (runId) {
      await db
        .update(ingestRun)
        .set({ poemCount, lineCount, finishedAt: new Date() })
        .where(eq(ingestRun.id, runId));
    }
    console.log(
      `ingest complete: ${poemCount} poems, ${lineCount} lines in ${Date.now() - started}ms`,
    );
  } finally {
    await pool.end();
  }
}

const argv = process.argv.slice(2);
const limitIdx = argv.indexOf('--limit');
const explicitLimit = limitIdx >= 0 ? Number(argv[limitIdx + 1]) : NaN;
const limit = Number.isFinite(explicitLimit)
  ? explicitLimit
  : argv.includes('--sample')
    ? 2000
    : null;

run({
  root: process.env.CORPUS_DATA_DIR ?? './data/chinese-poetry',
  commitSha: process.env.CORPUS_COMMIT_SHA ?? '',
  databaseUrl: process.env.DATABASE_URL ?? '',
  limit,
}).catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
