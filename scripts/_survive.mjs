const r = await fetch('http://localhost:3001/api/search', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ query: '撥雲尋古道' }),
});
const { run_id: id } = await r.json();
for (let i = 0; i < 100; i++) {
  const s = await (await fetch(`http://localhost:3001/api/runs/${id}`)).json();
  if (s.events.some((e) => e.step === 'final_answer')) {
    console.log(`runId ${id}`);
    console.log(`before restart: ${s.events.length} events, flags=[${s.state.flags.join(' ')}]`);
    break;
  }
  await new Promise((x) => setTimeout(x, 300));
}
console.log(id);
