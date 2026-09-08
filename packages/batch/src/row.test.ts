import { describe, expect, it } from 'vitest';
import { StepStatus } from '@han/shared/status';
import type { Evidence } from '@han/shared/evidence';
import { buildRow } from './row.js';
import { DEFAULT_COLUMNS, resolveColumns } from './export-schema.js';
import type { ExportRowInput, OutcomeView } from './types.js';

const evidence = (over: Partial<Evidence> = {}): Evidence =>
  ({
    id: 'e1',
    source: 'exact',
    retrievalMethod: 'exact_ngram',
    workId: 'w-1',
    title: '靜夜思',
    author: '李白',
    dynasty: '唐',
    edition: '全唐詩',
    provenance: { dataset: 'chinese-poetry', file: 'tang/001.json', commitSha: 'b8594f81' },
    url: null,
    content: '床前明月光，疑是地上霜。舉頭望明月，低頭思故鄉。',
    matchedSpan: { start: 0, end: 5 },
    score: 0.91,
    rerankScore: 0.88,
    metadata: {},
    ...over,
  }) as Evidence;

const outcome = (over: Partial<OutcomeView> = {}): OutcomeView => ({
  runId: 'run-1',
  status: StepStatus.HAS_RESULT,
  confidence: 0.883333,
  flags: ['exact_full_match'],
  evidence: [evidence()],
  colophon: null,
  verification: null,
  llmVerdict: null,
  ...over,
});

const found = (over: Partial<ExportRowInput> = {}): ExportRowInput => ({
  status: StepStatus.HAS_RESULT,
  outcome: outcome(),
  top: evidence(),
  matchKind: 'full',
  ...over,
});

describe('buildRow', () => {
  it('fills the identity columns from the top candidate', () => {
    const row = buildRow(found(), ['title', 'author', 'dynasty', 'work_id']);
    expect(row).toEqual({ title: '靜夜思', author: '李白', dynasty: '唐', work_id: 'w-1' });
  });

  it('rounds confidence rather than writing a float tail into a spreadsheet', () => {
    expect(buildRow(found(), ['confidence']).confidence).toBe(0.883);
  });

  it('joins flags into one filterable cell', () => {
    expect(buildRow(found(), ['flags']).flags).toBe('exact_full_match');
  });

  // A row that was never searched still owes the user a status. This is the case that makes
  // the batch export honest: the cap was hit, the run was stopped, the worker died — the cell
  // says so instead of being blank beside an empty author column, which reads as "not found".
  it('carries a status for a row with no outcome at all', () => {
    const row = buildRow(
      { status: StepStatus.NOT_EXECUTED, outcome: null, top: null },
      resolveColumns(['title', 'author']),
    );
    expect(row.status).toBe(StepStatus.NOT_EXECUTED);
    expect(row.title).toBeNull();
    expect(row.author).toBeNull();
  });

  it('distinguishes a row that found nothing from a row that errored', () => {
    const missed = buildRow({ status: StepStatus.NO_RESULT, outcome: null, top: null }, ['status']);
    const broke = buildRow({ status: StepStatus.ERROR, outcome: null, top: null }, ['status']);
    expect(missed.status).not.toBe(broke.status);
  });

  it('narrows matched_text to the matched span, not the whole poem', () => {
    expect(buildRow(found(), ['matched_text']).matched_text).toBe('床前明月光');
  });

  it('falls back to the whole poem when there is no span', () => {
    const input = found({ top: evidence({ matchedSpan: null }) });
    expect(buildRow(input, ['matched_text']).matched_text).toMatch(/^床前明月光，/u);
  });

  // Three-valued, and the abstention survives into the spreadsheet. A rhyme check that could
  // not run is not a rhyme check that passed, and "abstain" in the cell is what stops a reader
  // treating an unverified match as a verified one.
  it('keeps verification three-valued', () => {
    const input = found({
      outcome: outcome({
        verification: {
          outcome: 'abstain',
          checks: [
            { name: 'form', outcome: 'pass' },
            { name: 'rhyme', outcome: 'abstain' },
            { name: 'tone', outcome: 'fail' },
          ],
          candidateForm: { form: '五言絕句' },
        },
      }),
    });
    const row = buildRow(input, ['form', 'verify_form', 'verify_rhyme', 'verify_tone']);
    expect(row).toEqual({
      form: '五言絕句',
      verify_form: 'pass',
      verify_rhyme: 'abstain',
      verify_tone: 'fail',
    });
  });

  it('leaves a verification column null when no check ran, rather than writing pass', () => {
    expect(buildRow(found(), ['verify_rhyme']).verify_rhyme).toBeNull();
  });

  // Ambiguity is carried sideways, never resolved by picking one. Collapsing three equal
  // candidates to one title would be exactly the false confidence han_status exists to stop.
  it('lists runner-up candidates instead of discarding them', () => {
    const input = found({
      outcome: outcome({
        evidence: [
          evidence(),
          evidence({ id: 'e2', title: '秋夕', author: '杜牧', rerankScore: 0.86 }),
          evidence({ id: 'e3', title: '長恨歌', author: '白居易', rerankScore: 0.8 }),
        ],
      }),
    });
    expect(buildRow(input, ['alternatives']).alternatives).toBe('秋夕 — 杜牧 (0.86); 長恨歌 — 白居易 (0.8)');
  });

  it('writes null, not an empty string, when there are no alternatives', () => {
    expect(buildRow(found(), ['alternatives']).alternatives).toBeNull();
  });

  it('reports the colophon it set aside', () => {
    const input = found({
      outcome: outcome({ colophon: { lines: ['甲子年秋月'], cyclicalDate: '甲子' } }),
    });
    const row = buildRow(input, ['colophon', 'colophon_date']);
    expect(row).toEqual({ colophon: '甲子年秋月', colophon_date: '甲子' });
  });

  it('carries provenance so a result stays reproducible after the corpus moves on', () => {
    const row = buildRow(found(), ['dataset', 'commit_sha', 'run_id']);
    expect(row).toEqual({ dataset: 'chinese-poetry', commit_sha: 'b8594f81', run_id: 'run-1' });
  });

  it('reports reordering as a boolean the user can filter on', () => {
    const input = found({ outcome: outcome({ flags: ['input_reordered'] }) });
    expect(buildRow(input, ['reordered']).reordered).toBe(true);
    expect(buildRow(found(), ['reordered']).reordered).toBe(false);
  });

  it('emits exactly the requested columns, in the requested order', () => {
    expect(Object.keys(buildRow(found(), ['status', 'title']))).toEqual(['status', 'title']);
  });
  // FOUND LIVE. A nonsense input came back no_result — correctly — while the identity columns
  // carried 駑驥 / 韩愈, picked up from a vector near-miss the confidence policy had already
  // rejected. In a spreadsheet those two cells ARE the answer; the status that contradicts
  // them is the cell nobody filters on. The trace still holds the rejected candidate, and
  // run_id still points at it.
  it('writes no identity for a row the confidence policy rejected', () => {
    const input = found({ status: StepStatus.NO_RESULT, matchKind: 'none' });
    const row = buildRow(input, ['status', 'title', 'author', 'matched_text', 'alternatives']);
    expect(row.status).toBe(StepStatus.NO_RESULT);
    expect(row.title).toBeNull();
    expect(row.author).toBeNull();
    expect(row.matched_text).toBeNull();
    expect(row.alternatives).toBeNull();
  });

  it('still points at the trace for a rejected row, so the evidence is not lost', () => {
    const input = found({ status: StepStatus.NO_RESULT });
    expect(buildRow(input, ['run_id']).run_id).toBe('run-1');
  });

  // The other half of the rule. A low-confidence candidate is exactly what the user wants to
  // see — flagged, not withheld.
  it('does write identity for a low-confidence candidate', () => {
    const input = found({ status: StepStatus.LOW_CONFIDENCE });
    expect(buildRow(input, ['title']).title).toBe('靜夜思');
  });

  it('writes no identity for a skipped or errored row', () => {
    for (const status of [StepStatus.SKIPPED, StepStatus.ERROR, StepStatus.NOT_EXECUTED]) {
      expect(buildRow(found({ status }), ['author']).author).toBeNull();
    }
  });
  it('derives match_kind from the flags the run recorded', () => {
    // matchKind cleared so the derivation runs — the caller may or may not supply one.
    const derive = (flags: string[]): unknown =>
      buildRow(found({ matchKind: undefined, outcome: outcome({ flags }) }), ['match_kind'])
        .match_kind;
    expect(derive(['exact_full_match'])).toBe('full');
    expect(derive(['exact_partial_match'])).toBe('partial');
    // Several poems matched equally well and the run said so. A spreadsheet showing only the
    // first title would present a coin toss as a finding.
    expect(derive(['exact_ambiguous'])).toBe('ambiguous');
  });

  it('reports match_kind none for a row with no answer', () => {
    const input = found({ matchKind: undefined, status: StepStatus.NO_RESULT });
    expect(buildRow(input, ['match_kind']).match_kind).toBe('none');
  });
  it('reports no verification for a row it does not name a candidate for', () => {
    const input = found({
      status: StepStatus.NO_RESULT,
      outcome: outcome({
        verification: {
          outcome: 'fail',
          checks: [{ name: 'form', outcome: 'fail' }],
          candidateForm: { form: '五言絕句' },
        },
      }),
    });
    const row = buildRow(input, ['form', 'verify_form']);
    expect(row.form).toBeNull();
    expect(row.verify_form).toBeNull();
  });
});
/**
 * §10.2's judgement is the one column that tells a finding from a refusal. The researcher can
 * answer "I do not recognise this" and every other cell on the row still looks like a result,
 * so this column is NOT gated on the row having an answer — a verdict of `insufficient` is
 * exactly what an empty row needs to carry.
 */
describe('the verifier verdict', () => {
  it('is carried even on a row with no answer', () => {
    const input = found({
      status: StepStatus.NO_RESULT,
      outcome: outcome({
        llmVerdict: { verdict: 'insufficient', confidence: 0.2, notes: 'the model refused' },
      }),
    });
    const row = buildRow(input, ['status', 'title', 'llm_verdict', 'llm_notes']);
    expect(row.title).toBeNull();
    expect(row.llm_verdict).toBe('insufficient');
    expect(row.llm_notes).toBe('the model refused');
  });

  // Null means the check did not happen, which is not the same as it having passed.
  it('is null when the verifier did not run, never "sufficient"', () => {
    expect(buildRow(found(), ['llm_verdict']).llm_verdict).toBeNull();
  });
});

/**
 * The only optional column that defaults ON. Everything else in the export is information;
 * this is a warning. An added poem has no dataset, file or commit behind it and is returned
 * exactly as confidently as the 78,455 that do — a reader scanning titles cannot tell them
 * apart unless the cell says so.
 */
describe('han_added', () => {
  const withDataset = (dataset: string) =>
    found({ top: evidence({ provenance: { dataset, file: 'f', commitSha: 'abc' } }) });

  it('says which way a poem entered the corpus', () => {
    expect(buildRow(withDataset('user-added'), ['added']).added).toBe('user');
    expect(buildRow(withDataset('agent-proposed'), ['added']).added).toBe('agent');
  });

  // Not null, and not blank: a blank cell in a provenance column reads as "unknown", and the
  // point of the column is that the answer is known.
  it('says "no" for a poem that came with the corpus', () => {
    expect(buildRow(withDataset('chinese-poetry'), ['added']).added).toBe('no');
  });

  it('is on by default while every other optional column is off', () => {
    expect(DEFAULT_COLUMNS).toContain('added');
    expect(DEFAULT_COLUMNS).not.toContain('added_source');
  });
});

/**
 * Found by exporting a real job: 9,223 rows the run never reached carried `added: "no"` —
 * a claim about provenance on a row with no result at all.
 */
describe('han_added on a row with no answer', () => {
  it('is empty, not "no"', () => {
    for (const status of [StepStatus.NOT_EXECUTED, StepStatus.NO_RESULT, StepStatus.SKIPPED]) {
      expect(buildRow({ status, outcome: null, top: null }, ['added']).added).toBeNull();
    }
  });
});
