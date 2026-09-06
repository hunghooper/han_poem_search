-- pg_bigm n-gram indexes — the spec §7.1, ADR 001.
--
-- Drizzle cannot express a gin_bigm_ops operator class, so this lives in raw SQL. The brief
-- anticipates exactly this (§2, ORM row: "Raw SQL escape hatch needed for pg_bigm").
--
-- These are the indexes the primary retriever depends on. Without them every fragment lookup
-- degrades to a sequential scan over ~350k rows, which still returns correct answers — just
-- 1000x too slowly to notice in a test. That is why 002-verify-indexes.sql exists.

CREATE INDEX IF NOT EXISTS poem_line_text_match_bigm_idx
  ON poem_line USING gin (text_match gin_bigm_ops);

CREATE INDEX IF NOT EXISTS poem_text_match_bigm_idx
  ON poem USING gin (text_match gin_bigm_ops);

-- Title lookup: "which poem is 尋雍尊師隱居" is a metadata query, not a fragment query,
-- but it runs through the same index machinery.
CREATE INDEX IF NOT EXISTS poem_title_match_bigm_idx
  ON poem USING gin (title_match gin_bigm_ops);

-- pg_bigm's similarity threshold. 2-gram similarity on 5-character lines is coarse, so this
-- is deliberately permissive: exact_ngram filters candidates itself by span coverage, and a
-- restrictive threshold here would silently drop damaged input before we ever see it.
SET pg_bigm.similarity_limit = 0.1;
