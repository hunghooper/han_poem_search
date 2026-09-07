'use client';

/**
 * The batch panel: upload, choose a column, see what it will cost, run, export.
 *
 * Four steps rather than one, and the two in the middle are the reason. A single "upload and
 * go" button would let someone point a 50,000-row run at the wrong column and find out from
 * the bill. So the column is always chosen by a person — the scan only ranks the candidates,
 * and says so when it will not guess — and the estimate is shown before start does anything.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { UiLanguage } from '@han/shared/runtime-config';
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
  agentRows: number;
  seconds: number;
  costUsd: number;
  capBinds: boolean;
  severity: 'trivial' | 'notable' | 'serious';
}

interface Progress {
  status: string;
  rowsDone: number;
  totalRows: number;
  byStatus: Record<string, number>;
  costUsd: number;
  error: string | null;
  running: boolean;
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

/** Colour by meaning, not by mood: only has_result is unqualified good news. */
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

export function BatchPanel({ lang, onClose }: { lang: UiLanguage; onClose: () => void }) {
  const [scan, setScan] = useState<Scan | null>(null);
  const [column, setColumn] = useState<string>('');
  const [agentEnabled, setAgentEnabled] = useState(false);
  const [capUsd, setCapUsd] = useState<string>('');
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [available, setAvailable] = useState<ExportColumn[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmText, setConfirmText] = useState('');
  const [rerun, setRerun] = useState<'unresolved' | 'all'>('unresolved');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // A finished job cannot simply be started again: the server refuses without an explicit
  // mode, because a silent no-op that reports `started` is the worst possible answer.
  const finished = Boolean(progress && !progress.running && progress.rowsDone > 0);
  const settled =
    (progress?.byStatus.has_result ?? 0) + (progress?.byStatus.skipped ?? 0);
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

  const upload = useCallback(async (file: File) => {
    setBusy(true);
    setError(null);
    setProgress(null);
    try {
      const body = new FormData();
      body.append('file', file);
      const res = await fetch(`${API}/api/batch/upload`, { method: 'POST', body });
      const data = (await res.json()) as Scan & { error?: string };
      if (!res.ok) {
        // The server distinguishes "this is a .xls", "this is a JSON array", "this is CSV" and
        // says what to do about each. Showing that sentence is the whole point of detecting.
        setError(data.error ?? 'upload failed');
        return;
      }
      setScan(data);
      setColumn(data.suggested ?? '');
    } finally {
      setBusy(false);
    }
  }, []);

  // Re-estimate whenever the options change, so the number on screen is always the number the
  // start button will act on.
  useEffect(() => {
    if (!scan) return;
    const cap = capUsd.trim() === '' ? null : Number(capUsd);
    void fetch(`${API}/api/batch/${scan.jobId}/estimate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: { enabled: agentEnabled, capUsd: cap },
        // The estimate has to be for the rows this run would actually search. Quoting the
        // whole file for a second pass over the leftovers would make the number meaningless.
        rerun: finished ? rerun : undefined,
      }),
    })
      .then((r) => r.json() as Promise<Estimate>)
      .then(setEstimate)
      .catch(() => undefined);
    setConfirmText('');
  }, [scan, agentEnabled, capUsd, finished, rerun]);

  // Poll while the job runs. A batch is long enough that a page left open must keep telling
  // the truth about it.
  useEffect(() => {
    if (!scan) return undefined;
    let alive = true;
    const tick = async () => {
      const res = await fetch(`${API}/api/batch/${scan.jobId}`);
      if (!alive || !res.ok) return;
      setProgress((await res.json()) as Progress);
    };
    void tick();
    const timer = setInterval(() => void tick(), 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [scan]);

  const start = async () => {
    if (!scan || !column) return;
    setBusy(true);
    setError(null);
    try {
      const cap = capUsd.trim() === '' ? null : Number(capUsd);
      const res = await fetch(`${API}/api/batch/${scan.jobId}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          column,
          agent: { enabled: agentEnabled, capUsd: cap },
          rerun: finished ? rerun : undefined,
          acknowledgedCostUsd: estimate?.costUsd,
        }),
      });
      if (!res.ok) setError(((await res.json()) as { error?: string }).error ?? 'start failed');
    } finally {
      setBusy(false);
    }
  };

  const exportUrl = (format: 'jsonl' | 'xlsx'): string => {
    const cols = [...selected].join(',');
    return `${API}/api/batch/${scan?.jobId}/export?format=${format}&columns=${encodeURIComponent(cols)}`;
  };

  const needsTypedConfirm = estimate?.severity === 'serious' && agentEnabled;
  const confirmed = !needsTypedConfirm || confirmText.trim() === String(estimate?.costUsd ?? '');
  const canStart = Boolean(scan && column) && !busy && !progress?.running && confirmed;

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.panel} onClick={(e) => e.stopPropagation()}>
        <header style={S.header}>
          <h2 style={S.h2}>{t(lang, 'batch.title')}</h2>
          <button onClick={onClose} style={S.ghost}>
            {t(lang, 'batch.close')}
          </button>
        </header>

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
              {/* The scan abstains rather than nominating the least bad column. Saying so is
                  what stops the user clicking past a confident wrong default. */}
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
                  <label key={c.name} style={{ ...S.column, ...(column === c.name ? S.columnOn : {}) }}>
                    <input
                      type="radio"
                      name="column"
                      checked={column === c.name}
                      onChange={() => setColumn(c.name)}
                      disabled={progress?.running}
                    />
                    <span style={S.columnName}>{c.name}</span>
                    {/* The badge cell is always rendered, empty when this is not the
                        suggestion. Rendering it conditionally shifts the grid and the one
                        highlighted row ends up misaligned against all the others. */}
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
              <section style={{ ...S.section, ...severityStyle(estimate.severity) }}>
                <h3 style={S.h3}>{t(lang, 'batch.estimate')}</h3>
                <div style={S.estGrid}>
                  <span>{t(lang, 'batch.estCost')}</span>
                  <strong>${estimate.costUsd.toFixed(2)}</strong>
                  <span>{t(lang, 'batch.estTime')}</span>
                  <strong>{humanTime(estimate.seconds, lang)}</strong>
                  <span>{t(lang, 'batch.estAgentRows')}</span>
                  <strong>{estimate.agentRows.toLocaleString()}</strong>
                </div>
                <p style={S.hint}>{t(lang, 'batch.estimateNote')}</p>

                {/* Typing the number is the friction. A run of this size should not start on a
                    click that could have been a mis-aim. */}
                {needsTypedConfirm && !progress?.running && (
                  <div style={S.confirm}>
                    <label style={S.capLabel}>
                      {t(lang, 'batch.confirmSerious')}
                      <input
                        value={confirmText}
                        onChange={(e) => setConfirmText(e.target.value)}
                        placeholder={String(estimate.costUsd)}
                        style={S.input}
                      />
                    </label>
                  </div>
                )}
              </section>
            )}

            <section style={S.section}>
              {progress?.running ? (
                <button
                  style={S.danger}
                  onClick={() => void fetch(`${API}/api/batch/${scan.jobId}/cancel`, { method: 'POST' })}
                >
                  {t(lang, 'batch.cancel')}
                </button>
              ) : (
                <>
                  {/* A finished job needs the second run to say what it means. The server
                      refuses a bare restart, so offering one here would only produce an
                      error the user cannot act on. */}
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
                      {t(lang, 'batch.progress')
                        .replace('{done}', String(progress.rowsDone))
                        .replace('{total}', String(progress.totalRows))}
                    </span>
                    <span style={S.muted}>
                      {t(lang, 'batch.spent')} ${progress.costUsd.toFixed(4)}
                    </span>
                  </div>
                  <div style={S.bar}>
                    <div
                      style={{
                        ...S.barFill,
                        width: `${pct(progress.rowsDone, progress.totalRows)}%`,
                      }}
                    />
                  </div>
                  {/* The breakdown, not just a count. "4 found, 1 not found, 1 skipped" is a
                      different thing from "6 done", and it is the thing worth knowing. */}
                  <div style={S.statusRow}>
                    {Object.entries(progress.byStatus).map(([status, n]) => (
                      <span key={status} style={{ ...S.chip, color: STATUS_COLOR[status] ?? '#57606a' }}>
                        {status} {n}
                      </span>
                    ))}
                  </div>
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

const pct = (done: number, total: number): number =>
  total === 0 ? 0 : Math.min(100, Math.round((done / total) * 100));

function humanTime(seconds: number, lang: UiLanguage): string {
  if (seconds < 90) return `${Math.round(seconds)} ${t(lang, 'batch.unitSecond')}`;
  if (seconds < 5400) return `${(seconds / 60).toFixed(1)} ${t(lang, 'batch.unitMinute')}`;
  if (seconds < 172800) return `${(seconds / 3600).toFixed(1)} ${t(lang, 'batch.unitHour')}`;
  return `${(seconds / 86400).toFixed(1)} ${t(lang, 'batch.unitDay')}`;
}

const severityStyle = (s: Estimate['severity']): React.CSSProperties =>
  s === 'serious'
    ? { borderColor: '#cf222e', background: '#fff5f5' }
    : s === 'notable'
      ? { borderColor: '#9a6700', background: '#fffbf0' }
      : {};

const S: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.35)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'flex-start',
    padding: '3vh 1rem',
    zIndex: 50,
    overflowY: 'auto',
  },
  panel: {
    background: '#fff',
    borderRadius: 8,
    maxWidth: 760,
    width: '100%',
    padding: '1.25rem 1.5rem 2rem',
    boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
  },
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
  check: { display: 'flex', gap: '.4rem', alignItems: 'center', fontSize: '.85rem', padding: '.15rem 0' },
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
  confirm: { marginTop: '.75rem' },
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
};
