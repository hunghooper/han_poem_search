# apps/api

Fastify server. Owns the search pipeline, the batch runner, the corpus routes, and the
WebSocket that streams a run while it happens.

## The pipeline, in order

`src/search.ts` is the spine:

    colophon split -> exact -> (short circuit?) -> bm25 + vector -> RRF -> rerank
                   -> confidence policy -> agent (if unresolved) -> rule verification
                   -> LLM verification -> answer

Two orderings in there are load-bearing:

- **Exact runs first and can short-circuit.** Most queries are a clean fragment of a poem that
  is in the corpus, and answering those without touching a model is the difference between 3 ms
  and 3 seconds.
- **Rule verification runs AFTER the agent**, because it verifies _the answer_, and until the
  agent has finished nobody knows which candidate that is. It used to run before, on the local
  candidate, and the form columns went out empty on exactly the rows where a model rather than
  the corpus produced the answer.

## Events are the record

Every stage emits a started/completed event. A stage that does not emit is a stage the user
cannot see, including when it fails. `src/events.ts` holds the in-memory store (the read path
for the live stream and for reconnect replay); `src/event-sink.ts` writes them through to
Postgres, append-only, never updated.

Each event carries both an English `message` and a `messageTrace` code, so a run reopened
later renders in the reader's language rather than the one it was searched in. See
`packages/shared/src/trace.ts`.

## Batch

`src/batch-runner.ts` runs a file row by row through the same `runSearch` a single query
uses. Durability is Postgres's, not Temporal's: a row is committed the moment it is done, so
killing the process loses at most the row in flight.

An interrupted job is **marked**, not restarted. It used to be relaunched at boot, and under
`tsx watch` that meant a relaunch on every file save — one abandoned job cost $11.88 nobody
asked for. Picking it up again is the explicit re-run the API already demands.
