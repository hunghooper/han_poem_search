/**
 * Writing an accepted poem into the corpus.
 *
 * The important property is that an added poem goes through the SAME preparation as the
 * 78,455 that arrived with the corpus: the same normalisation, the same variant folding, the
 * same match form, the same line split, the same content hash. Anything less produces a poem
 * the exact matcher indexes differently from its neighbours — findable by some queries and not
 * by others, for reasons nobody could see.
 *
 * What is deliberately DIFFERENT is provenance. A corpus poem carries a dataset, a source file
 * and a commit sha. An added poem has no commit behind it, and that null is the signal rather
 * than an omission: `dataset` says how it arrived, and `commit_sha` is empty because nothing
 * in a repository vouches for it.
 */

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
  /** `added`, `duplicate`, or `error`. Three outcomes, kept apart on purpose. */
  result: 'added' | 'duplicate' | 'error';
  poemId?: string;
  additionId?: string;
  message?: string;
}

/**
 * Stable identity for an added poem.
 *
 * The corpus hashes (edition, file, text, title). An addition has no file, so it hashes what it
 * does have. Same shape, so a poem submitted twice collides with itself and is reported as a
 * duplicate rather than indexed twice — two copies of one poem turn a decisive query into
 * `exact_ambiguous`, which is a worse failure than refusing the second copy.
 */
function additionHash(a: CorpusAddition, textMatch: string): string {
  return createHash('sha256')
    .update(['user-added', a.author, textMatch, a.title].join('\n'))
    .digest('hex');
}

/**
 * Add one poem. Never throws: a bad row is a bad row, not a failed request for the other
 * nineteen in the file.
 */
export async function addPoem(
  db: Db,
  input: CorpusAddition,
  meta: {
    index: number;
    origin: AdditionOrigin;
    submittedBy: string | null;
    runId: string | null;
    /**
     * Whether to record the corpus_addition row here.
     *
     * False when the caller already has one — accepting a pending proposal turns THAT row into
     * the accepted record, and writing a second one would leave two rows claiming to be how a
     * single poem arrived. The history of an addition is one row, or it is not a history.
     */
    recordAddition?: boolean;
  },
): Promise<AddOutcome> {
  try {
    const full = normalize(input.text);
    const lines = visualLines(input.text)
      .map((l) => ({ display: l, match: toMatchForm(l) }))
      .filter((l) => l.match.length > 0);

    if (lines.length === 0) {
      return { index: meta.index, result: 'error', message: 'no indexable lines after normalisation' };
    }

    const hash = additionHash(input, full.textMatch);

    // Asked before writing. `onConflictDoNothing` would also prevent the duplicate, but it
    // would report "added: 0" without saying which row and why.
    const [existing] = await db
      .select({ id: poem.id })
      .from(poem)
      .where(eq(poem.contentHash, hash))
      .limit(1);
    if (existing) {
      return { index: meta.index, result: 'duplicate', poemId: existing.id, message: 'already in the corpus' };
    }

    const dataset = meta.origin === AdditionOrigin.AGENT ? 'agent-proposed' : 'user-added';

    // An author row, reused when the name is already known so an addition by 李白 joins the
    // existing 李白 rather than creating a second one.
    const authorId = await upsertAuthor(db, input.author, input.dynasty ?? null, dataset);

    // A work groups editions of one poem. An addition is its own work: claiming it is an
    // edition of an existing work would assert a relationship nobody established.
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
        // Empty on purpose. Nothing in a repository vouches for this poem, and a borrowed sha
        // would say something false about where it came from.
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
        // rhymeChar and tonePattern stay null. The derived prosody tables (ADR 007) are built
        // from the corpus as a whole; filling them here from a single poem would be guessing.
      })),
    );

    // Skipped when the caller already owns the row — see recordAddition.
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

/** Reuse an author by matched name so additions join the poet already in the corpus. */
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


/**
 * Record a proposal from the verifier. Writes a `pending` row and NOTHING else.
 *
 * No poem, no lines, no index entry — nothing a search can reach. The four conditions are
 * checked HERE, in code, rather than trusted from the model's own account of them: the model
 * is asked to propose only when all four hold, and a model that once counted its own refusal
 * as a finding is not the right place to enforce that.
 */
export async function proposeAddition(
  db: Db,
  proposal: { title: string; author: string; text: string; dynasty?: string | null; source_url?: string | null },
  ctx: { runId: string; verdict: string; localFoundNothing: boolean; evidence: readonly { source: string; url: string | null }[] },
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

  // The URL must be one the run actually saw. A model can write a plausible URL from memory,
  // and a proposal whose source cannot be checked is the thing this whole path is guarding
  // against — so the claimed source has to appear in the evidence.
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

  // Already proposed for this run, or already in the corpus? Neither is an error worth
  // surfacing to the searcher; both mean there is nothing new to add.
  const hash = additionHash(proposal as CorpusAddition, normalize(proposal.text).textMatch);
  const [existing] = await db.select({ id: poem.id }).from(poem).where(eq(poem.contentHash, hash)).limit(1);
  if (existing) {
    return { proposed: false, reason: 'already in the corpus', reasonTrace: msg('trace.propose.duplicate') };
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
