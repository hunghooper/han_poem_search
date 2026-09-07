/** the spec §16 Phase 1 acceptance criteria, run against the real index. */
import './env.js';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { exactNgramSearch } from '@han/retrieval/sources/exact-ngram';
import { evaluateLocal } from '@han/retrieval/confidence';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? '' });
const db = drizzle(pool);

const REORDERED =
  '自下寒煙 卧松高 白鶴眠 語来江色暮 獨 尋古道 倚石聽流泉 花暖青牛 羣峭碧摩天 逍遥不記年 撥雲';
const NONSENSE = '龘龘龘龘龘龘龘龘';
const CLEAN = '撥雲尋古道';

let fail = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
  if (!ok) fail += 1;
};

const a = await exactNgramSearch(db, REORDERED);
const av = evaluateLocal({
  intent: 'fragment_lookup',
  exactMatch: { kind: a.kind, workIds: a.workIds, windowsMatched: a.windowsMatched },
  candidateCount: a.hits.length,
  rerankScores: [],
});
const top = a.hits[0];
check(
  'reordered 李白 fragment resolves',
  top?.title === '尋雍尊師隱居' && av.flags.includes('local_result_found'),
  `${top?.title ?? 'none'} — ${top?.author ?? '?'} | kind=${a.kind} flags=[${[...a.flags, ...av.flags].join(' ')}] | ${a.latencyMs}ms`,
);
check('  ...and is flagged as reordered', a.flags.includes('input_reordered'), `strategy=${a.reading?.strategy}`);
check('  ...in under 200ms without an LLM call', a.latencyMs < 200, `${a.latencyMs}ms`);

const b = await exactNgramSearch(db, NONSENSE);
const bv = evaluateLocal({
  intent: 'fragment_lookup',
  exactMatch: { kind: b.kind, workIds: b.workIds, windowsMatched: b.windowsMatched },
  candidateCount: b.hits.length,
  rerankScores: [],
});
check(
  'nonsense produces no_local_result, not an assembled answer',
  bv.flags.includes('no_local_result') && b.hits.length === 0,
  `kind=${b.kind} hits=${b.hits.length} flags=[${bv.flags.join(' ')}]`,
);

const c = await exactNgramSearch(db, CLEAN);
check(
  'clean fragment short-circuits',
  c.kind === 'full' && !c.flags.includes('input_reordered'),
  `${c.hits[0]?.title ?? 'none'} — ${c.hits[0]?.author ?? '?'} | ${c.latencyMs}ms`,
);

await pool.end();
console.log(fail === 0 ? '\nall acceptance criteria pass' : `\n${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
