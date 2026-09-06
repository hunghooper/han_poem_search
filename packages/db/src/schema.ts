/**
 * Drizzle schema — the spec §11.
 *
 * Two families of table:
 *   corpus  — work, poem, poem_line, author. What the dataset says, with provenance.
 *   run log — search_run, search_event, search_result. Append-only; the event log is
 *             authoritative and search_run.final_* is a materialized convenience.
 */

import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

/**
 * A work is the abstract poem, shared across editions (§3.1 item 5).
 *
 * 全唐詩 and 御定全唐詩 hold the same poem with different readings. Both are kept as separate
 * `poem` rows pointing at one `work`. Deduplicating by dropping one destroys the most
 * interesting signal in this corpus.
 */
export const work = pgTable(
  'work',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Content-derived, stable across editions. See packages/corpus/src/work-id.ts. */
    workKey: varchar('work_key', { length: 64 }).notNull(),
    title: text('title'),
    authorId: uuid('author_id').references(() => author.id),
    dynasty: varchar('dynasty', { length: 32 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workKeyIdx: uniqueIndex('work_work_key_idx').on(t.workKey),
    authorIdx: index('work_author_idx').on(t.authorId),
  }),
);

export const author = pgTable(
  'author',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    nameDisplay: text('name_display').notNull(),
    nameMatch: text('name_match').notNull(),
    dynasty: varchar('dynasty', { length: 32 }),
    birthYear: integer('birth_year'),
    deathYear: integer('death_year'),
    bio: text('bio'),
    dataset: varchar('dataset', { length: 64 }).notNull(),
    sourceFile: text('source_file').notNull(),
    commitSha: varchar('commit_sha', { length: 40 }).notNull(),
  },
  (t) => ({
    nameMatchIdx: index('author_name_match_idx').on(t.nameMatch),
  }),
);

/**
 * One poem is one document. There is no chunking stage (§3.1 item 1) — a quatrain is 20-40
 * characters, and every chunking assumption from a generic RAG design is deleted here.
 */
export const poem = pgTable(
  'poem',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workId: uuid('work_id')
      .notNull()
      .references(() => work.id, { onDelete: 'cascade' }),
    edition: varchar('edition', { length: 64 }).notNull(),
    titleDisplay: text('title_display'),
    titleMatch: text('title_match'),
    /** 詞牌, for 詞 records. Null for 詩. */
    rhythmic: varchar('rhythmic', { length: 64 }),

    textDisplay: text('text_display').notNull(),
    textTrad: text('text_trad').notNull(),
    textSimp: text('text_simp').notNull(),
    /** All matching runs against this. Never match textDisplay. */
    textMatch: text('text_match').notNull(),

    charCount: integer('char_count').notNull(),
    lineCount: integer('line_count').notNull(),

    /** Provenance is required on every local result (§3.1 item 4). */
    dataset: varchar('dataset', { length: 64 }).notNull(),
    sourceFile: text('source_file').notNull(),
    commitSha: varchar('commit_sha', { length: 40 }).notNull(),
    /** Ingest idempotency key (§13). */
    contentHash: varchar('content_hash', { length: 64 }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    contentHashIdx: uniqueIndex('poem_content_hash_idx').on(t.contentHash),
    workIdx: index('poem_work_idx').on(t.workId),
    editionIdx: index('poem_edition_idx').on(t.edition),
  }),
);

/**
 * Line-level records are what make fragment lookup work (§3.1 item 2). The n-gram index lives
 * here as well as on poem.textMatch — a fragment usually spans part of one line.
 */
export const poemLine = pgTable(
  'poem_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    poemId: uuid('poem_id')
      .notNull()
      .references(() => poem.id, { onDelete: 'cascade' }),
    workId: uuid('work_id')
      .notNull()
      .references(() => work.id, { onDelete: 'cascade' }),
    lineNo: smallint('line_no').notNull(),
    textDisplay: text('text_display').notNull(),
    textMatch: text('text_match').notNull(),
    charCount: smallint('char_count').notNull(),
    /** Final character — the rhyme position for even-numbered lines (§10.1). */
    rhymeChar: varchar('rhyme_char', { length: 8 }),
    /** 平仄 pattern from strains/, one character per position. Null until Phase 2. */
    tonePattern: varchar('tone_pattern', { length: 32 }),
  },
  (t) => ({
    poemLineIdx: uniqueIndex('poem_line_poem_no_idx').on(t.poemId, t.lineNo),
    workIdx: index('poem_line_work_idx').on(t.workId),
    charCountIdx: index('poem_line_char_count_idx').on(t.charCount),
  }),
);

// ---------------------------------------------------------------------------
// Run log
// ---------------------------------------------------------------------------

export const searchRun = pgTable('search_run', {
  id: uuid('id').primaryKey(),
  query: text('query').notNull(),
  normalizedQuery: text('normalized_query'),
  intent: varchar('intent', { length: 32 }),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),

  /**
   * Materialized convenience only (§11). The event log stays authoritative and the fold in
   * @han/shared/state must reproduce these. There is a test asserting that property.
   */
  finalStatus: varchar('final_status', { length: 32 }),
  finalConfidence: real('final_confidence'),
  finalFlags: jsonb('final_flags').$type<string[]>().notNull().default([]),
  finalAnswer: text('final_answer'),
  totalCostUsd: real('total_cost_usd').notNull().default(0),
  agentInvoked: boolean('agent_invoked').notNull().default(false),
});

/**
 * Append-only. Never UPDATE an event — corrections are new events (§11).
 * (run_id, seq) is unique, which is what makes reconnect replay deterministic.
 */
export const searchEvent = pgTable(
  'search_event',
  {
    eventId: uuid('event_id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => searchRun.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    step: varchar('step', { length: 32 }).notNull(),
    source: varchar('source', { length: 32 }).notNull(),
    phase: varchar('phase', { length: 16 }).notNull(),
    status: varchar('status', { length: 32 }),
    flags: jsonb('flags').$type<string[]>().notNull().default([]),
    agentIteration: integer('agent_iteration'),
    message: text('message'),
    metadata: jsonb('metadata').notNull().default({}),
  },
  (t) => ({
    runSeqIdx: uniqueIndex('search_event_run_seq_idx').on(t.runId, t.seq),
    metadataIdx: index('search_event_metadata_idx').using('gin', t.metadata),
  }),
);

export const searchResult = pgTable(
  'search_result',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => searchRun.id, { onDelete: 'cascade' }),
    rank: integer('rank').notNull(),
    evidence: jsonb('evidence').notNull(),
  },
  (t) => ({
    runRankIdx: uniqueIndex('search_result_run_rank_idx').on(t.runId, t.rank),
  }),
);

export const toolCall = pgTable('tool_call', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id')
    .notNull()
    .references(() => searchRun.id, { onDelete: 'cascade' }),
  agentIteration: integer('agent_iteration').notNull(),
  toolName: varchar('tool_name', { length: 64 }).notNull(),
  source: varchar('source', { length: 32 }).notNull(),
  status: varchar('status', { length: 32 }).notNull(),
  latencyMs: integer('latency_ms').notNull(),
  resultCount: integer('result_count').notNull().default(0),
  /** Redacted before storage — raw arguments can contain user data. */
  args: jsonb('args').notNull().default({}),
  errorCode: varchar('error_code', { length: 64 }),
  errorMessage: text('error_message'),
});

/** Ingest bookkeeping — makes re-ingest idempotent and regressions attributable. */
export const ingestRun = pgTable('ingest_run', {
  id: uuid('id').primaryKey().defaultRandom(),
  commitSha: varchar('commit_sha', { length: 40 }).notNull(),
  collections: jsonb('collections').$type<string[]>().notNull().default([]),
  poemCount: integer('poem_count').notNull().default(0),
  lineCount: integer('line_count').notNull().default(0),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});

/** Aggregate export for the Drizzle client. */
export const schema = {
  work,
  author,
  poem,
  poemLine,
  searchRun,
  searchEvent,
  searchResult,
  toolCall,
  ingestRun,
};
