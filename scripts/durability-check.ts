const API = 'http://localhost:3001';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Ev {
  seq: number;
  step: string;
  status?: string;
  message?: string;
}

const events = async (runId: string): Promise<Ev[]> =>
  ((await (await fetch(`${API}/api/runs/${runId}`)).json()) as { events: Ev[] }).events;

async function start(): Promise<void> {
  const res = await fetch(`${API}/api/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'Nam quốc sơn hà nam đế cư 南國山河南帝居' }),
  });
  const { run_id: runId } = (await res.json()) as { run_id: string };

  for (let i = 0; i < 200; i += 1) {
    const evs = await events(runId);
    if (evs.some((e) => e.step === 'agent')) {
      console.error(`agent started · ${evs.length} events before the kill`);
      console.log(runId);
      return;
    }
    if (evs.some((e) => e.step === 'final_answer')) {
      console.error('run finished before the agent started — nothing to kill');
      process.exit(2);
    }
    await sleep(200);
  }
  console.error('agent never started');
  process.exit(2);
}

async function observe(runId: string): Promise<void> {
  for (let i = 0; i < 600; i += 1) {
    const evs = await events(runId);
    if (evs.some((e) => e.step === 'final_answer')) {
      const seqs = evs.map((e) => e.seq).sort((a, b) => a - b);
      const contiguous = seqs.every((n, idx) => n === idx);
      const agentEvents = evs.filter((e) => e.step === 'agent' || e.step === 'tool_call').length;

      console.log(`run completed · ${evs.length} events · ${agentEvents} from the agent`);
      console.log(`event stream contiguous (no gaps): ${contiguous}`);
      console.log(`final: ${evs.find((e) => e.step === 'final_answer')?.message ?? ''}`);
      console.log(contiguous ? '\nPASS — §16 Phase 4' : '\nFAIL — the stream has gaps');
      process.exit(contiguous ? 0 : 1);
    }
    await sleep(500);
  }
  console.log('FAIL — the run never completed after the worker restarted');
  process.exit(1);
}

const [mode, arg] = process.argv.slice(2);
if (mode === 'start') void start();
else if (mode === 'observe' && arg) void observe(arg);
else {
  console.error('usage: durability-check.ts start | observe <runId>');
  process.exit(2);
}
