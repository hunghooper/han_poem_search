'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { decode } from '@han/shared/serde';
import { NOTABLE_FLAGS, STEP_LABEL, styleFor } from '@/components/step-config';
import {
  DEFAULT_SETTINGS,
  authHeaders,
  loadApiKey,
  loadSettings,
  saveApiKey,
  saveSettings,
  SettingsPanel,
  type ServerConfig,
  type Settings,
} from '@/components/settings';
import { t } from '@/components/i18n';
import { BatchPanel } from '@/components/batch';

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
  metadata: { latencyMs?: number; resultCount?: number; confidence?: number; provider?: string; model?: string };
}

interface Result {
  id: string;
  /** Which retriever produced it — exact, bm25, vector or model. */
  source: string;
  title: string | null;
  author: string | null;
  edition: string | null;
  content: string;
  provenance: { dataset: string; file: string; commitSha: string } | null;
  metadata: { matchedLines?: string[] };
}

interface Check {
  name: string;
  outcome: 'pass' | 'fail' | 'abstain';
  detail: string;
}

interface Outcome {
  results: Result[];
  colophon: { lines: string[]; cyclicalDate: string | null } | null;
  verification: { outcome: string; summary: string; checks: Check[] } | null;
}

const SAMPLE = '自下寒煙 卧松高 白鶴眠 語来江色暮 獨 尋古道 倚石聽流泉 花暖青牛 羣峭碧摩天 逍遥不記年 撥雲';

export default function Home() {
  const [query, setQuery] = useState(SAMPLE);
  const [events, setEvents] = useState<Ev[]>([]);
  const [results, setResults] = useState<Result[]>([]);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [running, setRunning] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [server, setServer] = useState<ServerConfig | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  // Deliberately NOT part of `settings`: that blob is persisted and is the thing a user
  // exports to share their configuration. A key does not belong in it.
  const [apiKey, setApiKey] = useState('');
  const lang = settings.ui.language;
  const vertical = settings.ui.vertical;

  // Settings load after mount, not during render: localStorage does not exist on the server,
  // and reading it in render would make the first paint differ from the markup Next sent.
  useEffect(() => setSettings(loadSettings()), []);
  useEffect(() => setApiKey(loadApiKey()), []);
  useEffect(() => {
    void fetch(`${API}/api/config`)
      .then((r) => r.json())
      .then((j) => setServer(decode<ServerConfig>(j)))
      .catch(() => setServer(null));
  }, []);

  const updateSettings = useCallback((next: Settings) => {
    setSettings(next);
    saveSettings(next);
  }, []);
  const lastSeq = useRef(-1);

  const search = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!query.trim() || running) return;
      setRunning(true);
      setEvents([]);
      setResults([]);
      setOutcome(null);
      lastSeq.current = -1;

      const res = await fetch(`${API}/api/search`, {
        method: 'POST',
        // The key goes in a header, never the body: a body is what validation errors and
        // request logs quote back.
        headers: { 'content-type': 'application/json', ...authHeaders(apiKey) },
        // Session overrides travel with the request; the server never persists them.
        body: JSON.stringify({
          query,
          ...(Object.keys(settings.overrides).length > 0 ? { overrides: settings.overrides } : {}),
        }),
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
            .then((j) => {
              const o = decode<Outcome>(j);
              setOutcome(o);
              setResults(o.results ?? []);
            })
            .finally(() => setRunning(false));
          ws.close();
        }
      };
      ws.onerror = () => setRunning(false);

      // The evidence itself comes back on the run endpoint once the run settles.
    },
    [query, running, settings.overrides],
  );

  const terminal = events.find((e) => e.step === 'final_answer');
  const flags = terminal?.flags ?? [];
  const found = flags.includes('local_result_found');
  /**
   * §7.1: when a fragment resolves to several works the system emits exact_ambiguous and
   * "passes all candidates forward — do not guess". Showing only the first would put the
   * guess back in at the presentation layer, which is §1's silent success wearing a different
   * hat: the data said "these all match" and the page said "this one".
   */
  const ambiguous = flags.includes('exact_ambiguous');
  const tied = ambiguous ? results.filter((r) => r.source === 'exact').slice(0, 5) : [];

  return (
    <main>
      <div className="topbar">
        <h1>漢詩檢索</h1>
        <button type="button" className="ghost" onClick={() => setBatchOpen(true)}>
          {t(lang, 'batch.open')}
        </button>
        <button type="button" className="ghost" onClick={() => setSettingsOpen(true)}>
          {t(lang, 'settings.title')}
        </button>
      </div>
      <p className="sub">{t(lang, 'app.tagline', { n: '78,455' })}</p>

      {batchOpen && <BatchPanel lang={lang} apiKey={apiKey} onClose={() => setBatchOpen(false)} />}

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        server={server}
        onChange={updateSettings}
        apiKey={apiKey}
        onApiKeyChange={(k) => {
          setApiKey(k);
          saveApiKey(k);
        }}
      />

      <form onSubmit={search}>
        <textarea
          value={query}
          onChange={(ev) => setQuery(ev.target.value)}
          placeholder={t(lang, 'search.placeholder')}
          spellCheck={false}
        />
        <button type="submit" disabled={running}>
          {running ? t(lang, 'search.running') : t(lang, 'search.button')}
        </button>
      </form>

      {events.length > 0 && (
        <div className="trace">
          {events
            .filter((ev) => !(settings.ui.hideSkipped && (ev.status === 'skipped' || ev.status === 'not_executed')))
            .map((ev) => {
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
                  {settings.ui.debug && ev.metadata.confidence != null
                    ? ` · conf ${ev.metadata.confidence.toFixed(2)}`
                    : ''}
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

      {terminal && found && ambiguous && tied.length > 1 && (
        <div className="answer">
          <p className="ambiguous">{t(lang, 'answer.ambiguous', { n: tied.length })}</p>
          <ul className="tied">
            {tied.map((r) => (
              <li key={r.id}>
                <h3>{r.title ?? '(untitled)'}</h3>
                <span className="byline">
                  {r.author ?? '(unknown)'} · {r.edition}
                </span>
                <div className="poem">{r.content}</div>
              </li>
            ))}
          </ul>
          {tied[0]?.provenance && (
            <p className="prov">{t(lang, 'answer.notAuthoritative')}</p>
          )}
        </div>
      )}

      {terminal && found && !(ambiguous && tied.length > 1) && results[0] && (
        <div className="answer">
          <h2>{results[0].title ?? '(untitled)'}</h2>
          <p className="byline">
            {results[0].author ?? '(unknown)'} · {results[0].edition}
          </p>
          <button
            className="toggle"
            onClick={() => updateSettings({ ...settings, ui: { ...settings.ui, vertical: !vertical } })}
          >
            {vertical ? t(lang, 'answer.horizontal') : t(lang, 'answer.vertical')}
          </button>
          <div className={`poem${vertical ? ' vertical' : ''}`}>
            {highlight(results[0].content, results[0].metadata.matchedLines ?? [])}
          </div>
          {/*
            Attribution set after the poem, the way a printed edition closes a piece. The
            heading above names it for scanning; this reads as part of the text.
          */}
          <p className="attrib">
            —— {results[0].author ?? '佚名'}《{results[0].title ?? '無題'}》
          </p>

          {outcome?.verification && outcome.verification.outcome !== 'abstain' && (
            <div className={`verify v-${outcome.verification.outcome}`}>
              <strong>{outcome.verification.outcome === 'pass' ? '✓' : '⚠'} {outcome.verification.summary}</strong>
              <ul>
                {outcome.verification.checks.map((c) => (
                  <li key={c.name}>
                    <span className={`vmark v-${c.outcome}`}>
                      {c.outcome === 'pass' ? '✓' : c.outcome === 'fail' ? '✗' : '○'}
                    </span>{' '}
                    {c.detail}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {outcome?.colophon && (
            <p className="colophon">
              Inscription set aside before searching: {outcome.colophon.lines.join(' · ')}
              {outcome.colophon.cyclicalDate ? ` — 干支 date ${outcome.colophon.cyclicalDate}` : ''}
            </p>
          )}

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
          <strong>{t(lang, 'empty.title')}</strong>
          {terminal.message}
          <br />
          {/* Read off THIS run's own steps, not asserted. The sentence here used to say that
              semantic search and the agent "are not built yet" — true when it was written,
              false for months afterwards, and the screen went on telling users the system had
              not looked when it had. A claim about what the system can do belongs nowhere near
              a hardcoded string; what it actually did is in the events. */}
          {t(lang, whatLookedKey(events))}
        </div>
      )}
    </main>
  );
}

/**
 * Which layers actually looked, for the empty-result message.
 *
 * The three answers are genuinely different and the user acts on them differently: the corpus
 * alone looked and the model was never asked; the model was asked and could not run; or
 * everything available looked and found nothing.
 */
function whatLookedKey(events: Ev[]): string {
  const agent = [...events].reverse().find((e) => e.step === 'agent');
  if (!agent) return 'empty.localOnly';
  if (agent.status === 'unavailable' || agent.status === 'skipped') return 'empty.agentIdle';
  return 'empty.everythingLooked';
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
