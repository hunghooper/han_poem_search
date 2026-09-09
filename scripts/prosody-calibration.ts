import './env.js';
import pg from 'pg';
import { analyseForm } from '@han/retrieval/verify/form';
import { checkRhyme, checkTone } from '@han/retrieval/verify/prosody';
import { verifyCandidate } from '@han/retrieval/verify';

const SAMPLE = Number(process.argv[2] ?? 4000);

interface Tally {
  n: number;
  tonePass: number;
  toneFail: number;
  toneAbstain: number;
  rhymePass: number;
  rhymeFail: number;
  rhymeAbstain: number;
  verdictFail: number;
  legacyFail: number;
}

const blank = (): Tally => ({
  n: 0,
  tonePass: 0,
  toneFail: 0,
  toneAbstain: 0,
  rhymePass: 0,
  rhymeFail: 0,
  rhymeAbstain: 0,
  verdictFail: 0,
  legacyFail: 0,
});

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  const { rows } = await pool.query<{ poem_id: string; lines: string[] }>(
    `select p.id as poem_id, array_agg(l.text_match order by l.line_no) as lines
       from poem p
       join poem_line l on l.poem_id = p.id
      group by p.id
      limit $1`,
    [SAMPLE],
  );

  const byForm = new Map<string, Tally>();

  for (const row of rows) {
    const lines = row.lines.filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    const form = analyseForm(lines);

    const tally = byForm.get(form.form) ?? blank();
    tally.n += 1;

    const tone = checkTone(lines);
    if (tone.consistent === null) tally.toneAbstain += 1;
    else if (tone.consistent) tally.tonePass += 1;
    else tally.toneFail += 1;

    const rhyme = checkRhyme(lines);
    if (rhyme.consistent === null) tally.rhymeAbstain += 1;
    else if (rhyme.consistent) tally.rhymePass += 1;
    else tally.rhymeFail += 1;

    if (verifyCandidate(lines, lines).outcome === 'fail') tally.verdictFail += 1;

    const REG = ['wujue', 'qijue', 'wulu', 'qilu', 'wupai', 'qipai'];
    if (REG.includes(form.form) && (tone.consistent === false || rhyme.consistent === false)) {
      tally.legacyFail += 1;
    }

    byForm.set(form.form, tally);
  }

  const pct = (a: number, b: number): string =>
    b === 0 ? '   —' : `${((a / b) * 100).toFixed(0)}%`.padStart(4);

  console.log(`\nsampled ${rows.length} poems from the corpus\n`);
  console.log('form            n      tone: pass fail abst    rhyme: pass fail abst');
  console.log('─'.repeat(74));

  const sorted = [...byForm.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const [form, t] of sorted) {
    console.log(
      `${form.padEnd(12)} ${String(t.n).padStart(5)}      ` +
        `${pct(t.tonePass, t.n)} ${pct(t.toneFail, t.n)} ${pct(t.toneAbstain, t.n)}       ` +
        `${pct(t.rhymePass, t.n)} ${pct(t.rhymeFail, t.n)} ${pct(t.rhymeAbstain, t.n)}`,
    );
  }

  const REGULATED = ['wujue', 'qijue', 'wulu', 'qilu', 'wupai', 'qipai'];
  const regulated = sorted.filter(([f]) => REGULATED.includes(f));
  const rn = regulated.reduce((s, [, t]) => s + t.n, 0);
  const rf = regulated.reduce((s, [, t]) => s + t.toneFail, 0);
  const rr = regulated.reduce((s, [, t]) => s + t.rhymeFail, 0);

  console.log('\nAmong poems the SHAPE classifier calls regulated verse:');
  console.log(`  ${rn} poems, all of them correct answers by construction`);
  console.log(`  tone check fails on  ${rf} (${((rf / rn) * 100).toFixed(1)}%)`);
  console.log(`  rhyme check fails on ${rr} (${((rr / rn) * 100).toFixed(1)}%)`);

  const allN = sorted.reduce((s2, [, t]) => s2 + t.n, 0);
  const allFail = sorted.reduce((s2, [, t]) => s2 + t.verdictFail, 0);
  const allLegacy = sorted.reduce((s2, [, t]) => s2 + t.legacyFail, 0);
  console.log(String.fromCharCode(10) + 'VERDICT on a perfect match, all forms:');
  console.log(
    `  before: ${allLegacy}/${allN} rejected (${((allLegacy / allN) * 100).toFixed(1)}%)`,
  );
  console.log(`  after:  ${allFail}/${allN} rejected (${((allFail / allN) * 100).toFixed(1)}%)`);

  await pool.end();
}

void main();
