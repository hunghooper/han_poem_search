'use client';

import { useCallback, useRef, useState } from 'react';
import { decode } from '@han/shared/serde';
import { NOTABLE_FLAGS, STEP_LABEL, styleFor } from '@/components/step-config';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const WS = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001';

interface Ev {
  seq: number;
  step: string;
  source: string;
  phase: string;
  status?: string;
  flags: string[];
  message?: string;
  metadata: { latencyMs?: number; resultCount?: number; confidence?: number };
}

interface Result {
  title: string | null;
  author: string | null;
  edition: string | null;
  content: string;
  provenance: { dataset: string; file: string; commitSha: string } | null;
  metadata: { matchedLines?: string[] };
}

const SAMPLE = '自下寒煙 卧松高 白鶴眠 語来江色暮 獨 尋古道 倚石聽流泉 花暖青牛 羣峭碧摩天 逍遥不記年 撥雲';

export default function Home() {
  const [query, setQuery] = useState(SAMPLE);
  const [events, setEvents] = useState<Ev[]>([]);
  const [results, setResults] = useState<Result[]>([]);
  const [running, setRunning] = useState(false);
  const [vertical, setVertical] = useState(false);
  const lastSeq = useRef(-1);

  const search = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!query.trim() || running) return;
      setRunning(true);
      setEvents([]);
      setResults([]);
      lastSeq.current = -1;

      const res = await fetch(`${API}/api/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const { runId } = decode<{ runId: string }>(await res.json());

      const ws = new WebSocket(`${WS}/api/runs/${runId}/stream`);
      // The server replays everything after lastSeq, so a reconnect resumes rather than
      // restarting. Events are ordered by seq, never by arrival.
      ws.onopen = () => ws.send(JSON.stringify({ lastSeq: lastSeq.current }));
      ws.onmessage = (m) => {
        const ev = decode<Ev>(JSON.parse(m.data as string));
        if (ev.seq <= lastSeq.current) return; // idempotent: an overlapping replay is harmless
        lastSeq.current = ev.seq;
        setEvents((prev) => [...prev, ev].sort((a, b) => a.seq - b.seq));
        if (ev.step === 'final_answer') {
          void fetch(`${API}/api/runs/${runId}/results`)
            .then((r) => r.json())
            .then((j) => setResults(decode<{ results: Result[] }>(j).results))
            .finally(() => setRunning(false));
          ws.close();
        }
      };
      ws.onerror = () => setRunning(false);

      // The evidence itself comes back on the run endpoint once the run settles.
    },
    [query, running],
  );

  const terminal = events.find((e) => e.step === 'final_answer');
  const flags = terminal?.flags ?? [];
  const found = flags.includes('local_result_found');

  return (
    <main>
      <h1>漢詩檢索</h1>
      <p className="sub">
        Fragment lookup over 全唐詩 + 宋詞 · 78,455 poems · exact match only (Phase 1)
      </p>

      <form onSubmit={search}>
        <textarea
          value={query}
          onChange={(ev) => setQuery(ev.target.value)}
          placeholder="Paste a fragment — reordered, damaged, or in either script"
          spellCheck={false}
        />
        <button type="submit" disabled={running}>
          {running ? 'Searching…' : 'Search'}
        </button>
      </form>

      {events.length > 0 && (
        <div className="trace">
          {events.map((ev) => {
            const s = styleFor(ev.phase === 'started' ? undefined : ev.status);
            return (
              <div className="step" key={ev.seq}>
                <span className={`icon ${s.className}`}>{s.icon}</span>
                <span>
                  {STEP_LABEL[ev.step] ?? ev.step}
                  {ev.message ? <span style={{ color: 'var(--muted)' }}> — {ev.message}</span> : null}
                </span>
                <span className="lat">
                  {ev.metadata.latencyMs != null ? `${ev.metadata.latencyMs}ms` : ''}
                </span>
              </div>
            );
          })}
          {flags.length > 0 && (
            <div className="flags">
              {flags.map((f) => (
                <span className={`flag${NOTABLE_FLAGS.has(f) ? ' hot' : ''}`} key={f}>
                  {f}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {terminal && found && results[0] && (
        <div className="answer">
          <h2>{results[0].title ?? '(untitled)'}</h2>
          <p className="byline">
            {results[0].author ?? '(unknown)'} · {results[0].edition}
          </p>
          <button className="toggle" onClick={() => setVertical((v) => !v)}>
            {vertical ? 'Horizontal' : 'Vertical 直書'}
          </button>
          <div className={`poem${vertical ? ' vertical' : ''}`}>
            {highlight(results[0].content, results[0].metadata.matchedLines ?? [])}
          </div>
          {results[0].provenance && (
            <p className="prov">
              What this dataset says — not an authoritative edition. Source:{' '}
              <code>{results[0].provenance.file}</code> at{' '}
              <code>{results[0].provenance.commitSha.slice(0, 8)}</code>
            </p>
          )}
        </div>
      )}

      {terminal && !found && (
        <div className="empty">
          <strong>No confident answer from the local corpus.</strong>
          {terminal.message}
          <br />
          Semantic search (Phase 2) and the agent fallback (Phase 3) are not built yet, so this
          means &ldquo;exact matching found nothing&rdquo;, not &ldquo;the poem does not exist&rdquo;.
        </div>
      )}
    </main>
  );
}

/** Highlight the lines that actually matched, so the user sees which characters hit (§14.2). */
function highlight(content: string, matched: string[]) {
  if (matched.length === 0) return content;
  const parts: Array<string | { m: string }> = [];
  let rest = content;
  // Longest first, so a short line does not shadow a longer one containing it.
  for (const m of [...matched].sort((a, b) => b.length - a.length)) {
    const next: Array<string | { m: string }> = [];
    for (const part of parts.length ? parts : [rest]) {
      if (typeof part !== 'string') {
        next.push(part);
        continue;
      }
      const chunks = part.split(m);
      chunks.forEach((c, i) => {
        if (i > 0) next.push({ m });
        if (c) next.push(c);
      });
    }
    parts.length = 0;
    parts.push(...next);
    rest = '';
  }
  return parts.map((p, i) =>
    typeof p === 'string' ? (
      <span key={i}>{p}</span>
    ) : (
      <span className="matched" key={i}>
        {p.m}
      </span>
    ),
  );
}
