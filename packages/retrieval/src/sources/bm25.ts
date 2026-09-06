/**
 * bm25 — lexical retrieval over the corpus, for topical queries (the spec §7.2).
 *
 * Postgres full-text search is not usable here. `to_tsvector` needs word boundaries, and
 * classical Chinese has none: `to_tsvector('simple', '細草微風岸')` yields ONE token, the whole
 * line, so every query either matches a line exactly or not at all. Installing a CJK parser
 * (pg_jieba, zhparser) would tokenize by modern Mandarin vocabulary, which is the wrong
 * lexicon — 春風 is a word to a modern segmenter and two independent images in 唐詩.
 *
 * So the term unit is the CHARACTER BIGRAM, the same unit pg_bigm indexes. BM25 is computed
 * over bigrams with document frequencies read from the corpus. That keeps the lexical and
 * exact retrievers on one index and one notion of a term, which matters because §7.4 asks us
 * to distinguish "the index returned nothing" from "the index scored it low" — two different
 * tokenizations would make that distinction meaningless.
 */

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { toMatchForm } from '../normalize.js';

/** Standard BM25 constants. Tunable, but not tuned — see §8 on provisional numbers. */
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

export interface Bm25Hit {
  poemId: string;
  workId: string;
  title: string | null;
  author: string | null;
  edition: string;
  textDisplay: string;
  dataset: string;
  sourceFile: string;
  commitSha: string;
  score: number;
}

/** Character bigrams — the term unit. A 5-character line yields 4 terms. */
export function bigrams(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < text.length; i += 1) out.push(text.slice(i, i + 2));
  return out;
}

/**
 * Bigrams carrying enough information to be worth scoring.
 *
 * A 40-character query produces 39 bigrams, and probing all of them against a GIN index costs
 * more than the result justifies. Deduplicating and capping bounds the tail; document
 * frequency then does the real work of discounting common pairs.
 */
export function queryTerms(text: string, max = 24): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const b of bigrams(text)) {
    if (seen.has(b)) continue;
    seen.add(b);
    out.push(b);
    if (out.length >= max) break;
  }
  return out;
}

/** BM25 idf. The +1 inside the log keeps a term present in every document at a small positive
 *  weight rather than a negative one, which would make common bigrams actively harmful. */
export function idf(docsWithTerm: number, totalDocs: number): number {
  return Math.log(1 + (totalDocs - docsWithTerm + 0.5) / (docsWithTerm + 0.5));
}

export function bm25Term(tf: number, docLen: number, avgDocLen: number, termIdf: number): number {
  const norm = tf * (BM25_K1 + 1);
  const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * docLen) / (avgDocLen || 1));
  return termIdf * (norm / (denom || 1));
}

interface CorpusStats {
  totalDocs: number;
  avgDocLen: number;
}

let statsCache: CorpusStats | null = null;

/** Corpus-level constants. Cached: they change only on re-ingest. */
export async function corpusStats(
  db: NodePgDatabase<Record<string, never>>,
  refresh = false,
): Promise<CorpusStats> {
  if (statsCache && !refresh) return statsCache;
  const res = await db.execute<{ n: number; avg: number }>(
    sql`SELECT count(*)::int AS n, COALESCE(avg(char_count), 0)::float AS avg FROM poem`,
  );
  const row = (Array.isArray(res) ? res : res.rows)[0];
  statsCache = { totalDocs: row?.n ?? 0, avgDocLen: row?.avg ?? 1 };
  return statsCache;
}

export const resetStatsCache = (): void => {
  statsCache = null;
};

/**
 * Score candidate poems for a query.
 *
 * One statement: a lateral join collects the poems containing each query bigram, and the
 * aggregation computes tf, df and length in the database rather than shipping candidate rows
 * to Node to be counted. On 78k poems the difference is between a query and a data transfer.
 */
export async function bm25Search(
  db: NodePgDatabase<Record<string, never>>,
  query: string,
  limit = 50,
): Promise<Bm25Hit[]> {
  const match = toMatchForm(query);
  const terms = queryTerms(match);
  if (terms.length === 0) return [];

  const { totalDocs, avgDocLen } = await corpusStats(db);
  if (totalDocs === 0) return [];

  // Rows per term, capped: a bigram like 不可 appears in tens of thousands of poems, and the
  // cap bounds the work without changing the ranking of anything near the top.
  const perTerm = 400;

  const res = await db.execute<{
    poemId: string;
    workId: string;
    title: string | null;
    author: string | null;
    edition: string;
    textDisplay: string;
    dataset: string;
    sourceFile: string;
    commitSha: string;
    charCount: number;
    matchedTerms: number;
    dfs: number[];
  }>(sql`
    WITH t AS (
      SELECT DISTINCT unnest(${sql.param(terms)}::text[]) AS term
    ),
    hits AS (
      SELECT t.term, p.id AS poem_id
      FROM t
      CROSS JOIN LATERAL (
        SELECT id FROM poem WHERE text_match LIKE '%' || t.term || '%' LIMIT ${perTerm}
      ) p
    ),
    df AS (
      SELECT term, count(*)::int AS n FROM hits GROUP BY term
    )
    SELECT
      p.id             AS "poemId",
      p.work_id        AS "workId",
      p.title_display  AS "title",
      a.name_display   AS "author",
      p.edition        AS "edition",
      p.text_display   AS "textDisplay",
      p.dataset        AS "dataset",
      p.source_file    AS "sourceFile",
      p.commit_sha     AS "commitSha",
      p.char_count     AS "charCount",
      count(*)::int    AS "matchedTerms",
      array_agg(df.n)  AS "dfs"
    FROM hits h
    JOIN df ON df.term = h.term
    JOIN poem p ON p.id = h.poem_id
    JOIN work w ON w.id = p.work_id
    LEFT JOIN author a ON a.id = w.author_id
    GROUP BY p.id, p.work_id, p.title_display, a.name_display, p.edition,
             p.text_display, p.dataset, p.source_file, p.commit_sha, p.char_count
    ORDER BY count(*) DESC
    LIMIT ${limit * 4}
  `);

  const rows = Array.isArray(res) ? res : res.rows;

  return rows
    .map((r) => {
      // tf is 1 per distinct query bigram present: within a 20-40 character poem a bigram
      // repeating is rare and, when it happens, is not evidence of greater relevance.
      const dfs: number[] = r.dfs ?? [];
      const score = dfs.reduce(
        (acc: number, dfn: number) => acc + bm25Term(1, r.charCount, avgDocLen, idf(dfn, totalDocs)),
        0,
      );
      return {
        poemId: r.poemId,
        workId: r.workId,
        title: r.title,
        author: r.author,
        edition: r.edition,
        textDisplay: r.textDisplay,
        dataset: r.dataset,
        sourceFile: r.sourceFile,
        commitSha: r.commitSha,
        score,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
