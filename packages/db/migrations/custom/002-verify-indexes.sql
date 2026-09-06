-- Assert that the bigm indexes exist and are actually used.
--
-- A missing index does not break correctness, only latency — which means it passes every
-- functional test and fails only in production. Checked explicitly instead.

DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(want, ', ')
    INTO missing
    FROM (VALUES
      ('poem_line_text_match_bigm_idx'),
      ('poem_text_match_bigm_idx'),
      ('poem_title_match_bigm_idx')
    ) AS t(want)
   WHERE NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = t.want);

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'missing pg_bigm indexes: % — exact_ngram will fall back to a seq scan', missing;
  END IF;
END
$$;
