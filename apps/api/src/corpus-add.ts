import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { author, corpusAddition, poem, poemLine, work } from '@han/db/schema';
import { normalize, toMatchForm, visualLines } from '@han/retrieval/normalize';
import { msg, type TraceMsg } from '@han/shared/trace';
import {
  AdditionOrigin,
  AdditionStatus,
  checkRow,
  type CorpusAddition,
} from '@han/shared/corpus-addition';
import { createHash } from 'node:crypto';

export type Db = NodePgDatabase<Record<string, never>>;

export interface AddOutcome {
  index: number;
  result: 'added' | 'duplicate' | 'error';
  poemId?: string;
  additionId?: string;
  message?: string;
}

function additionHash(a: CorpusAddition, textMatch: string): string {
  return createHash('sha256')
    .update(['user-added', a.author, textMatch, a.title].join('\n'))
    .digest('hex');
}

export async function addPoem(
  db: Db,
  input: CorpusAddition,
  meta: {
    index: number;
    origin: AdditionOrigin;
    submittedBy: string | null;
    runId: string | null;
    recordAddition?: boolean;
  },
): Promise<AddOutcome> {
  try {
    const full = normalize(input.text);
    const lines = visualLines(input.text)
      .map((l) => ({ display: l, match: toMatchForm(l) }))
      .filter((l) => l.match.length > 0);

    if (lines.length === 0) {
      return {
        index: meta.index,
        result: 'error',
        message: 'no indexable lines after normalisation',
      };
    }

    const hash = additionHash(input, full.textMatch);

    const [existing] = await db
      .select({ id: poem.id })
      .from(poem)
      .where(eq(poem.contentHash, hash))
      .limit(1);
    if (existing) {
      return {
        index: meta.index,
        result: 'duplicate',
        poemId: existing.id,
        message: 'already in the corpus',
      };
    }

    const dataset = meta.origin === AdditionOrigin.AGENT ? 'agent-proposed' : 'user-added';

    const authorId = await upsertAuthor(db, input.author, input.dynasty ?? null, dataset);

    const [workRow] = await db
      .insert(work)
      .values({
        workKey: `added:${hash.slice(0, 32)}`,
        title: input.title,
        ...(authorId ? { authorId } : {}),
        ...(input.dynasty ? { dynasty: input.dynasty } : {}),
      })
      .onConflictDoNothing()
      .returning({ id: work.id });

    const workId =
      workRow?.id ??
      (
        await db
          .select({ id: work.id })
          .from(work)
          .where(eq(work.workKey, `added:${hash.slice(0, 32)}`))
          .limit(1)
      )[0]?.id;

    if (!workId) {
      return { index: meta.index, result: 'error', message: 'could not resolve a work id' };
    }

    const [poemRow] = await db
      .insert(poem)
      .values({
        workId,
        edition: dataset,
        titleDisplay: input.title,
        titleMatch: toMatchForm(input.title),
        rhythmic: input.form ?? null,
        textDisplay: input.text,
        textTrad: full.textTrad,
        textSimp: full.textSimp,
        textMatch: full.textMatch,
        charCount: full.textMatch.length,
        lineCount: lines.length,
        dataset,
        sourceFile: meta.runId ?? 'upload',
        commitSha: '',
        contentHash: hash,
      })
      .returning({ id: poem.id });

    if (!poemRow) {
      return { index: meta.index, result: 'error', message: 'insert returned no row' };
    }

    await db.insert(poemLine).values(
      lines.map((l, n) => ({
        poemId: poemRow.id,
        workId,
        lineNo: n,
        textDisplay: l.display,
        textMatch: l.match,
        charCount: l.match.length,
      })),
    );

    let additionId: string | undefined;
    if (meta.recordAddition ?? true) {
      const [addition] = await db
        .insert(corpusAddition)
        .values({
          poemId: poemRow.id,
          origin: meta.origin,
          status: AdditionStatus.ACCEPTED,
          payload: input as unknown as Record<string, unknown>,
          runId: meta.runId,
          submittedBy: meta.submittedBy,
          sourceUrl: input.source_url ?? null,
          note: input.note ?? null,
        })
        .returning({ id: corpusAddition.id });
      additionId = addition?.id;
    }

    return {
      index: meta.index,
      result: 'added',
      poemId: poemRow.id,
      ...(additionId ? { additionId } : {}),
    };
  } catch (e) {
    return {
      index: meta.index,
      result: 'error',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

async function upsertAuthor(
  db: Db,
  name: string,
  dynasty: string | null,
  dataset: string,
): Promise<string | null> {
  const nameMatch = toMatchForm(name);
  const [found] = await db
    .select({ id: author.id })
    .from(author)
    .where(and(eq(author.nameMatch, nameMatch), sql`true`))
    .limit(1);
  if (found) return found.id;

  const [created] = await db
    .insert(author)
    .values({
      nameDisplay: name,
      nameMatch,
      dynasty,
      bio: null,
      dataset,
      sourceFile: 'upload',
      commitSha: '',
    })
    .onConflictDoNothing()
    .returning({ id: author.id });
  return created?.id ?? null;
}

export async function proposeAddition(
  db: Db,
  proposal: {
    title: string;
    author: string;
    text: string;
    dynasty?: string | null;
    source_url?: string | null;
  },
  ctx: {
    runId: string;
    verdict: string;
    localFoundNothing: boolean;
    evidence: readonly { source: string; url: string | null }[];
  },
): Promise<{ proposed: boolean; reason?: string; reasonTrace?: TraceMsg }> {
  if (ctx.verdict !== 'sufficient') {
    return {
      proposed: false,
      reason: 'the verifier did not call the evidence sufficient',
      reasonTrace: msg('trace.propose.notSufficient'),
    };
  }
  if (!ctx.localFoundNothing) {
    return {
      proposed: false,
      reason: 'the local corpus already answered',
      reasonTrace: msg('trace.propose.localAnswered'),
    };
  }

  const outsideUrls = ctx.evidence.filter((e) => e.url).map((e) => e.url);
  const url = proposal.source_url ?? null;
  if (!url || !outsideUrls.includes(url)) {
    return {
      proposed: false,
      reason: 'the proposed source is not a URL this run retrieved',
      reasonTrace: msg('trace.propose.urlNotRetrieved'),
    };
  }

  const check = checkRow(proposal as unknown as Record<string, unknown>, 0);
  if (!check.ok) {
    return {
      proposed: false,
      reason: `the proposal fails the same rules a person must pass: ${check.missing.join(', ')}`,
      reasonTrace: msg('trace.propose.failsRules', { fields: check.missing.join(', ') }),
    };
  }

  const hash = additionHash(proposal as CorpusAddition, normalize(proposal.text).textMatch);
  const [existing] = await db
    .select({ id: poem.id })
    .from(poem)
    .where(eq(poem.contentHash, hash))
    .limit(1);
  if (existing) {
    return {
      proposed: false,
      reason: 'already in the corpus',
      reasonTrace: msg('trace.propose.duplicate'),
    };
  }

  await db.insert(corpusAddition).values({
    origin: AdditionOrigin.AGENT,
    status: AdditionStatus.PENDING,
    payload: proposal as unknown as Record<string, unknown>,
    runId: ctx.runId,
    submittedBy: null,
    sourceUrl: url,
    note: null,
  });

  return { proposed: true };
}
