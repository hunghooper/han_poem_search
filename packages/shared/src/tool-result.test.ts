import { describe, expect, it } from 'vitest';
import { assertConsistent, ToolResultSchema } from './tool-result.js';
import { StepStatus } from './status.js';
import type { Evidence } from './evidence.js';

const evidence = (): Evidence => ({
  id: 'e1',
  source: 'exact',
  retrievalMethod: 'exact_ngram',
  workId: 'w1',
  title: '尋雍尊師隱居',
  author: '李白',
  dynasty: '唐',
  edition: '全唐詩',
  provenance: { dataset: 'chinese-poetry', file: 'quan_tang_shi/001.json', commitSha: 'abc123' },
  url: null,
  content: '群峭碧摩天，逍遙不記年。',
  matchedSpan: { start: 0, end: 5 },
  score: 1,
  rerankScore: null,
  metadata: {},
});

const base = {
  toolName: 'search_local_exact',
  source: 'exact',
  status: StepStatus.NO_RESULT,
  resultCount: 0,
  results: [],
  latencyMs: 3,
  error: null,
};

describe('ToolResult', () => {
  it('parses a well-formed empty result', () => {
    expect(() => ToolResultSchema.parse(base)).not.toThrow();
  });

  it('rejects NO_RESULT that actually carries rows — the classification bug the brief names', () => {
    expect(() =>
      assertConsistent({
        ...base,
        status: StepStatus.NO_RESULT,
        resultCount: 1,
        results: [evidence()],
      }),
    ).toThrow(/NO_RESULT with 1 results/);
  });

  it('rejects HAS_RESULT with nothing in it', () => {
    expect(() => assertConsistent({ ...base, status: StepStatus.HAS_RESULT })).toThrow(
      /HAS_RESULT with no results/,
    );
  });

  it('rejects a resultCount that disagrees with the payload', () => {
    expect(() =>
      assertConsistent({
        ...base,
        status: StepStatus.HAS_RESULT,
        resultCount: 9,
        results: [evidence()],
      }),
    ).toThrow(/resultCount 9/);
  });

  it('accepts LOW_CONFIDENCE carrying rows — candidates exist, none good enough', () => {
    expect(() =>
      assertConsistent({
        ...base,
        status: StepStatus.LOW_CONFIDENCE,
        resultCount: 1,
        results: [evidence()],
      }),
    ).not.toThrow();
  });

  it('accepts TIMEOUT with no rows and an error — distinct from NO_RESULT', () => {
    const r = assertConsistent({
      ...base,
      status: StepStatus.TIMEOUT,
      error: { code: 'TOOL_TIMEOUT', message: 'exceeded 8000ms' },
    });
    expect(r.status).not.toBe(StepStatus.NO_RESULT);
  });
});
