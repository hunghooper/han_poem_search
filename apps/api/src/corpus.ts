/**
 * Corpus routes — submitting poems, and reviewing what the verifier proposed.
 *
 * The browser already checked the file before sending it. This checks again, with the SAME
 * function from `@han/shared/corpus-addition`, because a browser check is a convenience and
 * not a guard: anything can post here.
 */

import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
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
  /** Recorded, not verified — there is no auth beyond a stub user (§17). */
  submittedBy: z.string().max(200).optional(),
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

    const submittedBy = parsed.data.submittedBy ?? null;
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
   * What the verifier has proposed and nobody has looked at yet.
   *
   * A proposal is not in the corpus. It has no poem row and no index entry; it is a suggestion
   * with the run that produced it attached, so a reviewer reads the evidence rather than the
   * conclusion.
   */
  app.get('/api/corpus/pending', async () => {
    const rows = await db
      .select()
      .from(corpusAddition)
      .where(eq(corpusAddition.status, AdditionStatus.PENDING))
      .orderBy(desc(corpusAddition.createdAt))
      .limit(100);
    return { pending: rows };
  });

  app.post('/api/corpus/pending/:id/review', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z
      .object({
        accept: z.boolean(),
        reviewedBy: z.string().max(200).optional(),
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
          reviewedBy: body.data.reviewedBy ?? null,
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
        reviewedBy: body.data.reviewedBy ?? null,
        reviewNote: body.data.note ?? null,
      })
      .where(eq(corpusAddition.id, id));

    return { reviewed: 'accepted', ...outcome };
  });

  /** How many poems in the corpus arrived by addition, for the panel to show honestly. */
  app.get('/api/corpus/stats', async () => {
    const rows = await db
      .select({ dataset: poem.dataset })
      .from(poem)
      .where(eq(poem.dataset, 'user-added'));
    const agent = await db
      .select({ dataset: poem.dataset })
      .from(poem)
      .where(eq(poem.dataset, 'agent-proposed'));
    return { userAdded: rows.length, agentAdded: agent.length };
  });
}
