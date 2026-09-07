import { describe, expect, it } from 'vitest';
import { StepStatus } from '@han/shared/status';
import type { Evidence } from '@han/shared/evidence';
import { buildRow } from './row.js';
import { resolveColumns } from './export-schema.js';
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
});
