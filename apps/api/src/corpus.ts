/**
 * Corpus routes — submitting poems, and reviewing what the verifier proposed.
 *
 * The browser already checked the file before sending it. This checks again, with the SAME
 * function from `@han/shared/corpus-addition`, because a browser check is a convenience and
 * not a guard: anything can post here.
 */

import type { FastifyInstance } from 'fastify';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { corpusAddition, poem } from '@han/db/schema';
import {
  AdditionOrigin,
  AdditionStatus,
  CorpusAdditionSchema,
  checkRow,
} from '@han/shared/corpus-addition';
import { addPoem, type Db } from './corpus-add.js';

/**
 * Small on purpose. This path runs synchronously inside one request and each poem costs
 * several statements; a thousand-row file belongs in a job, and pretending otherwise would
 * produce a request that times out halfway with no record of where it stopped.
 */
const MAX_PER_REQUEST = 200;

const SubmitSchema = z.object({
  poems: z.array(z.unknown()).min(1).max(MAX_PER_REQUEST),
  /**
   * Required, and still not verified — there is no auth beyond a stub user (§17), so this is a
   * claim rather than a control. It is required anyway: an added poem sits in the same index as
   * 78,455 that carry a dataset, a file and a commit, and the least it can carry is the name of
   * whoever put it there. A blank field would leave no one to ask.
   */
  submittedBy: z.string().trim().min(1).max(200),
});

export function registerCorpusRoutes(app: FastifyInstance, db: Db): void {
  /** The rules, so the UI never ships its own copy of the numbers. */
  app.get('/api/corpus/rules', () => ({
    maxPerRequest: MAX_PER_REQUEST,
    required: ['title', 'author', 'text'],
    optional: ['dynasty', 'form', 'note', 'source_url'],
  }));

  app.post('/api/corpus/additions', async (request, reply) => {
    const parsed = SubmitSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request', issues: parsed.error.issues });
    }

    const { submittedBy } = parsed.data;
    const results = [];

    for (const [i, raw] of parsed.data.poems.entries()) {
      // Two checks, and they answer different questions. `checkRow` says what a person must
      // fix and names every problem at once; the schema says whether the value is storable.
      // Reporting only the schema's first error would send someone back and forth one field
      // at a time.
      const row = (raw ?? {}) as Record<string, unknown>;
      const check = checkRow(row, i);
      if (!check.ok) {
        results.push({ index: i, result: 'refused' as const, missing: check.missing });
        continue;
      }

      const shaped = CorpusAdditionSchema.safeParse(row);
      if (!shaped.success) {
        results.push({
          index: i,
          result: 'refused' as const,
          missing: shaped.error.issues.map((s) => s.path.join('.') || 'body'),
        });
        continue;
      }

      results.push(
        await addPoem(db, shaped.data, {
          index: i,
          origin: AdditionOrigin.USER,
          submittedBy,
          runId: null,
        }),
      );
    }

    const tally = results.reduce<Record<string, number>>((acc, r) => {
      acc[r.result] = (acc[r.result] ?? 0) + 1;
      return acc;
    }, {});

    return { tally, results };
  });

  /**
   * Everything that has ever been proposed or added, filterable.
   *
   * This replaced a `/pending` endpoint that returned only the unreviewed ones. Pending is the
   * urgent state but it is not the interesting one: the reason additions are marked at all is
   * so somebody can go back later and ask what got in and on whose word. An endpoint that can
   * only answer "what needs me right now" cannot answer that.
   *
   * The counts come back with the page, because a reviewer needs to know there are forty
   * rejected ones without paging through them.
   */
  app.get('/api/corpus/additions', async (request, reply) => {
    const q = z
      .object({
        status: z.enum(['pending', 'accepted', 'rejected', 'all']).default('all'),
        origin: z.enum(['user', 'agent', 'all']).default('all'),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid query', issues: q.error.issues });

    const { status, origin, limit, offset } = q.data;
    const where = [
      ...(status === 'all' ? [] : [eq(corpusAddition.status, status)]),
      ...(origin === 'all' ? [] : [eq(corpusAddition.origin, origin)]),
    ];

    const rows = await db
      .select()
      .from(corpusAddition)
      .where(where.length > 0 ? and(...where) : undefined)
      .orderBy(desc(corpusAddition.createdAt))
      .limit(limit)
      .offset(offset);

    // Counted over everything, not over the page: the tallies describe the store, and a tally
    // that changed as you paged would be describing the scroll position instead.
    const tallies = await db
      .select({
        status: corpusAddition.status,
        origin: corpusAddition.origin,
        n: sql<number>`count(*)::int`,
      })
      .from(corpusAddition)
      .groupBy(corpusAddition.status, corpusAddition.origin);

    return { additions: rows, tallies, limit, offset };
  });

  app.post('/api/corpus/pending/:id/review', async (request, reply) => {
    // Checked here rather than left to the database. The id column is a uuid, so a malformed
    // one surfaces as a driver error and a 500 — which tells a caller the server broke when in
    // fact they asked for something that cannot exist.
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'id must be a uuid' });
    const { id } = params.data;
    const body = z
      .object({
        accept: z.boolean(),
        // Same reasoning as submittedBy: accepting a proposal is the moment it becomes a poem
        // every later search can return, and that decision should have a name on it.
        reviewedBy: z.string().trim().min(1).max(200),
        note: z.string().max(2000).optional(),
      })
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });

    const [row] = await db
      .select()
      .from(corpusAddition)
      .where(
        and(eq(corpusAddition.id, id), eq(corpusAddition.status, AdditionStatus.PENDING)),
      )
      .limit(1);
    if (!row) return reply.code(404).send({ error: 'no such pending proposal' });

    if (!body.data.accept) {
      await db
        .update(corpusAddition)
        .set({
          status: AdditionStatus.REJECTED,
          reviewedAt: new Date(),
          reviewedBy: body.data.reviewedBy,
          reviewNote: body.data.note ?? null,
        })
        .where(eq(corpusAddition.id, id));
      return { reviewed: 'rejected' };
    }

    // Only here, on a person's word, does a proposal become a poem. Everything up to this
    // point was a suggestion — see docs/plans/corpus-enrichment.md.
    const shaped = CorpusAdditionSchema.safeParse(row.payload);
    if (!shaped.success) {
      return reply.code(422).send({ error: 'the stored proposal no longer validates', issues: shaped.error.issues });
    }

    const outcome = await addPoem(db, shaped.data, {
      index: 0,
      origin: AdditionOrigin.AGENT,
      submittedBy: row.submittedBy,
      runId: row.runId,
      // This proposal's own row becomes the accepted record, just below. A second row would
      // say the poem arrived twice.
      recordAddition: false,
    });

    if (outcome.result === 'error') {
      return reply.code(500).send({ error: outcome.message });
    }

    await db
      .update(corpusAddition)
      .set({
        status: AdditionStatus.ACCEPTED,
        poemId: outcome.poemId ?? null,
        reviewedAt: new Date(),
        reviewedBy: body.data.reviewedBy,
        reviewNote: body.data.note ?? null,
      })
      .where(eq(corpusAddition.id, id));

    return { reviewed: 'accepted', ...outcome };
  });

  /**
   * How big the corpus is, and how much of it arrived by addition.
   *
   * The total is COUNTED, not configured. The headline used to carry a hardcoded 78,455 — true
   * on the day it was typed, and wrong the moment somebody added a poem, which is now a thing
   * the interface invites them to do. A number that cannot move is a claim, not a count.
   */
  app.get('/api/corpus/stats', async () => {
    const rows = await db
      .select({ dataset: poem.dataset })
      .from(poem)
      .where(eq(poem.dataset, 'user-added'));
    const agent = await db
      .select({ dataset: poem.dataset })
      .from(poem)
      .where(eq(poem.dataset, 'agent-proposed'));
    const [totalRow] = await db.select({ n: sql<number>`count(*)::int` }).from(poem);
    return { total: totalRow?.n ?? null, userAdded: rows.length, agentAdded: agent.length };
  });
}
