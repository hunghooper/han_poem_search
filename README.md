# han_search

Agentic semantic search over classical Chinese poetry: exact fragment matching, keyword and
semantic search, re-ranking, and an LLM agent that takes over when local retrieval cannot
confidently answer.

- **[the spec](./the spec)** — the architectural source of truth.
- **[CONTRIBUTING.md](./CONTRIBUTING.md)** — how to work in the repo.
- **[docs/adr/](./docs/adr/)** — decisions that would be expensive to reverse.
- **[docs/TODO.md](./docs/TODO.md)** — what is not built yet.

Status: **Phase 2.** Exact fragment matching, BM25 over character bigrams, dense retrieval
with BGE-M3, RRF fusion, cross-encoder reranking, and deterministic verification of form,
rhyme and 平仄 — the last using tables derived from the corpus itself (ADR 007). The agent
fallback (Phase 3) is not built.

```bash
corepack enable && pnpm install
docker compose up -d          # builds the pg_bigm image on first run
pnpm db:migrate
git clone --depth 1 https://github.com/chinese-poetry/chinese-poetry data/chinese-poetry
pnpm --filter @han/corpus exec tsx src/ingest.ts
pnpm dev
```

Then paste a damaged fragment. `scripts/accept.ts` runs the §16 acceptance criteria and
`scripts/golden-check.ts` runs the golden set, both against the real index.
