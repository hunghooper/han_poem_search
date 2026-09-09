# packages/db

Drizzle schema and migrations. Postgres 16 with `pg_bigm`.

## Why character n-grams

Postgres full-text search cannot tokenise Chinese: there are no spaces, and the built-in
parsers produce one token per line. `pg_bigm` indexes character bigrams instead, which is what
makes a substring search over 800,000 lines fast enough to run first on every query.

## The event log is append-only

`search_event` is unique on `(run_id, seq)` and is never updated. A duplicate means a bug
upstream that an upsert would hide. Corrections are new events, not edits.

## Migrations

`pnpm db:generate` writes them, `pnpm db:migrate` applies them. Custom SQL that Drizzle cannot
express (the bigm indexes, the verify indexes) lives in `migrations/custom/` and is applied
after.

`migrations/` is excluded from Prettier — the files are generated, and reformatting them makes
every future diff noise.
