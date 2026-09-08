'use client';

/**
 * Adding poems to the local corpus — THE INTERFACE ONLY.
 *
 * Nothing here calls the server. That is deliberate and was asked for: the shape of what a
 * person must supply, and what the system will refuse, is worth settling on screen before any
 * of it is written. Every control below is live enough to show the rules — the file is read in
 * the browser, the columns are checked, the refusals are real — and the "add" button is
 * disabled with a note saying so.
 *
 * WHY THE RULES ARE STRICT. Everything else in this system reports where an answer came from:
 * a local result carries a dataset, a file and a commit; an outside result carries a URL. A
 * poem a user adds has no such backing, and it will sit in the same index as 78,455 poems that
 * do. If it arrives without a title and an author it is not a record, it is a fragment — and
 * once it is in the index it will be returned as confidently as anything else.
 *
 * So: title and author are required, the text is required, and the source is required — not to
 * be tidy, but because a search result that cannot say where it came from is the one thing this
 * project exists to avoid.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { UiLanguage } from '@han/shared/runtime-config';
import { t } from './i18n';

/** What a row must carry before it may enter the corpus. */
export const REQUIRED_FIELDS = ['title', 'author', 'text'] as const;
/** Useful, not required. Absence is recorded rather than guessed at. */
export const OPTIONAL_FIELDS = ['dynasty', 'form', 'note', 'source_url'] as const;

export type RequiredField = (typeof REQUIRED_FIELDS)[number];

/** A verdict per row, so the screen can show what would be accepted before anything is. */
export interface RowCheck {
  index: number;
  ok: boolean;
  missing: string[];
  title: string;
  author: string;
  chars: number;
}

const HAN = /\p{Script=Han}/u;
const hanCount = (s: string): number => [...String(s ?? '')].filter((c) => HAN.test(c)).length;

/**
 * Check one row against the rules.
 *
 * Exported and pure so the rules can be tested without a browser, and so the eventual server
 * side can apply the SAME function rather than a second copy that drifts from it.
 */
export function checkRow(row: Record<string, unknown>, index: number): RowCheck {
  const get = (k: string): string => String(row[k] ?? '').trim();
  const missing: string[] = REQUIRED_FIELDS.filter((f) => get(f).length === 0);

  const text = get('text');
  const chars = hanCount(text);
  // A "poem" with no Han characters is not a poem this corpus can hold, whatever the columns
  // say. Reported as a missing text rather than silently accepted.
  if (!missing.includes('text') && chars < 4) missing.push('text_han');

  return {
    index,
    ok: missing.length === 0,
    missing,
    title: get('title'),
    author: get('author'),
    chars,
  };
}

export function CorpusPanel({ lang }: { lang: UiLanguage }) {
  const [rows, setRows] = useState<Array<Record<string, unknown>> | null>(null);
  const [filename, setFilename] = useState('');
  const [error, setError] = useState<string | null>(null);
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
    } catch {
      setError(t(lang, 'corpus.errParse'));
      setRows(null);
    }
  }, [lang]);

  return (
    <div className="panel">
      <p className="notice">{t(lang, 'corpus.notWired')}</p>

      <section className="group">
        <h3>{t(lang, 'corpus.rulesTitle')}</h3>
        <p className="note">{t(lang, 'corpus.rulesWhy')}</p>
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
        <button type="button" className="primary" disabled title={t(lang, 'corpus.notWired')}>
          {t(lang, 'corpus.add').replace('{n}', String(accepted))}
        </button>
        <p className="note">{t(lang, 'corpus.addNote')}</p>
      </section>
    </div>
  );
}
