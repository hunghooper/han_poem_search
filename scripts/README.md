# scripts

One-off and periodic jobs, run with `pnpm exec tsx`.

- `accept.ts` — the acceptance criteria, asserted end to end against a live database. This is
  the check that says the system still does the thing it exists to do.
- `eval.ts` — recall and MRR over the synthetic query set.
- `prosody-calibration.ts` — builds the tone and rhyme tables from the corpus and measures how
  often each check would reject a poem against itself. The false-rejection numbers quoted in
  `packages/retrieval/README.md` come from here.
- `smoke-gateway.ts` — which models on the configured gateway can actually do what the agent
  needs (tools, streaming, JSON). Writes into `local/reports/`, which is not committed.
- `flags-docs.ts` — regenerates `docs/flags.md` from the registry. Do not edit that file by
  hand.
