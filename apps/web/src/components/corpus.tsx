'use client';

/**
 * Adding poems to the local corpus — THE INTERFACE ONLY.
 *
 * The file is read in the BROWSER first, so a person sees every refusal before anything leaves
 * their machine and before the server does any work. The server then checks the same rows with
 * the same function: a browser check is a convenience, never a guard.
 *
 * WHY THE RULES ARE STRICT. Everything else in this system reports where an answer came from:
 * a local result carries a dataset, a file and a commit; an outside result carries a URL. A
 * poem a user adds has no such backing, and it will sit in the same index as 78,455 poems that
 * do. If it arrives without a title and an author it is not a record, it is a fragment — and
 * once it is in the index it will be returned as confidently as anything else.
 *
 * So: title and author are required, and the text must be Han verse — not to be tidy, but
 * because a search result that cannot say where it came from is the one thing this project
 * exists to avoid.
 *
 * REVIEWING what was added lives in the Additions tab, not here. This tab puts poems in; that
 * one shows what went in and decides on what the verifier proposed. They were one screen, and
 * the review list sat permanently half-hidden above a file picker.
 *
 * THE RULES THEMSELVES LIVE IN `@han/shared/corpus-addition`, not here. The server applies the
 * same function: a browser check is a convenience, not a guard, and two copies would drift into
 * a row the screen accepts and the server refuses.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UiLanguage } from '@han/shared/runtime-config';
import { t } from './i18n';

import { checkRow, OPTIONAL_FIELDS, REQUIRED_FIELDS } from '@han/shared/corpus-addition';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface AddResult {
  index: number;
  result: 'added' | 'duplicate' | 'refused' | 'error';
  message?: string;
}

export function CorpusPanel({ lang, corpusSize }: { lang: UiLanguage; corpusSize: number | null }) {
  const [rows, setRows] = useState<Array<Record<string, unknown>> | null>(null);
  const [filename, setFilename] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [who, setWho] = useState('');
  const [outcome, setOutcome] = useState<{ tally: Record<string, number>; results: AddResult[] } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const checks = useMemo(() => (rows ? rows.map(checkRow) : []), [rows]);
  const accepted = checks.filter((c) => c.ok).length;
  const rejected = checks.length - accepted;

  const read = useCallback(async (file: File) => {
    setError(null);
    setFilename(file.name);
    try {
      // Read in the BROWSER. Nothing is uploaded — this screen is not wired to the server yet,
      // and showing the rules should not cost a round trip or leave a file behind.
      const text = await file.text();
      const parsed = text
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      if (parsed.length === 0) {
        setError(t(lang, 'corpus.errEmpty'));
        return;
      }
      setRows(parsed);
      setOutcome(null);
    } catch {
      setError(t(lang, 'corpus.errParse'));
      setRows(null);
    }
  }, [lang]);

  // Remembered per browser so the field is typed once, not once per file. It is a claim about
  // who is adding, not a login — there is no auth (§17) — but a claim with a name on it is
  // still worth more than a blank column when somebody later asks where a poem came from.
  useEffect(() => {
    try {
      setWho(localStorage.getItem('han.corpus.who') ?? '');
    } catch {
      // Private windows and blocked site data. Typing the name each time is the fallback.
    }
  }, []);

  const rememberWho = useCallback((v: string) => {
    setWho(v);
    try {
      localStorage.setItem('han.corpus.who', v);
    } catch {
      // Nothing to do: the value still works for this page load.
    }
  }, []);

  const named = who.trim().length > 0;

  const submit = useCallback(async () => {
    if (!rows) return;
    setSending(true);
    setError(null);
    try {
      // Only the rows the rules accept are sent. Posting the refused ones so the server can
      // refuse them again would spend a round trip to learn what is already on screen.
      const payload = checks.filter((c) => c.ok).map((c) => rows[c.index]);
      const res = await fetch(`${API}/api/corpus/additions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ poems: payload, submittedBy: who.trim() }),
      });
      const body = (await res.json()) as { error?: string; tally?: Record<string, number>; results?: AddResult[] };
      if (!res.ok) {
        setError(body.error ?? 'add failed');
        return;
      }
      setOutcome({ tally: body.tally ?? {}, results: body.results ?? [] });
    } catch {
      setError(t(lang, 'corpus.errNetwork'));
    } finally {
      setSending(false);
    }
  }, [rows, checks, lang, who]);

  return (
    <div className="panel">

      <section className="group">
        <h3>{t(lang, 'corpus.whoTitle')}</h3>
        <p className="note">{t(lang, 'corpus.whoWhy')}</p>
        <input
          className="who"
          type="text"
          maxLength={200}
          value={who}
          placeholder={t(lang, 'corpus.whoPlaceholder')}
          onChange={(e) => rememberWho(e.target.value)}
        />
      </section>

      <section className="group">
        <h3>{t(lang, 'corpus.rulesTitle')}</h3>
        {/* The size is counted and passed in. It used to be typed into the sentence, which was
            true when written and wrong the moment somebody used this very screen. */}
        {corpusSize !== null && (
          <p className="note">
            {t(lang, 'corpus.rulesWhy', { n: corpusSize.toLocaleString('en-US') })}
          </p>
        )}
        <table className="rules">
          <tbody>
            <tr>
              <th>{t(lang, 'corpus.required')}</th>
              <td>
                {REQUIRED_FIELDS.map((f) => (
                  <code key={f}>{f}</code>
                ))}
              </td>
            </tr>
            <tr>
              <th>{t(lang, 'corpus.optional')}</th>
              <td>
                {OPTIONAL_FIELDS.map((f) => (
                  <code key={f}>{f}</code>
                ))}
              </td>
            </tr>
            <tr>
              <th>{t(lang, 'corpus.format')}</th>
              <td>{t(lang, 'corpus.formatValue')}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="group">
        <h3>{t(lang, 'corpus.pickTitle')}</h3>
        <input
          ref={fileInput}
          type="file"
          accept=".jsonl"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void read(f);
          }}
        />
        <button type="button" className="primary" onClick={() => fileInput.current?.click()}>
          {t(lang, 'corpus.pick')}
        </button>
        {filename && <span className="muted"> {filename}</span>}
        {error && <p className="err-box">{error}</p>}
      </section>

      {checks.length > 0 && (
        <section className="group">
          <h3>{t(lang, 'corpus.checkTitle')}</h3>
          <div className="tally">
            <span className="ok-chip">
              {t(lang, 'corpus.accepted').replace('{n}', String(accepted))}
            </span>
            <span className={rejected > 0 ? 'err-chip' : 'muted'}>
              {t(lang, 'corpus.rejected').replace('{n}', String(rejected))}
            </span>
          </div>

          {/* Refusals first. A screen that leads with what it accepted buries the work. */}
          <div className="scroller">
            <table className="rows">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{t(lang, 'corpus.colTitle')}</th>
                  <th>{t(lang, 'corpus.colAuthor')}</th>
                  <th>{t(lang, 'corpus.colChars')}</th>
                  <th>{t(lang, 'corpus.colVerdict')}</th>
                </tr>
              </thead>
              <tbody>
                {[...checks]
                  .sort((a, b) => Number(a.ok) - Number(b.ok))
                  .slice(0, 50)
                  .map((c) => (
                    <tr key={c.index}>
                      <td className="num">{c.index + 1}</td>
                      <td>{c.title || <span className="muted">—</span>}</td>
                      <td>{c.author || <span className="muted">—</span>}</td>
                      <td className="num">{c.chars}</td>
                      <td>
                        {c.ok ? (
                          <span className="ok-chip">{t(lang, 'corpus.rowOk')}</span>
                        ) : (
                          <span className="err-chip">
                            {t(lang, 'corpus.rowMissing')}{' '}
                            {c.missing.map((m) => t(lang, `corpus.field.${m}`)).join(', ')}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {checks.length > 50 && (
            <p className="note">{t(lang, 'corpus.more').replace('{n}', String(checks.length - 50))}</p>
          )}
        </section>
      )}

      <section className="group">
        <button
          type="button"
          className="primary"
          disabled={accepted === 0 || sending || !named}
          onClick={() => void submit()}
        >
          {sending
            ? t(lang, 'corpus.adding')
            : t(lang, 'corpus.add').replace('{n}', String(accepted))}
        </button>
        {/* Named, so a disabled button is never a mystery. */}
        {!named && <p className="note">{t(lang, 'corpus.whoRequired')}</p>}
        <p className="note">{t(lang, 'corpus.addNote')}</p>

        {outcome && (
          <div className="tally">
            {/* Four outcomes, named separately. "added" and "duplicate" are both successes
                and mean different things to whoever assembled the file; "refused" is the
                rules and "error" is us. */}
            {(['added', 'duplicate', 'refused', 'error'] as const).map((k) =>
              outcome.tally[k] ? (
                <span key={k} className={k === 'added' ? 'ok-chip' : k === 'error' ? 'err-chip' : 'muted'}>
                  {t(lang, `corpus.out.${k}`).replace('{n}', String(outcome.tally[k]))}
                </span>
              ) : null,
            )}
          </div>
        )}
      </section>
    </div>
  );
}
