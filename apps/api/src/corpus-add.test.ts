import { describe, expect, it } from 'vitest';
import { proposeAddition, type Db } from './corpus-add.js';

const poem = {
  title: '次寄園令公郵筒韻 其一',
  author: '柳臺佐',
  text: '驛路委遲倦著鞭，風流丈席幸相聯。',
  source_url: 'https://sou-yun.cn/Query.aspx?id=1',
};

const emptyDb = {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
} as unknown as Db;

const forbiddenDb = {
  select: () => {
    throw new Error('the database must not be reached');
  },
  insert: () => {
    throw new Error('the database must not be reached');
  },
} as unknown as Db;

const ctx = {
  runId: 'run-1',
  verdict: 'sufficient',
  localFoundNothing: true,
  evidence: [{ source: 'souyun', url: poem.source_url }],
};

describe('proposeAddition', () => {
  it('refuses when the verifier did not call the evidence sufficient', async () => {
    const r = await proposeAddition(forbiddenDb, poem, { ...ctx, verdict: 'insufficient' });
    expect(r.proposed).toBe(false);
    expect(r.reason).toContain('sufficient');
  });

  it('refuses when the local corpus already answered', async () => {
    const r = await proposeAddition(forbiddenDb, poem, { ...ctx, localFoundNothing: false });
    expect(r.proposed).toBe(false);
    expect(r.reason).toContain('local corpus');
  });

  it('refuses a source URL the run never retrieved', async () => {
    const r = await proposeAddition(forbiddenDb, poem, {
      ...ctx,
      evidence: [{ source: 'souyun', url: 'https://sou-yun.cn/Query.aspx?id=999' }],
    });
    expect(r.proposed).toBe(false);
    expect(r.reason).toContain('not a URL this run retrieved');
  });

  it('refuses a proposal with no source URL at all', async () => {
    const { source_url: _drop, ...noUrl } = poem;
    const r = await proposeAddition(forbiddenDb, noUrl, ctx);
    expect(r.proposed).toBe(false);
  });

  it('refuses a proposal that fails the rules a person must pass', async () => {
    const r = await proposeAddition(forbiddenDb, { ...poem, author: '' }, ctx);
    expect(r.proposed).toBe(false);
    expect(r.reason).toContain('author');
  });

  it('proposes only when all four conditions hold', async () => {
    let inserted: unknown = null;
    const db = {
      ...emptyDb,
      insert: () => ({
        values: async (v: unknown) => {
          inserted = v;
        },
      }),
    } as unknown as Db;

    const r = await proposeAddition(db, poem, ctx);
    expect(r.proposed).toBe(true);
    expect(inserted).toMatchObject({ status: 'pending', origin: 'agent', runId: 'run-1' });
  });
});
