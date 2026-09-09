# apps/worker

Temporal worker. Runs the agent loop as a durable workflow so that killing the process
mid-conversation loses nothing — history is replayed and the run continues.

`src/workflows/agent-run.ts` is the loop; `src/activities/` holds the side effects (calling
the model, calling a tool, publishing an event). The split is Temporal's requirement and also a
useful one: the loop is deterministic and testable with time-skipping, the activities are not.

## Two things that cost real time to learn

- **Heartbeats.** A model call can sit idle for 85 seconds. Without a heartbeat Temporal
  declares the activity dead and retries it, paying twice.
- **`nonRetryableErrorTypes` matches on the failure TYPE, not the message.** Matching on
  message text looks like it works and silently retries everything.

Workflow code is bundled by Temporal at worker startup, so `tsx watch` does **not** pick up
changes to `src/workflows/` — restart the worker.
