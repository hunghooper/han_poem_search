import fs from 'node:fs';
const p = 'docs/adr/002-llm-gateway.md';
let s = fs.readFileSync(p, 'utf8');
s = s.replace(
  '## Configured models',
  `## What running the agent for real found

Wiring the loop into the API and pointing it at a live gateway surfaced four defects that no
amount of fake-transport testing would have:

1. **`satisfied()` judged the wrong thing.** The agent is seeded with the local retrieval
   summaries so the model can see what has been tried. Checking those for satisfaction meant
   the agent saw bm25 and vector reporting `has_result` — the very results local evaluation
   had just called insufficient — and declared success on its first pass, immediately after
   its one tool call had TIMED OUT. It stopped having achieved nothing and reported success.
   Now judged on evidence the agent itself collected.

2. **An LLM failure escaped the run entirely.** When the reasoning call threw, the error left
   `runAgent`, left the search pipeline, and was swallowed by a `.catch()` in the server. No
   `final_answer` was ever emitted, so the client waited forever — indistinguishable from a
   slow run. This was the most opaque failure the system could produce, and §1 names opaque
   failure as unacceptable. Now converted to a partial outcome, with a belt-and-braces catch
   in the pipeline so nothing can prevent a run from terminating.

3. **A tool timeout longer than the run budget.** \`ask_model\` had a 90s timeout inside a 60s
   wall clock, so it could never complete on its own terms — every call was cut off by the run
   instead, and the trace blamed the budget rather than the tool. Guarded structurally: a test
   asserts no registered tool can outlive \`maxWallClockMs\`.

4. **Agent evidence ranked below the results it was called in to replace.** The agent
   correctly identified 《南國山河》 and the answer still displayed 憶潼關 via bm25 — the
   low-confidence local hit the confidence policy had just rejected. Agent evidence now ranks
   first when local retrieval was not confident.

## Answer-model latency, measured

The reasoning models that pass the smoke test are too slow to answer inside the agent budget.
On "identify the poem beginning 南國山河南帝居", \`max_tokens: 2048\`:

| model | latency | reasoning tokens | result |
|---|---|---|---|
| **gemini-3.8-flash** | **6.7s** | 423 | correct — identifies 南國山河 / Nam quốc sơn hà |
| MiniMax-M3 | 11.8s | 0 | honest but wrong ("I don't recognize this") |
| glm-5.3 | 39.7s | 2048 | **empty** — spent the whole budget reasoning |
| qwen-3.8-flash | 44.6s | 4665 | correct |
| qwen-3.8-max | 58.4s | 6761 | correct |

\`glm-5.3\` returning empty content after 40s is the §4.5 reasoning-token trap again, at a
budget six times larger. \`LLM_MODEL_ANSWER\` is therefore \`gemini-3.8-flash\`: reasoning
capability is not what this call needs, speed is.

Note that reasoning token counts exceed the requested \`max_tokens\` on some models, so the
gateway does not appear to enforce it against reasoning. Do not rely on \`max_tokens\` to bound
latency.

## Configured models`,
);
s = s.replace(
  'LLM_MODEL_ANSWER=glm-5.3             # final answer generation',
  'LLM_MODEL_ANSWER=gemini-3.8-flash    # final answer — must be FAST, not clever',
);
fs.writeFileSync(p, s, 'utf8');
console.log('ok');
