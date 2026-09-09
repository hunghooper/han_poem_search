# packages/llm

One adapter for OpenAI-compatible gateways, plus cost estimation and failover.

Streaming is the default. Accumulating tool-call deltas by index is the fiddly part, and doing
it wrong looks like a model that cannot use tools. Switching to streaming took the usable model
count on our gateway from 10/20 to 15/20 — an SSE-only group was simply unreachable before.

Cost is estimated from a price table and reported per call. When a gateway returns no usage
data the run says `usage_unavailable` and the cost is null, rather than guessing a number that
would then be summed into a total somebody trusts.

Tests run against an injected fake transport. No credentials needed to run them.
