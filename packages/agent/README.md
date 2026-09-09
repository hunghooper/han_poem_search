# packages/agent

The two models, and the tools one of them can call.

## Two models, different jobs

- **The researcher** has tools and a loop. It searches outside the corpus and draws on knowledge
  in its weights that is nowhere in this dataset.
- **The judge** (`verify-llm.ts`) has no tools and does not search. It reads what the run
  collected and answers one question: does this evidence settle the query?

The judge exists because of a specific failure. Asked to identify a garbled transcription, the
researcher replied "I do not recognise this; it is most likely OCR damage" — an honest and
correct refusal. The pipeline counted it as a result, because any non-empty reply is a reply.
A correct `no_result` became a `low_confidence` guess. Telling the difference requires reading
the text, which is what a judge is for.

## Budgets are checked before spending, not after

`budget.ts` caps iterations, tool calls, wall clock and dollars. A test asserts no registered
tool can outlive the agent's wall clock — a tool that can is a run that hangs past its own
deadline.

## Tools

`tools/search-souyun.ts` is the first source outside the corpus. It is polite by construction:
one request at a time, a fixed gap between them, an hour-long cache, an honest user agent. It
is a scraper and it will break; the recorded fixture is the contract and the test is the alarm.
