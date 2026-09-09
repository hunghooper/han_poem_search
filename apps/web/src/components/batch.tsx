'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { UiLanguage } from '@han/shared/runtime-config';
import { authHeaders } from './settings';
import { t } from './i18n';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface ColumnProfile {
  name: string;
  cjkRatio: number;
  filled: number;
  samples: string[];
}

interface Scan {
  jobId: string;
  kind: string;
  filename: string;
  totalRows: number;
  headers: string[];
  columns: ColumnProfile[];
  suggested: string | null;
  abstainReason: 'no_cjk' | 'ambiguous' | null;
}

interface Estimate {
  rows: number;
  pendingRows?: number;
  agentAvailable?: boolean;
  agentRequestedButUnavailable?: boolean;
  agentRows: number;
  seconds: number;
}

interface Progress {
  status: string;
  rowsDone: number;
  totalRows: number;
  pass: { done: number; total: number } | null;
  byStatus: Record<string, number>;
  error: string | null;
  running: boolean;
}

interface JobSummary {
  jobId: string;
  filename: string;
  kind: string;
  status: string;
  totalRows: number;
  queryColumn: string | null;
  createdAt: string;
  byStatus: Record<string, number>;
  running: boolean;
  bytes: number;
}

interface ExportColumn {
  key: string;
  header: string;
  group: string;
  byDefault: boolean;
  locked: boolean;
  wide: boolean;
}

const GROUP_LABEL: Record<string, string> = {
  verdict: 'batch.groupVerdict',
  identity: 'batch.groupIdentity',
  text: 'batch.groupText',
  verification: 'batch.groupVerification',
  provenance: 'batch.groupProvenance',
  audit: 'batch.groupAudit',
  raw: 'batch.groupRaw',
};

const STATUS_COLOR: Record<string, string> = {
  has_result: '#1a7f37',
  low_confidence: '#9a6700',
  no_result: '#57606a',
  skipped: '#57606a',
  not_executed: '#8250df',
  error: '#cf222e',
  timeout: '#cf222e',
  unavailable: '#cf222e',
};

export function BatchPanel({ lang, apiKey }: { lang: UiLanguage; apiKey: string }) {
  const [scan, setScan] = useState<Scan | null>(null);
  const [column, setColumn] = useState<string>('');
  const [agentEnabled, setAgentEnabled] = useState(false);
  const [capUsd, setCapUsd] = useState<string>('');
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [available, setAvailable] = useState<ExportColumn[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rerun, setRerun] = useState<'unresolved' | 'all'>('unresolved');
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [lastRun, setLastRun] = useState<{ rows: number; at: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const finished = Boolean(progress && !progress.running && progress.rowsDone > 0);
  const settled = (progress?.byStatus.has_result ?? 0) + (progress?.byStatus.skipped ?? 0);
  const unresolved = (progress?.rowsDone ?? 0) - settled;

  useEffect(() => {
    void fetch(`${API}/api/batch/columns`)
      .then((r) => r.json() as Promise<{ columns: ExportColumn[] }>)
      .then((d) => {
        setAvailable(d.columns);
        setSelected(new Set(d.columns.filter((c) => c.byDefault).map((c) => c.key)));
      })
      .catch(() => setError('cannot reach the API'));
  }, []);

  const loadJobs = useCallback(async () => {
    const res = await fetch(`${API}/api/batch`);
    if (res.ok) setJobs(((await res.json()) as { jobs: JobSummary[] }).jobs);
  }, []);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  const reopen = useCallback(async (jobId: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/batch/${jobId}/scan`);
      if (!res.ok) {
        setError(((await res.json()) as { error?: string }).error ?? 'cannot reopen');
        return;
      }
      const data = (await res.json()) as Scan & {
        agentEnabled: boolean;
        agentCapUsd: number | null;
      };
      setScan(data);
      setColumn(data.suggested ?? '');
      setAgentEnabled(data.agentEnabled);
      setCapUsd(data.agentCapUsd === null ? '' : String(data.agentCapUsd));
    } finally {
      setBusy(false);
    }
  }, []);

  const remove = useCallback(
    async (jobId: string) => {
      const res = await fetch(`${API}/api/batch/${jobId}`, { method: 'DELETE' });
      if (!res.ok) {
        setError(((await res.json()) as { error?: string }).error ?? 'cannot delete');
        return;
      }
      await loadJobs();
    },
    [loadJobs],
  );

  const upload = useCallback(
    async (file: File) => {
      setBusy(true);
      setError(null);
      setProgress(null);
      try {
        const body = new FormData();
        body.append('file', file);
        const res = await fetch(`${API}/api/batch/upload`, { method: 'POST', body });
        const data = (await res.json()) as Scan & { error?: string };
        if (!res.ok) {
          setError(data.error ?? 'upload failed');
          return;
        }
        setScan(data);
        setColumn(data.suggested ?? '');
        void loadJobs();
      } finally {
        setBusy(false);
      }
    },
    [loadJobs],
  );

  useEffect(() => {
    if (!scan) return;
    const cap = capUsd.trim() === '' ? null : Number(capUsd);
    void fetch(`${API}/api/batch/${scan.jobId}/estimate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify({
        agent: { enabled: agentEnabled, capUsd: cap },
        rerun: finished ? rerun : undefined,
      }),
    })
      .then((r) => r.json() as Promise<Estimate>)
      .then(setEstimate)
      .catch(() => undefined);
  }, [scan, agentEnabled, capUsd, finished, rerun, apiKey]);

  useEffect(() => {
    if (!scan) return undefined;
    let alive = true;
    const tick = async () => {
      const res = await fetch(`${API}/api/batch/${scan.jobId}`);
      if (!alive) return;
      if (res.status === 404) {
        setScan(null);
        setProgress(null);
        setError(t(lang, 'batch.jobGone'));
        void loadJobs();
        return;
      }
      if (!res.ok) return;
      setProgress((await res.json()) as Progress);
    };
    void tick();
    const timer = setInterval(() => void tick(), 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [scan, lang, loadJobs]);

  const start = async (agentOverride?: boolean) => {
    if (!scan || !column) return;
    const useAgent = agentOverride ?? agentEnabled;
    setBusy(true);
    setError(null);
    try {
      const cap = capUsd.trim() === '' ? null : Number(capUsd);
      const res = await fetch(`${API}/api/batch/${scan.jobId}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(apiKey) },
        body: JSON.stringify({
          column,
          agent: { enabled: useAgent, capUsd: cap },
          rerun: finished ? rerun : undefined,
        }),
      });
      const body = (await res.json()) as { error?: string; pendingRows?: number };
      if (!res.ok) {
        setError(body.error ?? 'start failed');
        return;
      }
      setLastRun({
        rows: body.pendingRows ?? 0,
        at: new Date().toLocaleTimeString(),
      });
    } finally {
      setBusy(false);
    }
  };

  const exportUrl = (format: 'jsonl' | 'xlsx'): string => {
    const cols = [...selected].join(',');
    return `${API}/api/batch/${scan?.jobId}/export?format=${format}&columns=${encodeURIComponent(cols)}`;
  };

  const canStart = Boolean(scan && column) && !busy && !progress?.running;

  return (
    <div className="panel">
      <div>
        {scan && !progress?.running && (
          <header style={S.header}>
            <button
              onClick={() => {
                setScan(null);
                setProgress(null);
                void loadJobs();
              }}
              style={S.ghost}
            >
              {t(lang, 'batch.back')}
            </button>
          </header>
        )}

        {error && <p style={S.error}>{error}</p>}

        {!scan && (
          <section style={S.section}>
            <input
              ref={fileInput}
              type="file"
              accept=".jsonl,.xlsx"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
              }}
            />
            <button style={S.primary} disabled={busy} onClick={() => fileInput.current?.click()}>
              {busy ? t(lang, 'batch.detecting') : t(lang, 'batch.upload')}
            </button>
            <p style={S.hint}>{t(lang, 'batch.formats')}</p>

            {jobs.length > 0 && (
              <div style={S.history}>
                <h3 style={S.h3}>{t(lang, 'batch.history')}</h3>
                <p style={S.hint}>{t(lang, 'batch.historyNote')}</p>
                <table style={S.table}>
                  <tbody>
                    {jobs.map((j) => (
                      <tr key={j.jobId} style={S.tr}>
                        <td style={S.tdName}>
                          <button style={S.link} onClick={() => void reopen(j.jobId)}>
                            {j.filename}
                          </button>
                          <span style={S.muted}> {new Date(j.createdAt).toLocaleString()}</span>
                        </td>
                        <td style={S.td}>
                          <span style={{ color: j.running ? '#0969da' : '#57606a' }}>
                            {t(lang, `batch.${j.status}`)}
                          </span>
                        </td>
                        <td style={S.td}>
                          {Object.entries(j.byStatus).map(([st, n]) => (
                            <span
                              key={st}
                              style={{ ...S.chip, color: STATUS_COLOR[st] ?? '#57606a' }}
                            >
                              {st} {n}{' '}
                            </span>
                          ))}
                          {Object.keys(j.byStatus).length === 0 && (
                            <span style={S.muted}>{j.totalRows} —</span>
                          )}
                        </td>
                        <td style={S.tdRight}>
                          <span style={S.muted}>{kb(j.bytes)}</span>
                        </td>
                        <td style={S.tdRight}>
                          <button
                            style={S.linkDanger}
                            disabled={j.running}
                            onClick={() => void remove(j.jobId)}
                            title={t(lang, 'batch.delete')}
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {scan && (
          <>
            <section style={S.section}>
              <div style={S.fileRow}>
                <strong>{scan.filename}</strong>
                <span style={S.muted}>
                  {scan.kind} · {t(lang, 'batch.rows').replace('{n}', String(scan.totalRows))}
                </span>
              </div>

              <h3 style={S.h3}>{t(lang, 'batch.chooseColumn')}</h3>
              {scan.abstainReason && (
                <p style={S.warn}>
                  {t(
                    lang,
                    scan.abstainReason === 'no_cjk'
                      ? 'batch.abstainNoCjk'
                      : 'batch.abstainAmbiguous',
                  )}
                </p>
              )}
              <div style={S.columnList}>
                {scan.columns.map((c) => (
                  <label
                    key={c.name}
                    style={{ ...S.column, ...(column === c.name ? S.columnOn : {}) }}
                  >
                    <input
                      type="radio"
                      name="column"
                      checked={column === c.name}
                      onChange={() => setColumn(c.name)}
                      disabled={progress?.running}
                    />
                    <span style={S.columnName}>{c.name}</span>
                    <span style={S.badgeCell}>
                      {scan.suggested === c.name && (
                        <span style={S.badge}>{t(lang, 'batch.suggested')}</span>
                      )}
                    </span>
                    <span style={S.muted}>
                      {Math.round(c.cjkRatio * 100)}% {t(lang, 'batch.cjkShare')}
                    </span>
                    <span style={S.sample}>{c.samples[0] ?? ''}</span>
                  </label>
                ))}
              </div>
            </section>

            <section style={S.section}>
              <h3 style={S.h3}>{t(lang, 'batch.agentSection')}</h3>
              <label style={S.check}>
                <input
                  type="checkbox"
                  checked={agentEnabled}
                  disabled={progress?.running}
                  onChange={(e) => setAgentEnabled(e.target.checked)}
                />
                {t(lang, 'batch.agentEnabled')}
              </label>
              {!agentEnabled && <p style={S.hint}>{t(lang, 'batch.agentOffNote')}</p>}
              {agentEnabled && (
                <div style={S.capRow}>
                  <label style={S.capLabel}>
                    {t(lang, 'batch.capLabel')}
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={capUsd}
                      disabled={progress?.running}
                      placeholder={t(lang, 'batch.capNone')}
                      onChange={(e) => setCapUsd(e.target.value)}
                      style={S.input}
                    />
                  </label>
                  <p style={S.hint}>{t(lang, 'batch.capNote')}</p>
                </div>
              )}
            </section>

            {estimate && (
              <section style={S.section}>
                <h3 style={S.h3}>{t(lang, 'batch.estimate')}</h3>
                <div style={S.estGrid}>
                  <span>{t(lang, 'batch.estTime')}</span>
                  <strong>{humanTime(estimate.seconds, lang)}</strong>
                  <span>{t(lang, 'batch.estAgentRows')}</span>
                  <strong>{estimate.agentRows.toLocaleString()}</strong>
                </div>
                <p style={S.hint}>{t(lang, 'batch.estimateNote')}</p>

                {estimate.agentRequestedButUnavailable && (
                  <div style={S.warn}>
                    <p style={{ margin: '0 0 .6rem' }}>{t(lang, 'batch.agentUnavailable')}</p>
                    <button
                      style={S.warnAction}
                      onClick={() => {
                        setAgentEnabled(false);
                        void start(false);
                      }}
                    >
                      {t(lang, 'batch.runWithoutAgent')}
                    </button>
                  </div>
                )}
              </section>
            )}

            <section style={S.section}>
              {progress?.running ? (
                <button
                  style={S.danger}
                  onClick={() =>
                    void fetch(`${API}/api/batch/${scan.jobId}/cancel`, { method: 'POST' })
                  }
                >
                  {t(lang, 'batch.cancel')}
                </button>
              ) : (
                <>
                  {finished && (
                    <div style={S.rerunRow}>
                      <label style={S.check}>
                        <input
                          type="radio"
                          name="rerun"
                          checked={rerun === 'unresolved'}
                          onChange={() => setRerun('unresolved')}
                        />
                        {t(lang, 'batch.rerunUnresolved').replace('{n}', String(unresolved))}
                      </label>
                      <label style={S.check}>
                        <input
                          type="radio"
                          name="rerun"
                          checked={rerun === 'all'}
                          onChange={() => setRerun('all')}
                        />
                        {t(lang, 'batch.rerunAll').replace('{n}', String(progress?.totalRows ?? 0))}
                      </label>
                      <p style={S.hint}>{t(lang, 'batch.rerunNote')}</p>
                    </div>
                  )}
                  <button
                    style={S.primary}
                    disabled={!canStart || (finished && rerun === 'unresolved' && unresolved === 0)}
                    onClick={() => void start()}
                  >
                    {finished ? t(lang, 'batch.rerunStart') : t(lang, 'batch.start')}
                  </button>
                </>
              )}

              {progress && progress.status !== 'scanned' && (
                <div style={S.progressBox}>
                  <div style={S.progressRow}>
                    <strong>{t(lang, `batch.${progress.status}`)}</strong>
                    <span>
                      {t(lang, progress.pass ? 'batch.passProgress' : 'batch.progress')
                        .replace('{done}', String(progress.pass?.done ?? progress.rowsDone))
                        .replace('{total}', String(progress.pass?.total ?? progress.totalRows))}
                    </span>
                  </div>
                  <div style={S.bar}>
                    <div
                      style={{
                        ...S.barFill,
                        width: `${pct(
                          progress.pass?.done ?? progress.rowsDone,
                          progress.pass?.total ?? progress.totalRows,
                        )}%`,
                      }}
                    />
                  </div>
                  <div style={S.statusRow}>
                    {Object.entries(progress.byStatus).map(([status, n]) => (
                      <span
                        key={status}
                        style={{ ...S.chip, color: STATUS_COLOR[status] ?? '#57606a' }}
                      >
                        {status} {n}
                      </span>
                    ))}
                  </div>
                  {lastRun && (
                    <p style={S.lastRun}>
                      {t(lang, 'batch.lastRun')
                        .replace('{n}', String(lastRun.rows))
                        .replace('{at}', lastRun.at)}
                    </p>
                  )}
                  {progress.error && <p style={S.error}>{progress.error}</p>}
                </div>
              )}
            </section>

            {progress && progress.rowsDone > 0 && (
              <section style={S.section}>
                <h3 style={S.h3}>{t(lang, 'batch.export')}</h3>
                <p style={S.hint}>{t(lang, 'batch.exportPartial')}</p>

                <details style={S.details}>
                  <summary style={S.summary}>{t(lang, 'batch.pickColumns')}</summary>
                  <p style={S.hint}>{t(lang, 'batch.lockedNote')}</p>
                  {Object.keys(GROUP_LABEL).map((group) => {
                    const cols = available.filter((c) => c.group === group);
                    if (cols.length === 0) return null;
                    return (
                      <div key={group} style={S.group}>
                        <h4 style={S.h4}>{t(lang, GROUP_LABEL[group]!)}</h4>
                        {cols.map((c) => (
                          <label key={c.key} style={S.check}>
                            <input
                              type="checkbox"
                              checked={c.locked || selected.has(c.key)}
                              disabled={c.locked}
                              onChange={(e) => {
                                const next = new Set(selected);
                                if (e.target.checked) next.add(c.key);
                                else next.delete(c.key);
                                setSelected(next);
                              }}
                            />
                            <code style={S.code}>{c.header}</code>
                          </label>
                        ))}
                      </div>
                    );
                  })}
                </details>

                <div style={S.exportRow}>
                  <a href={exportUrl('jsonl')} style={S.primary}>
                    {t(lang, 'batch.exportJsonl')}
                  </a>
                  <a href={exportUrl('xlsx')} style={S.primary}>
                    {t(lang, 'batch.exportXlsx')}
                  </a>
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const kb = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`;

const pct = (done: number, total: number): number =>
  total === 0 ? 0 : Math.min(100, Math.round((done / total) * 100));

function humanTime(seconds: number, lang: UiLanguage): string {
  if (seconds < 90) return `${Math.round(seconds)} ${t(lang, 'batch.unitSecond')}`;
  if (seconds < 5400) return `${(seconds / 60).toFixed(1)} ${t(lang, 'batch.unitMinute')}`;
  if (seconds < 172800) return `${(seconds / 3600).toFixed(1)} ${t(lang, 'batch.unitHour')}`;
  return `${(seconds / 86400).toFixed(1)} ${t(lang, 'batch.unitDay')}`;
}

const S: Record<string, React.CSSProperties> = {
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  h2: { margin: 0, fontSize: '1.15rem' },
  h3: { margin: '0 0 .5rem', fontSize: '.95rem' },
  h4: { margin: '.6rem 0 .25rem', fontSize: '.8rem', color: '#57606a', fontWeight: 600 },
  section: { borderTop: '1px solid #eee', padding: '1rem 0', border: '1px solid transparent' },
  fileRow: { display: 'flex', gap: '.75rem', alignItems: 'baseline', marginBottom: '.75rem' },
  columnList: { display: 'flex', flexDirection: 'column', gap: 2 },
  column: {
    display: 'grid',
    gridTemplateColumns: '1.2rem 9rem 4.5rem 6rem 1fr',
    gap: '.5rem',
    alignItems: 'center',
    padding: '.35rem .5rem',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: '.85rem',
  },
  columnOn: { background: '#eef4ff' },
  columnName: {
    fontWeight: 600,
    fontFamily: 'ui-monospace, monospace',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  badgeCell: { justifySelf: 'start' },
  sample: {
    color: '#57606a',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
  },
  badge: {
    fontSize: '.7rem',
    background: '#1a7f37',
    color: '#fff',
    borderRadius: 10,
    padding: '.05rem .45rem',
  },
  muted: { color: '#57606a', fontSize: '.8rem' },
  hint: { color: '#57606a', fontSize: '.78rem', margin: '.35rem 0 0', lineHeight: 1.5 },
  warn: {
    background: '#fffbf0',
    border: '1px solid #d4a72c',
    borderRadius: 4,
    padding: '.5rem .65rem',
    fontSize: '.8rem',
    margin: '0 0 .6rem',
  },
  error: {
    background: '#fff5f5',
    border: '1px solid #cf222e',
    borderRadius: 4,
    padding: '.5rem .65rem',
    fontSize: '.82rem',
    color: '#cf222e',
  },
  check: {
    display: 'flex',
    gap: '.4rem',
    alignItems: 'center',
    fontSize: '.85rem',
    padding: '.15rem 0',
  },
  capRow: { marginTop: '.5rem' },
  capLabel: { display: 'flex', flexDirection: 'column', gap: '.25rem', fontSize: '.82rem' },
  input: { padding: '.35rem .5rem', border: '1px solid #d0d7de', borderRadius: 4, maxWidth: 220 },
  estGrid: {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    gap: '.25rem 1rem',
    fontSize: '.88rem',
    maxWidth: 320,
  },
  primary: {
    background: '#0969da',
    color: '#fff',
    border: 'none',
    borderRadius: 5,
    padding: '.5rem 1rem',
    fontSize: '.88rem',
    cursor: 'pointer',
    textDecoration: 'none',
    display: 'inline-block',
  },
  danger: {
    background: '#cf222e',
    color: '#fff',
    border: 'none',
    borderRadius: 5,
    padding: '.5rem 1rem',
    fontSize: '.88rem',
    cursor: 'pointer',
  },
  ghost: {
    background: 'none',
    border: '1px solid #d0d7de',
    borderRadius: 5,
    padding: '.3rem .7rem',
    cursor: 'pointer',
    fontSize: '.82rem',
  },
  progressBox: { marginTop: '.9rem' },
  progressRow: { display: 'flex', gap: '1rem', alignItems: 'baseline', fontSize: '.85rem' },
  bar: { height: 6, background: '#eaeef2', borderRadius: 3, margin: '.4rem 0', overflow: 'hidden' },
  barFill: { height: '100%', background: '#0969da', transition: 'width .3s' },
  statusRow: { display: 'flex', gap: '.75rem', flexWrap: 'wrap', fontSize: '.78rem' },
  chip: { fontFamily: 'ui-monospace, monospace' },
  details: { margin: '.5rem 0 1rem' },
  summary: { cursor: 'pointer', fontSize: '.85rem' },
  group: { marginBottom: '.4rem' },
  code: { fontFamily: 'ui-monospace, monospace', fontSize: '.78rem' },
  exportRow: { display: 'flex', gap: '.6rem' },
  rerunRow: { margin: '0 0 .75rem' },
  warnAction: {
    background: '#8a6516',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    padding: '.35rem .8rem',
    fontSize: '.82rem',
    cursor: 'pointer',
  },
  lastRun: {
    fontFamily: 'inherit',
    fontSize: '.8rem',
    color: '#1a7f37',
    margin: '.5rem 0 0',
  },
  history: { marginTop: '1.25rem' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '.8rem' },
  tr: { borderTop: '1px solid #eee' },
  td: { padding: '.3rem .4rem', verticalAlign: 'top' },
  tdName: { padding: '.3rem .4rem', verticalAlign: 'top', maxWidth: 240 },
  tdRight: { padding: '.3rem .4rem', textAlign: 'right', verticalAlign: 'top' },
  link: {
    background: 'none',
    border: 'none',
    padding: 0,
    color: '#0969da',
    cursor: 'pointer',
    fontSize: '.8rem',
    textDecoration: 'underline',
  },
  linkDanger: {
    background: 'none',
    border: 'none',
    padding: 0,
    color: '#cf222e',
    cursor: 'pointer',
    fontSize: '.85rem',
  },
  headerButtons: { display: 'flex', gap: '.4rem' },
};
