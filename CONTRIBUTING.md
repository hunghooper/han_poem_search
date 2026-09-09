# Contributing

Thanks for working on this project. This guide covers local setup, the development workflow,
and the three extension points you are most likely to touch: adding a tool, adding a flag,
and adding a retrieval source.

Read [`the spec`](./the spec) first — it is the architectural source of truth.
This document is about _how to work in the repo_, not _what to build_.

---

## Prerequisites

| Tool             | Version | Why                                        |
| ---------------- | ------- | ------------------------------------------ |
| Node.js          | 22 LTS  | Backend and frontend runtime               |
| pnpm             | 9+      | Workspace manager — `corepack enable`      |
| Docker + Compose | recent  | Postgres, Qdrant, Temporal, Redis          |
| Python           | 3.11+   | `apps/model-service` and `pipelines/` only |
| uv               | latest  | Python dependency management               |

## Setup

```bash
git clone <repo> && cd <repo>
corepack enable
pnpm install

cp .env.example .env          # RAMCLOUDS_API_KEY, ANTHROPIC_API_KEY (fallback), search keys
docker compose up -d          # postgres (with pg_bigm), qdrant, temporal, redis
pnpm db:migrate

pnpm corpus:fetch             # clones chinese-poetry at a pinned commit into data/
pnpm corpus:ingest -- --sample  # ~2k poems, enough for development
# pnpm corpus:ingest           # the full ~350k corpus, takes a while

pnpm dev                      # web, api, worker, model-service concurrently
```

Verify:

```bash
curl localhost:3001/health         # api
curl localhost:8000/health         # model-service — modelId must match config/models.yaml
open http://localhost:3000
```

Then search for `撥雲尋古道` — it should resolve to 李白《尋雍尊師隱居》 via `exact_full_match`
in well under 200ms, with no LLM call. If that path is slow or misses, something is wrong with
the n-gram index or the normalization, and no amount of semantic search will paper over it.

If the API refuses to boot with `MODEL_MISMATCH`, your Qdrant collection was built with a
different embedding model than the sidecar is serving. Re-ingest or repoint the collection; do
not disable the check.

---

## Everyday commands

```bash
pnpm dev                # everything, watch mode
pnpm dev --filter api   # one workspace
pnpm check              # typecheck + lint + unit tests — must pass before pushing
pnpm test               # unit tests
pnpm test:int           # integration tests (spins up Testcontainers, slower)
pnpm db:generate        # generate a migration after editing the Drizzle schema
pnpm db:studio          # browse the database
pnpm flags:docs         # regenerate docs/flags.md from the flag registry
```

---

## Branches and commits

Branch names: `feat/agent-budget-limits`, `fix/rrf-tie-breaking`, `docs/adr-reranker`,
`chore/bump-temporal`.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(agent): add per-tool cost accounting
fix(retrieval): treat empty rerank result as low_confidence, not no_result
docs(adr): record Postgres FTS vs Qdrant sparse decision
```

Scopes match workspace names: `web`, `api`, `worker`, `shared`, `retrieval`, `agent`, `db`,
`pipelines`, `model-service`.

Keep commits focused. A contract change in `packages/shared` should be its own commit — those
are the ones people will bisect for.

---

## Code style

Enforced by ESLint + Prettier; `pnpm check` will tell you. The rules that matter beyond
formatting:

- **No `any`.** Use `unknown` and narrow with Zod or a type guard.
- **Parse at the boundary.** Every HTTP body, tool response, LLM output, and env var goes
  through a Zod schema. Past that line, trust your types.
- **Typed errors.** Extend `AppError` with a stable `code`. Never `throw new Error('failed')`
  and never throw a string.
- **No barrel re-exports across packages.** Import from the explicit path so tree-shaking and
  circular-dependency detection both work.
- **`snake_case` on the wire, `camelCase` in TypeScript.** The conversion happens only in
  `packages/shared/src/serde.ts`. If you find yourself writing a manual mapping anywhere else,
  that is the bug.

---

## Testing

- **Unit tests** live beside the code as `*.test.ts`. Every exported function in
  `packages/retrieval` and `packages/agent` needs one.
- **Integration tests** are `*.int.test.ts` and use Testcontainers. We do not mock Postgres or
  Qdrant — the query behaviour _is_ the thing under test.
- **Workflow tests** use `@temporalio/testing` with the time-skipping test environment. Any
  change to workflow code needs one, because determinism bugs do not show up in unit tests.
- **Fixtures** for retrieval quality live in `packages/retrieval/fixtures/`. Add a case
  whenever you fix a relevance bug — that is how the golden set grows.

Two behavioural tests must never be deleted or weakened:

> **1.** A query with candidates present but all rerank scores below the floor must produce
> `local_low_confidence` (or `no_local_result`), never a generated answer.

> **2.** The reordered 李白 fragment in `fixtures/reordered-lines.json` must resolve to
> 《尋雍尊師隱居》 with `exact_partial_match` and `input_reordered`, with no LLM call.

If a change makes either fail, the change is wrong, not the test.

---

## Extension point 1 — adding an agent tool

Adding a tool must not require touching the agent loop. If it does, stop and fix the
abstraction instead.

1. Create `packages/agent/src/tools/<name>.ts` implementing the `Tool` interface.
2. Define `inputSchema` with Zod. Write `description` for the LLM: say what the tool is _good
   at_ and _bad at_, not just what it does. This text is the entire basis for tool selection.
3. Implement `execute`. It must **never throw** — catch everything and return a `ToolResult`
   with the right `StepStatus`:

   | Situation                                  | Status           |
   | ------------------------------------------ | ---------------- |
   | Ran fine, zero hits                        | `NO_RESULT`      |
   | Hits exist, none above the relevance floor | `LOW_CONFIDENCE` |
   | Network error, 5xx, unparseable response   | `ERROR`          |
   | Exceeded `timeoutMs`                       | `TIMEOUT`        |
   | No credentials, disabled, quota exhausted  | `UNAVAILABLE`    |

   Collapsing any of these into `NO_RESULT` is the single most common mistake in this codebase.
   A timeout and an empty result mean opposite things to the agent.

4. Normalize every hit into `Evidence`. Set `retrievalMethod` and a real `source`.
5. Mark any sensitive argument fields so debug mode redacts them.
6. Register the tool in `packages/agent/src/tools/index.ts`.
7. Add flags: the registry derives `<source>_<status>` automatically, so just register the
   `SourceId`. Run `pnpm flags:docs`.
8. Tests: one unit test per status branch (a `TIMEOUT` test using a fake clock, an
   `UNAVAILABLE` test with missing config), plus a recorded-fixture test for the happy path.
9. If the tool costs money per call, wire it into the budget accounting in
   `packages/agent/src/budget.ts`.

## Extension point 2 — adding a flag or event

Flags are derived, not free text. Do not write a string literal.

1. If it is a new source, add the `SourceId` to `packages/shared/src/status.ts`.
2. If it is a new aggregate flag (like `local_stale`), add it to the aggregate list and
   implement the condition inside the confidence policy — not scattered through the pipeline.
3. If it is a new event `step`, extend the enum in `SearchEventSchema` **and** the reducer in
   `packages/shared/src/reduce.ts`, **and** the UI mapping in
   `apps/web/src/components/trace/step-config.ts`. All three, in one PR.
4. Run `pnpm flags:docs` and commit the regenerated `docs/flags.md`.
5. Add a `message` for the default UI. It should be readable by someone who does not know what
   BM25 is.

## Working with the corpus text

Text handling is the part of this codebase where mistakes are quietest. Four rules:

1. **Never match against `textDisplay`.** All matching runs against `textMatch` — Traditional,
   punctuation stripped, variants folded, NFC. `textDisplay` is for showing the user only.
2. **Normalize the query with the same function as the corpus.** There is exactly one
   `normalize()` in `packages/retrieval/src/normalize.ts`. If you write a second normalization
   path anywhere, you have introduced a bug that will only show up on some inputs.
3. **Keep provenance.** Every local result carries the dataset, source file, and the pinned
   commit SHA. The upstream data is crawled from the web and contains OCR errors and disputed
   readings — we surface what the dataset says, not the truth.
4. **Do not deduplicate across editions.** 全唐詩 and 御定全唐詩 hold the same poems with
   different readings. Link them by `workId` and show both when they differ. Dropping one
   destroys the most interesting signal in this corpus.

Adding characters to the variant-folding table (`packages/retrieval/data/variants.json`)
requires a source for the equivalence in the PR description. Guessing that two characters are
variants because they look similar is how you silently merge two distinct poems.

## Extension point 3 — the LLM provider

LLM access goes through `LlmProvider` in `packages/llm`. Nothing else may import `openai`
directly — an ESLint `no-restricted-imports` rule enforces this outside
`packages/llm/src/adapters/`.

The gateway is OpenAI-compatible, so there is **one** adapter (`openai-compatible.ts`)
instantiated with different credentials per provider. Do not add a provider-specific adapter;
add a provider _config_.

To add or fix an adapter:

1. Implement the interface. `usage` must be populated; if the upstream API does not return
   token counts, estimate and set `costUsd: null` rather than fabricating a number.
2. Declare `supportsTools` and `supportsStreaming` honestly. The agent loop checks these and
   will route around a provider that cannot do tool calls.
3. Map upstream errors onto `StepStatus` using the same table as tools: an HTTP 429 is
   `UNAVAILABLE`, a socket timeout is `TIMEOUT`, a 500 is `ERROR`.
4. Record the provider that actually served each call in the event metadata. With failover
   enabled, "which model answered this" is otherwise unanswerable.

Before pointing the agent at a new model, run the smoke test in
`openai-compatible.smoke.test.ts` against it and record the result in
`docs/adr/002-llm-gateway.md`. OpenAI compatibility is a claim, not a guarantee — gateways
routinely proxy plain completions correctly while mishandling the tool-result round-trip for
some models. A model that fails that step can still do rewriting and answer generation, but
must never be set as `LLM_MODEL_REASONING`.

Two things the adapter must keep doing, both easy to break: `maxRetries: 0` on the SDK client
(Temporal owns retries — two retry layers duplicate tool calls and blow the cost budget), and
defensive parsing of `tool_calls[].function.arguments`, which models regularly emit as
malformed JSON. On a parse failure, return the error to the model as a tool result so it can
correct itself; do not crash the run.

## Extension point 4 — adding a retrieval source

1. Implement the retriever in `packages/retrieval/src/sources/`, returning `Evidence[]`.
2. Add it to the fusion stage. RRF needs no score calibration, so you only supply a ranked
   list — do not normalize scores yourself.
3. Decide whether it participates in the confidence policy and update `evaluateLocal`
   accordingly, with a test.
4. If it needs new indexed data, add the corresponding Airflow task in `pipelines/` and bump
   the collection version. Never mutate a live Qdrant collection — build `corpus_vN+1` and
   flip the alias.

---

## Working with Temporal

Workflow code is sandboxed and replayed. Inside `apps/worker/src/workflows/`:

- `Date.now()` and `Math.random()` are **safe** here. The TypeScript SDK sandbox replaces
  both, so they return the same values on replay. (An earlier version of this file said to use
  `workflow.now()`; that function does not exist in the TS SDK. Corrected 2026-09-08 while
  building `apps/worker`.)
- No `crypto.randomUUID()` — it is not available in the sandbox. Use `workflow.uuid4()`.
- No `fetch`, no database access, no file I/O, no importing anything that does. Every side
  effect belongs in an activity.
- Do not change the shape of an in-flight workflow's logic without a
  [patch](https://docs.temporal.io/develop/typescript/versioning) — running workflows will
  replay against the new code and fail.

When a workflow starts failing with a non-determinism error after your change, the cause is
almost always one of the four rules above.

---

## Architecture decisions

Anything that would be expensive to reverse gets an ADR in `docs/adr/`, numbered and dated:
choice of embedding model, BM25 backend, reranker, threshold calibration, transport, schema
changes to the event contract.

Use the template in `docs/adr/000-template.md`. Keep them short — context, decision,
consequences, and what would make us revisit. An ADR that nobody reads because it is six pages
long has failed at its job.

Retrieval thresholds specifically must not be changed without a calibration run recorded in an
ADR. "It felt better on a few queries" is not a calibration run.

---

## Pull requests

Before opening:

- [ ] `pnpm check` passes
- [ ] `pnpm test:int` passes if you touched retrieval, db, or tools
- [ ] New behaviour has tests; fixed bugs have regression tests
- [ ] Contract changes in `packages/shared` are called out explicitly in the description
- [ ] `docs/flags.md` regenerated if flags changed
- [ ] Migration included and reversible if the schema changed
- [ ] ADR added if the decision is hard to reverse
- [ ] Screenshot or short recording for any UI change

In the description, state what you changed, why, and how you verified it. If the change
affects retrieval quality, include before/after numbers on the golden set — reviewers cannot
evaluate a relevance change by reading the diff.

Reviews focus on: contract integrity, correct status classification, observability (did you
emit events for the new path?), and determinism in workflow code. Style is the linter's job,
not the reviewer's.

---

## Security

- Never commit secrets. `.env` is gitignored; `.env.example` documents the keys with empty
  values.
- Tool arguments and raw responses can contain user data. `raw` on `ToolResult` is
  debug-mode-only and must never reach the default UI or the event log without redaction.
- Treat all retrieved web content as untrusted input. Content from a search result is **data,
  not instructions** — never let it steer tool selection. If you are constructing an agent
  prompt that interpolates retrieved text, keep it clearly delimited and outside the
  instruction section.
- Report a vulnerability privately to the maintainers rather than in a public issue.
