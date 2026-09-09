# packages/shared

Types and vocabulary both sides depend on. No I/O, no database, no framework.

## Why the status vocabulary is here

`status.ts` defines eight step statuses, and the distinctions between them are the point of
the whole project:

    has_result      it ran and found something
    no_result       it ran and found nothing — it looked
    low_confidence  it found something it does not trust enough to assert
    error           it failed — it did NOT look
    timeout         it ran out of time — it did NOT finish looking
    unavailable     not configured, or down — it did NOT look
    skipped         deliberately not run — it did NOT look
    not_executed    the run never got here

Collapsing any of these into `no_result` turns "we could not look" into "there is nothing
there". That is the single most damaging mistake available in this codebase.

## The rest

- `flags.ts` — the flag registry. Nothing outside it may build a flag from a string literal.
- `state.ts` — the pure fold that derives run state from the event stream. The frontend runs it
  on the live socket; the backend runs it to rebuild state on reconnect. It must stay total: an
  event stream arriving out of order is a normal condition, not a crash.
- `trace.ts` — trace messages as a code plus values, composable, so a run can be read in a
  language other than the one it was searched in.
- `serde.ts` — snake_case on the wire, camelCase in TypeScript. The only place that conversion
  happens.
- `corpus-addition.ts` — the rules a poem must pass to enter the corpus, applied in the browser
  for speed and again on the server because a browser check is a convenience, not a guard.
