'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { decode } from '@han/shared/serde';
import { NOTABLE_FLAGS, styleFor } from '@/components/step-config';
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
import type { TraceMsg } from '@han/shared/trace';
import { t, tTrace } from '@/components/i18n';
import { BatchPanel } from '@/components/batch';
import { CorpusPanel } from '@/components/corpus';
import { AdditionsPanel } from '@/components/additions';
import { Tabs, type TabId } from '@/components/tabs';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

const WS = process.env.NEXT_PUBLIC_WS_URL ?? API.replace(/^http/, 'ws');

interface Ev {
  seq: number;
  step: string;
  source: string;
  phase: string;
  status?: string;
  messageTrace?: TraceMsg;
  flags: string[];
  message?: string;
  metadata: {
    latencyMs?: number;
    resultCount?: number;
    confidence?: number;
    provider?: string;
    model?: string;
  };
}

interface Result {
  id: string;
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
  trace?: TraceMsg;
}

interface Outcome {
  results: Result[];
  colophon: { lines: string[]; cyclicalDate: string | null } | null;
  verification: {
    outcome: string;
    summary: string;
    summaryTrace?: TraceMsg;
    checks: Check[];
  } | null;
}

const SAMPLE =
  '自下寒煙 卧松高 白鶴眠 語来江色暮 獨 尋古道 倚石聽流泉 花暖青牛 羣峭碧摩天 逍遥不記年 撥雲';

export default function Home() {
  const [query, setQuery] = useState(SAMPLE);
  const [events, setEvents] = useState<Ev[]>([]);
  const [results, setResults] = useState<Result[]>([]);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [running, setRunning] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [server, setServer] = useState<ServerConfig | null>(null);
  const [corpusSize, setCorpusSize] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tab, setTab] = useState<TabId>('search');
  const [apiKey, setApiKey] = useState('');
  const lang = settings.ui.language;
  const vertical = settings.ui.vertical;

  useEffect(() => setSettings(loadSettings()), []);
  useEffect(() => setApiKey(loadApiKey()), []);
  useEffect(() => {
    void fetch(`${API}/api/config`)
      .then((r) => r.json())
      .then((j) => setServer(decode<ServerConfig>(j)))
      .catch(() => setServer(null));
  }, []);

  useEffect(() => {
    void fetch(`${API}/api/corpus/stats`)
      .then((r) => r.json())
      .then((j) => setCorpusSize(decode<{ total: number | null }>(j).total))
      .catch(() => setCorpusSize(null));
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
        headers: { 'content-type': 'application/json', ...authHeaders(apiKey) },
        body: JSON.stringify({
          query,
          ...(Object.keys(settings.overrides).length > 0 ? { overrides: settings.overrides } : {}),
        }),
      });
      const { runId } = decode<{ runId: string }>(await res.json());

      const ws = new WebSocket(`${WS}/api/runs/${runId}/stream`);
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
    },
    [query, running, settings.overrides],
  );

  const terminal = events.find((e) => e.step === 'final_answer');
  const flags = terminal?.flags ?? [];
  const found = flags.includes('local_result_found');
  const ambiguous = flags.includes('exact_ambiguous');
  const tied = ambiguous ? results.filter((r) => r.source === 'exact').slice(0, 5) : [];

  return (
    <main>
      <div className="topbar">
        <h1>漢詩檢索</h1>
        <button type="button" className="ghost" onClick={() => setSettingsOpen(true)}>
          {t(lang, 'settings.title')}
        </button>
      </div>
      {corpusSize !== null && (
        <p className="sub">{t(lang, 'app.tagline', { n: corpusSize.toLocaleString('en-US') })}</p>
      )}

      <Tabs lang={lang} active={tab} onChange={setTab} />

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

      <div id="panel-search" role="tabpanel" aria-labelledby="tab-search" hidden={tab !== 'search'}>
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
              .filter(
                (ev) =>
                  !(
                    settings.ui.hideSkipped &&
                    (ev.status === 'skipped' || ev.status === 'not_executed')
                  ),
              )
              .map((ev) => {
                const s = styleFor(ev.phase === 'started' ? undefined : ev.status);
                return (
                  <div className="step" key={ev.seq}>
                    <span className={`icon ${s.className}`}>{s.icon}</span>
                    <span>
                      {t(lang, `step.${ev.step}`)}
                      {(() => {
                        const line = tTrace(lang, ev.messageTrace, ev.message ?? null);
                        return line ? (
                          <span style={{ color: 'var(--muted)' }}> — {line}</span>
                        ) : null;
                      })()}
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
            {tied[0]?.provenance && <p className="prov">{t(lang, 'answer.notAuthoritative')}</p>}
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
              onClick={() =>
                updateSettings({ ...settings, ui: { ...settings.ui, vertical: !vertical } })
              }
            >
              {vertical ? t(lang, 'answer.horizontal') : t(lang, 'answer.vertical')}
            </button>
            <div className={`poem${vertical ? ' vertical' : ''}`}>
              {highlight(results[0].content, results[0].metadata.matchedLines ?? [])}
            </div>
            <p className="attrib">
              —— {results[0].author ?? '佚名'}《{results[0].title ?? '無題'}》
            </p>

            {outcome?.verification && outcome.verification.outcome !== 'abstain' && (
              <div className={`verify v-${outcome.verification.outcome}`}>
                <strong>
                  {outcome.verification.outcome === 'pass' ? '✓' : '⚠'}{' '}
                  {tTrace(lang, outcome.verification.summaryTrace, outcome.verification.summary)}
                </strong>
                <ul>
                  {outcome.verification.checks.map((c) => (
                    <li key={c.name}>
                      <span className={`vmark v-${c.outcome}`}>
                        {c.outcome === 'pass' ? '✓' : c.outcome === 'fail' ? '✗' : '○'}
                      </span>{' '}
                      {tTrace(lang, c.trace, c.detail)}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {outcome?.colophon && (
              <p className="colophon">
                {t(lang, 'answer.colophon', { lines: outcome.colophon.lines.join(' · ') })}
                {outcome.colophon.cyclicalDate
                  ? t(lang, 'answer.colophonDate', { date: outcome.colophon.cyclicalDate })
                  : ''}
              </p>
            )}

            {results[0].provenance && (
              <p className="prov">
                {t(lang, 'answer.notAuthoritative')} {t(lang, 'answer.source')}{' '}
                <code>{results[0].provenance.file}</code> @{' '}
                <code>{results[0].provenance.commitSha.slice(0, 8)}</code>
              </p>
            )}
          </div>
        )}

        {terminal && !found && (
          <div className="empty">
            <strong>{t(lang, 'empty.title')}</strong>
            {tTrace(lang, terminal.messageTrace, terminal.message ?? null)}
            <br />
            {t(lang, whatLookedKey(events))}
          </div>
        )}
      </div>

      <div id="panel-batch" role="tabpanel" aria-labelledby="tab-batch" hidden={tab !== 'batch'}>
        {tab === 'batch' && <BatchPanel lang={lang} apiKey={apiKey} />}
      </div>

      <div id="panel-corpus" role="tabpanel" aria-labelledby="tab-corpus" hidden={tab !== 'corpus'}>
        {tab === 'corpus' && <CorpusPanel lang={lang} corpusSize={corpusSize} />}
      </div>

      <div
        id="panel-additions"
        role="tabpanel"
        aria-labelledby="tab-additions"
        hidden={tab !== 'additions'}
      >
        {tab === 'additions' && <AdditionsPanel lang={lang} />}
      </div>
    </main>
  );
}

function whatLookedKey(events: Ev[]): string {
  const agent = [...events].reverse().find((e) => e.step === 'agent');
  if (!agent) return 'empty.localOnly';
  if (agent.status === 'unavailable' || agent.status === 'skipped') return 'empty.agentIdle';
  return 'empty.everythingLooked';
}

function highlight(content: string, matched: string[]) {
  if (matched.length === 0) return content;
  const parts: Array<string | { m: string }> = [];
  let rest = content;
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
