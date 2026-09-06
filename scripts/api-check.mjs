/** End-to-end check of the API: search, stream, and lossless reconnect (§14.1, §16). */
import WebSocket from 'ws';

const BASE = 'http://localhost:3001';
const Q = '自下寒煙 卧松高 白鶴眠 語来江色暮 獨 尋古道 倚石聽流泉 花暖青牛 羣峭碧摩天 逍遥不記年 撥雲';

const post = async (query) => {
  const r = await fetch(`${BASE}/api/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return (await r.json()).run_id;
};

const collect = (runId, lastSeq) =>
  new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:3001/api/runs/${runId}/stream`);
    const got = [];
    ws.on('open', () => ws.send(JSON.stringify({ lastSeq })));
    ws.on('message', (m) => {
      const e = JSON.parse(m.toString());
      got.push(e);
      if (e.step === 'final_answer') setTimeout(() => { ws.close(); resolve(got); }, 120);
    });
    setTimeout(() => { ws.close(); resolve(got); }, 4000);
  });

const runId = await post(Q);
console.log('runId', runId);

// Give the run time to finish, then replay the whole thing from scratch.
await new Promise((r) => setTimeout(r, 800));
const full = await collect(runId, -1);
console.log(`full replay: ${full.length} events, seqs ${full.map((e) => e.seq).join(',')}`);

const mid = Math.floor(full.length / 2) - 1;
const resumed = await collect(runId, mid);
console.log(`resume after seq ${mid}: ${resumed.length} events, seqs ${resumed.map((e) => e.seq).join(',')}`);

const state = await (await fetch(`${BASE}/api/runs/${runId}`)).json();
const answer = full.find((e) => e.step === 'final_answer');
console.log('\nfinal answer :', answer?.message);
console.log('flags        :', answer?.flags.join(' '));
console.log('folded flags :', state.state.flags.join(' '));
console.log('evidence     :', state.events.length, 'events stored');

const ok =
  full.length > resumed.length &&
  resumed.every((e) => e.seq > mid) &&
  full.length === mid + 1 + resumed.length &&
  answer?.flags.includes('input_reordered') &&
  answer?.message?.includes('尋雍尊師隱居');
console.log('\n' + (ok ? 'PASS — replay is lossless and gap-free, answer correct' : 'FAIL'));
process.exit(ok ? 0 : 1);
