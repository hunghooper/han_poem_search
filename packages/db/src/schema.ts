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
  primaryKey,
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
    /**
     * The id from the upstream JSON, where the collection has one. Only 全唐诗/poet.*.json
     * does (ADR 004). It is the join key for strains/, which is the corpus's own 平仄 data
     * and the only tonal source available — there is no 平水韻 table in the repo.
     */
    upstreamId: varchar('upstream_id', { length: 64 }),
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
    upstreamIdx: index('poem_upstream_idx').on(t.upstreamId),
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

/**
 * A batch job: one uploaded file, one column, one run over its rows.
 *
 * The uploaded file itself is NOT stored here. It lives on disk beside the job and is
 * referenced by path — a 20MB workbook in a jsonb column would be paid for on every progress
 * poll, and the file is already durable where it is.
 */
export const batchJob = pgTable('batch_job', {
  id: uuid('id').primaryKey().defaultRandom(),
  filename: text('filename').notNull(),
  kind: varchar('kind', { length: 8 }).notNull(),
  /** The normalized JSONL every stage reads, whatever was uploaded. See packages/batch/xlsx.ts. */
  dataPath: text('data_path').notNull(),
  headers: jsonb('headers').$type<string[]>().notNull().default([]),
  /** The column the user chose. Never inferred without being shown and confirmed. */
  queryColumn: text('query_column'),
  totalRows: integer('total_rows').notNull().default(0),

  agentEnabled: boolean('agent_enabled').notNull().default(false),
  /** Null means the user declined a cap, deliberately and with the estimate in front of them. */
  agentCapUsd: real('agent_cap_usd'),

  status: varchar('status', { length: 16 }).notNull().default('scanned'),
  rowsDone: integer('rows_done').notNull().default(0),
  costUsd: real('cost_usd').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  error: text('error'),
});

/**
 * One row of the user's file, once searched.
 *
 * Written as each row finishes rather than accumulated in memory, so a batch that dies at row
 * 40,000 resumes at 40,000 and the export can be produced from whatever is done. `status` is
 * NOT NULL for the same reason the export column is locked: a row that was reached and left
 * without a status is indistinguishable from one that was never reached.
 */
export const batchRow = pgTable(
  'batch_row',
  {
    jobId: uuid('job_id')
      .notNull()
      .references(() => batchJob.id, { onDelete: 'cascade' }),
    /** Zero-based position in the user's file. The join key back to their spreadsheet. */
    rowIndex: integer('row_index').notNull(),
    /** Null when the row was never reached, or when its cell was empty. */
    runId: uuid('run_id'),
    status: varchar('status', { length: 32 }).notNull(),
    /** The whole export payload for this row, already mapped. */
    result: jsonb('result').$type<Record<string, unknown>>(),
    costUsd: real('cost_usd').notNull().default(0),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.jobId, t.rowIndex] }),
  }),
);

/**
 * A poem somebody added, and the trail behind it.
 *
 * The `poem` row itself carries the text and is what search reads. This table carries what
 * search must never have to guess at: who put it there, on what evidence, and whether a person
 * has agreed to it.
 *
 * The split matters most for the AGENT path. The verifier (§10.2) can see when a run found a
 * poem the corpus lacks and is well placed to propose keeping it — but it may not write one
 * in. This session's own history is the argument: a model answered "I do not recognise this,
 * it is probably OCR damage" and the pipeline recorded it as a finding, because nothing was
 * reading the text. Giving that class of component write access to the corpus repeats the
 * mistake permanently, since an `insufficient` that slips through becomes a row every later
 * search can return. So an agent proposal lands `pending` and is not indexed until accepted.
 */
export const corpusAddition = pgTable(
  'corpus_addition',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null while a proposal is pending — no poem row exists until somebody accepts it. */
    poemId: uuid('poem_id').references(() => poem.id, { onDelete: 'set null' }),

    /** 'user' or 'agent'. Never blank: a row that cannot say how it arrived is the thing this table exists to prevent. */
    origin: varchar('origin', { length: 16 }).notNull(),
    status: varchar('status', { length: 16 }).notNull().default('pending'),

    /** The submitted poem, exactly as it arrived, before normalisation touched it. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),

    /** For an agent proposal: the run that produced the evidence, so a reviewer can read it. */
    runId: uuid('run_id'),
    /** Recorded, not verified. There is no auth beyond a stub user (§17), so this is a claim. */
    submittedBy: text('submitted_by'),
    sourceUrl: text('source_url'),
    note: text('note'),

    /** Why a reviewer refused, when they did. Empty on acceptance. */
    reviewNote: text('review_note'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedBy: text('reviewed_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byStatus: index('corpus_addition_status_idx').on(t.status, t.createdAt),
  }),
);

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
  batchJob,
  batchRow,
  corpusAddition,
};
