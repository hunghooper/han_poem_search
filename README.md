# han_poem_search

Search classical Chinese poetry from a damaged fragment.

You paste a few characters copied off a scroll, a photograph, or an OCR pass — out of order,
missing characters, with the signature block still attached — and it tells you which poem that
is, who wrote it, and how sure it is.

The hard part is not finding candidates. It is **saying nothing when there is nothing to say.**
Most search returns its best match no matter what, which for calligraphy is the worst failure
available: you get a confident-looking title with no way to tell whether it is right or merely
the closest thing in the index.

- **[the spec](./the spec)** — the architectural source of truth.
- **[CONTRIBUTING.md](./CONTRIBUTING.md)** — how to work in the repo.
- **[docs/adr/](./docs/adr/)** — decisions that would be expensive to reverse.
- **[docs/TODO.md](./docs/TODO.md)** — what is not built, and why.

## Running it

```bash
corepack enable && pnpm install
docker compose up -d          # postgres (pg_bigm), qdrant, redis, temporal
pnpm db:migrate
git clone --depth 1 https://github.com/chinese-poetry/chinese-poetry local/chinese-poetry
pnpm --filter @han/corpus exec tsx src/ingest.ts
pnpm dev
```

The corpus is roughly 78,000 poems and 800,000 lines. Semantic search and re-ranking need
`apps/model-service` on a CUDA box; everything else runs without a GPU. The agent needs an
OpenAI-compatible gateway in `.env` — without one it reports `unavailable` and the rest still
works.

Everything on disk that is not source — the cloned corpus, uploaded files, exports — lives
under `local/`, which is git-ignored. Nothing in there belongs in a commit.

`scripts/accept.ts` runs the acceptance criteria against the real index.

## Reading the output

Every result carries tags. They are the whole interface between what the system did and what
you are entitled to conclude, so they are worth reading properly.

### Statuses — what a step did

One per step, and the distinctions are the point. Collapsing any of them into `no_result` turns
_we could not look_ into _there is nothing there_.

| status           | meaning                                                |
| ---------------- | ------------------------------------------------------ |
| `has_result`     | It ran and found something.                            |
| `no_result`      | It ran and found nothing. **It looked.**               |
| `low_confidence` | It found something it does not trust enough to assert. |
| `error`          | It failed. It did **not** look.                        |
| `timeout`        | It ran out of time. It did **not** finish looking.     |
| `unavailable`    | Not configured, or down. It did **not** look.          |
| `skipped`        | Deliberately not run. It did **not** look.             |
| `not_executed`   | The run never reached this step.                       |

### Flags — what the run as a whole concluded

| flag                     | meaning                                                           |
| ------------------------ | ----------------------------------------------------------------- |
| `local_result_found`     | The corpus answered, confidently.                                 |
| `no_local_result`        | The corpus did not answer.                                        |
| `local_low_confidence`   | There is a candidate, but it is a candidate, not an answer.       |
| `local_incomplete`       | Some retriever did not run, so the comparison was not a fair one. |
| `exact_full_match`       | A contiguous run of the query matched one work.                   |
| `exact_partial_match`    | Several windows of the query agree on one work.                   |
| `exact_ambiguous`        | An exact run resolves to more than one work.                      |
| `variant_text_detected`  | The pasted text and this edition disagree on some characters.     |
| `input_reordered`        | The lines were read out of order and had to be rearranged.        |
| `model_has_result`       | The answer came from the agent, not from the corpus.              |
| `agent_budget_exhausted` | The agent stopped on a limit, so the answer is partial.           |
| `agent_model_failed`     | The reasoning model failed — different from finding nothing.      |
| `final_answer_uncited`   | An answer with nothing to cite for it.                            |
| `llm_failover`           | The primary model was unavailable and a fallback answered.        |
| `usage_unavailable`      | The gateway reported no token usage, so cost is null, not zero.   |

`docs/flags.md` is generated from the registry and lists the derived `${source}_${status}`
flags too.

### What the tags actually tell you

**`exact_full_match` does not mean "the whole poem matched".** `classify()` calls a run _full_
once it is contiguous and resolves to one work, regardless of how much of the query it covers —
so five characters can earn it. Read it alongside the overlap, not on its own.

**An exact match can be a coincidence, and one particular kind is worth knowing about.**
Calibrating the overlap floor over 686 real matches, a 0.15 floor rejected 0.9% of them, and
every one of those six was wrong on inspection. One resolved to a _later_ poem that quotes the
phrase being searched for — the run really was contiguous, really did resolve to one work, and
was still the wrong answer. Quotation is not yet modelled.

**`no_local_result` and `model_has_result` together is the interesting row.** The corpus had
nothing and the agent found something outside it. The row carries an answer, and that answer
has not been checked against the corpus — which is exactly why it is flagged rather than
promoted to `has_result`.

**`input_reordered` makes the form check abstain, not pass.** If the lines were rearranged, the
input's shape says nothing about the poem's shape, so comparing them would be measuring our own
reordering.

**A failing tone check is not a wrong answer.** Over 25,000 poems, 22% of everything the shape
classifier calls regulated verse fails its own tone check — all of them correct by
construction. So tone never rejects; it only ever corroborates. A check that fires on a fifth
of correct answers teaches people to ignore the column.

**Where answers actually come from.** On a real 5,425-row run over calligraphy transcriptions:

| source            | rows  |
| ----------------- | ----- |
| keyword (bm25)    | 1,865 |
| exact             | 905   |
| semantic (vector) | 783   |
| outside site      | 123   |
| the model itself  | 48    |

The agent ran on 4,528 of those rows and came back empty on 4,245 of them. That is not a
failure — most of what people photograph is a couplet, an aphorism, or a later poem that no
Tang-and-Song corpus contains, and saying so is the correct answer.

## How a query flows

    colophon split -> exact -> (short circuit?) -> bm25 + vector -> RRF -> rerank
                   -> confidence policy -> agent (if unresolved) -> rule verification
                   -> LLM verification -> answer

Exact runs first and short-circuits, because most queries are a clean fragment and answering
those without a model is 3 ms instead of 3 seconds. Rule verification runs _after_ the agent,
because it verifies the answer — and until the agent has finished, nobody knows what that is.

Two models, with different jobs: one researches and has tools, one judges and has none. The
second exists because the first once replied _"I do not recognise this, it is probably OCR
damage"_ and the pipeline recorded a result, because any non-empty reply is a reply.

## Layout

|                                            |                                                              |
| ------------------------------------------ | ------------------------------------------------------------ |
| [apps/api](./apps/api)                     | Fastify server: pipeline, batch runner, event log, WebSocket |
| [apps/web](./apps/web)                     | Next.js front end, three languages including the trace       |
| [apps/worker](./apps/worker)               | Temporal worker running the agent loop durably               |
| [apps/model-service](./apps/model-service) | FastAPI: embeddings and re-ranking, the only Python          |
| [packages/shared](./packages/shared)       | Status and flag vocabulary, event types, the state fold      |
| [packages/retrieval](./packages/retrieval) | Normalisation, retrievers, confidence policy, prosody        |
| [packages/agent](./packages/agent)         | The two models, tools, budgets                               |
| [packages/llm](./packages/llm)             | Gateway adapter, streaming, cost                             |
| [packages/batch](./packages/batch)         | File in, file plus columns out                               |
| [packages/db](./packages/db)               | Drizzle schema and migrations                                |
| [packages/corpus](./packages/corpus)       | Fetch and ingest                                             |
| [packages/config](./packages/config)       | Runtime configuration                                        |
| [scripts](./scripts)                       | Acceptance, evaluation, calibration, smoke tests             |

Each folder has its own README covering the decisions specific to it.

## State

360 tests, typecheck and lint clean, acceptance criteria passing. Recall@10 is 100% over the
synthetic query set with MRR 0.987; the thresholds and prosody tables are calibrated against
measured data, not chosen by feel.

It is not deployed. There is no Dockerfile for the app itself, no CI, and no auth — the name on
a corpus addition is a record, not a control. `docs/TODO.md` lists 17 open items with the
reasoning for each.
