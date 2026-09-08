/**
 * What does a lexical-overlap floor do to the exact-match short-circuit?
 *
 * §7.1 lets a contiguous run of five characters resolving to one work short-circuit the whole
 * pipeline at confidence 1.0. On real calligraphy that fires on inputs where the five matched
 * characters are a ninth of what the user pasted: 234 of 1,888 exact matches in a 14,519-row
 * batch returned a poem sharing under 40% of the query's characters, at maximum confidence.
 *
 * The gate that catches exactly this already exists — `minLexicalOverlap`, added after the
 * reranker scored a nonsense control at 0.99 (ADR 008). It never applied here, for a reason
 * that is not a threshold at all: the short-circuit returns `lexicalOverlap: null`, so the
 * value the gate reads is never computed on this path.
 *
 * CONTRIBUTING requires a recorded calibration before a confidence rule changes. This is it:
 * every exact match in a real job, scored the way the gate would score it.
 *
 * Run: pnpm exec tsx scripts/exact-gate-calibration.ts [jobFilename]
 */

import './env.js';
import pg from 'pg';
import { lexicalOverlap } from '@han/retrieval/hybrid';

const JOB = process.argv[2] ?? 'task_b2_1.xlsx';

interface Row {
  query: string;
  content: string;
  title: string;
}

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  // The query the system actually received, and the poem it actually returned. Not the
  // exported columns — those are a rendering, and a calibration should read the source.
  const { rows } = await pool.query<Row>(
    `select r.query,
            p.text_display as content,
            coalesce(p.title_display, '(no title)') as title
       from batch_job j
       join batch_row b on b.job_id = j.id
       join search_run r on r.id = b.run_id
       join poem p on p.work_id = (b.result->>'work_id')::uuid
      where j.filename = $1
        and b.result->>'flags' like '%exact_full_match%'
        and b.result->>'work_id' is not null`,
    [JOB],
  );

  if (rows.length === 0) {
    console.log(`no exact matches recorded for ${JOB}`);
    await pool.end();
    return;
  }

  const scored = rows
    .map((r) => lexicalOverlap(r.query, r.content))
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);

  const q = (p: number): number => scored[Math.min(scored.length - 1, Math.floor(scored.length * p))]!;

  console.log(`\n${scored.length} exact_full_match rows from ${JOB}\n`);
  console.log('  overlap between the query and the poem returned:');
  for (const p of [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.95]) {
    console.log(`    p${String(Math.round(p * 100)).padStart(2)}  ${q(p).toFixed(3)}`);
  }

  console.log('\n  a floor would reject:');
  for (const floor of [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5]) {
    const n = scored.filter((v) => v < floor).length;
    console.log(
      `    ${floor.toFixed(2)}  ${String(n).padStart(4)} rows  ${((n / scored.length) * 100).toFixed(1)}%`,
    );
  }

  // The floor already in use on the reranker path, so the two paths can share one number
  // rather than acquiring a second threshold nobody calibrated.
  const existing = 0.15;
  const rejected = scored.filter((v) => v < existing).length;
  console.log(
    `\n  at the EXISTING minLexicalOverlap of ${existing}: ${rejected} rows (${((rejected / scored.length) * 100).toFixed(1)}%) stop being confident matches`,
  );

  await pool.end();
}

void main();
