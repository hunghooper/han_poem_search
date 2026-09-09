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

const MAX_PER_REQUEST = 200;

const SubmitSchema = z.object({
  poems: z.array(z.unknown()).min(1).max(MAX_PER_REQUEST),
  submittedBy: z.string().trim().min(1).max(200),
});

export function registerCorpusRoutes(app: FastifyInstance, db: Db): void {
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
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'id must be a uuid' });
    const { id } = params.data;
    const body = z
      .object({
        accept: z.boolean(),
        reviewedBy: z.string().trim().min(1).max(200),
        note: z.string().max(2000).optional(),
      })
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });

    const [row] = await db
      .select()
      .from(corpusAddition)
      .where(and(eq(corpusAddition.id, id), eq(corpusAddition.status, AdditionStatus.PENDING)))
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

    const shaped = CorpusAdditionSchema.safeParse(row.payload);
    if (!shaped.success) {
      return reply
        .code(422)
        .send({ error: 'the stored proposal no longer validates', issues: shaped.error.issues });
    }

    const outcome = await addPoem(db, shaped.data, {
      index: 0,
      origin: AdditionOrigin.AGENT,
      submittedBy: row.submittedBy,
      runId: row.runId,
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
