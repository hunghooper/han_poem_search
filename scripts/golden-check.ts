/**
 * Runs the golden set against the real index and prints what actually happens.
 *
 * This is the Phase 1 acceptance check (the spec §16): the reordered fragment must
 * resolve with exact_partial_match + input_reordered, and a nonsense fragment must produce
 * no_local_result rather than an answer assembled from irrelevant top-k.
 */

import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { exactNgramSearch } from '@han/retrieval/sources/exact-ngram';
import { evaluateLocal } from '@han/retrieval/confidence';

interface Case {
  id: string;
  query: string;
  damageClass: string;
  expect: { outcome: string; flags?: string[]; title?: string; author?: string; confirmed: boolean };
  note: string;
}

const url = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/poetry_search';
const pool = new pg.Pool({ connectionString: url, max: 4 });
const db = drizzle(pool);

const raw = await readFile('fixtures/golden/user-queries.json', 'utf8');
const cases = (JSON.parse(raw) as { cases: Case[] }).cases;

// A deliberately meaningless fragment — the §16 negative control.
const NONSENSE = '龘龘龘龘龘龘';

let passed = 0;
let failed = 0;

const report = async (id: string, query: string, expected: string, damage: string) => {
  const started = Date.now();
  const exact = await exactNgramSearch(db, query);
  const verdict = evaluateLocal({
    intent: 'fragment_lookup',
    exactMatch: { kind: exact.kind, workIds: exact.workIds, windowsMatched: exact.windowsMatched },
    candidateCount: exact.hits.length,
    rerankScores: [],
  });
  const elapsed = Date.now() - started;

  const top = exact.hits[0];
  const gotResult = verdict.flags.includes('local_result_found');
  const expectResult = expected === 'local_result_found';
  const ok = expected === 'unknown' ? true : gotResult === expectResult;
  if (expected !== 'unknown') {
    if (ok) passed += 1;
    else failed += 1;
  }

  const mark = expected === 'unknown' ? '?' : ok ? 'PASS' : 'FAIL';
  console.log(
    `${mark.padEnd(4)} ${id.padEnd(7)} ${damage.padEnd(22)} ${elapsed.toString().padStart(5)}ms  ` +
      `kind=${exact.kind.padEnd(9)} works=${exact.workIds.length} run=${exact.longestRun} ` +
      `flags=[${[...new Set([...exact.flags, ...verdict.flags])].join(' ')}]`,
  );
  if (top) {
    console.log(`       -> ${top.title ?? '(untitled)'} — ${top.author ?? '(unknown)'} [${top.edition}]`);
    console.log(`          ${top.textDisplay}`);
    if (exact.reading && exact.reading.reordered) {
      console.log(`          via ${exact.reading.strategy}${exact.reading.cols ? ` cols=${exact.reading.cols}` : ''}`);
    }
  }
};

console.log('id      damage class            latency  outcome');
console.log('-'.repeat(100));
for (const c of cases) {
  await report(c.id, c.query, c.expect.outcome, c.damageClass);
}
await report('control', NONSENSE, 'no_local_result', 'nonsense_control');

console.log('-'.repeat(100));
console.log(`passed ${passed}, failed ${failed}`);
await pool.end();
process.exit(failed > 0 ? 1 : 0);
