# han_search

Agentic semantic search over classical Chinese poetry: exact fragment matching, keyword and
semantic search, re-ranking, and an LLM agent that takes over when local retrieval cannot
confidently answer.

- **[the spec](./the spec)** — the architectural source of truth.
- **[CONTRIBUTING.md](./CONTRIBUTING.md)** — how to work in the repo.
- **[docs/adr/](./docs/adr/)** — decisions that would be expensive to reverse.
- **[docs/TODO.md](./docs/TODO.md)** — what is not built yet.

Status: **Phase 1, in progress.** Contracts, normalization, and reading-order recovery are
in place with tests. Index, ingest, API, and UI are not.

```bash
corepack enable && pnpm install
pnpm test          # unit tests
pnpm check         # typecheck + lint + tests
```
