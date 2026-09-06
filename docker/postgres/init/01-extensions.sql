-- Extensions required by the retrieval layer. Runs once, on first cluster init.
CREATE EXTENSION IF NOT EXISTS pg_bigm;
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- for benchmarking against pg_bigm (§18 Q3)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Sanity check: if pg_bigm did not load, fail loudly at init rather than silently
-- degrading every fragment lookup to a sequential scan.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_bigm') THEN
    RAISE EXCEPTION 'pg_bigm is not installed — the exact_ngram retriever will not work';
  END IF;
END
$$;
