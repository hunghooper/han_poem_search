'use client';

/**
 * Everything that has ever been proposed for the corpus, and what happened to it.
 *
 * WHY THIS IS ITS OWN TAB. The review list used to sit at the top of the corpus tab, and it
 * showed only what was still waiting. That is the urgent state but not the interesting one:
 * additions are marked at all so that somebody can come back later and ask what got in and on
 * whose word — an export carries `han_added` for exactly that reason. A list that can only
 * answer "what needs me right now" cannot answer that, and the accepted rows, which are the
 * ones already changing what every search returns, were the ones you could never see.
 *
 * So: all three states, filterable, with the run that produced each one. Pending rows keep
 * their Accept and Reject buttons — the review still happens here, it is just no longer the
 * only thing here.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { UiLanguage } from '@han/shared/runtime-config';
import { t } from './i18n';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

type Status = 'pending' | 'accepted' | 'rejected';
type Origin = 'user' | 'agent';

interface Addition {
  id: string;
  origin: string;
  status: string;
  poemId: string | null;
  runId: string | null;
  sourceUrl: string | null;
  note: string | null;
  submittedBy: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
  payload: { title?: string; author?: string; text?: string; dynasty?: string };
}

interface Tally {
  status: string;
  origin: string;
  n: number;
}

const STATUSES: readonly (Status | 'all')[] = ['all', 'pending', 'accepted', 'rejected'];
const ORIGINS: readonly (Origin | 'all')[] = ['all', 'agent', 'user'];

export function AdditionsPanel({ lang }: { lang: UiLanguage }) {
  const [rows, setRows] = useState<Addition[]>([]);
  const [tallies, setTallies] = useState<Tally[]>([]);
  const [status, setStatus] = useState<Status | 'all'>('all');
  const [origin, setOrigin] = useState<Origin | 'all'>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [who, setWho] = useState('');

  // The same name the corpus tab remembers, and for the same reason: accepting a proposal is
  // the moment it becomes a poem every later search can return, and that decision gets a name
  // on it. Shared key, so a person types it once for both.
  useEffect(() => {
    try {
      setWho(localStorage.getItem('han.corpus.who') ?? '');
    } catch {
      // Private windows and blocked site data. Typing it again is the fallback.
    }
  }, []);

  const rememberWho = useCallback((v: string) => {
    setWho(v);
    try {
      localStorage.setItem('han.corpus.who', v);
    } catch {
      // The value still works for this page load.
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/corpus/additions?status=${status}&origin=${origin}`);
      if (!res.ok) {
        setError(t(lang, 'add.errLoad'));
        return;
      }
      const body = (await res.json()) as { additions: Addition[]; tallies: Tally[] };
      setRows(body.additions);
      setTallies(body.tallies);
    } catch {
      setError(t(lang, 'add.errNetwork'));
    } finally {
      setLoading(false);
    }
  }, [status, origin, lang]);

  useEffect(() => {
    void load();
  }, [load]);

  const review = useCallback(
    async (id: string, accept: boolean) => {
      setReviewing(id);
      try {
        const res = await fetch(`${API}/api/corpus/pending/${id}/review`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ accept, reviewedBy: who.trim() }),
        });
        if (!res.ok) setError(t(lang, 'add.errReview'));
        await load();
      } catch {
        setError(t(lang, 'add.errNetwork'));
      } finally {
        setReviewing(null);
      }
    },
    [load, who, lang],
  );

  const named = who.trim().length > 0;

  // Totals across every origin, so the chips describe the store rather than the filter.
  const count = useMemo(() => {
    const by: Record<string, number> = { pending: 0, accepted: 0, rejected: 0 };
    for (const x of tallies) by[x.status] = (by[x.status] ?? 0) + x.n;
    return by;
  }, [tallies]);

  const pendingCount = count.pending ?? 0;

  return (
    <div className="panel">
      <section className="group">
        <h3>{t(lang, 'add.title')}</h3>
        <p className="note">{t(lang, 'add.why')}</p>

        <div className="tally">
          <span className={pendingCount > 0 ? 'err-chip' : 'muted'}>
            {t(lang, 'add.nPending', { n: pendingCount })}
          </span>
          <span className="ok-chip">{t(lang, 'add.nAccepted', { n: count.accepted ?? 0 })}</span>
          <span className="muted">{t(lang, 'add.nRejected', { n: count.rejected ?? 0 })}</span>
        </div>
      </section>

      <section className="group">
        <div className="filters">
          <label>
            <span className="flabel">{t(lang, 'add.filterStatus')}</span>
            <select value={status} onChange={(e) => setStatus(e.target.value as Status | 'all')}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(lang, `add.status.${s}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="flabel">{t(lang, 'add.filterOrigin')}</span>
            <select value={origin} onChange={(e) => setOrigin(e.target.value as Origin | 'all')}>
              {ORIGINS.map((o) => (
                <option key={o} value={o}>
                  {t(lang, `add.origin.${o}`)}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* Only shown when it is needed: the field gates the review buttons, and a name box on
            a screen with nothing to review is a question nobody asked. */}
        {pendingCount > 0 && (
          <>
            <input
              className="who"
              type="text"
              maxLength={200}
              value={who}
              placeholder={t(lang, 'corpus.whoPlaceholder')}
              onChange={(e) => rememberWho(e.target.value)}
            />
            {!named && <p className="note">{t(lang, 'add.whoRequired')}</p>}
          </>
        )}

        {error && <p className="err-box">{error}</p>}
      </section>

      <section className="group">
        {loading ? (
          <p className="note">{t(lang, 'add.loading')}</p>
        ) : rows.length === 0 ? (
          <p className="note">{t(lang, 'add.empty')}</p>
        ) : (
          rows.map((a) => (
            <div className={`proposal p-${a.status}`} key={a.id}>
              <div className="proposal-head">
                <strong>{a.payload.title || t(lang, 'corpus.noTitle')}</strong>
                <span className="muted">
                  {' '}
                  {a.payload.author || t(lang, 'corpus.noAuthor')}
                  {a.payload.dynasty ? ` · ${a.payload.dynasty}` : ''}
                </span>
              </div>

              <div className="proposal-meta">
                {/* Origin first and always. It is the whole reason these rows are kept. */}
                <span className={a.origin === 'agent' ? 'err-chip' : 'muted'}>
                  {t(lang, `add.origin.${a.origin}`)}
                </span>
                <span className={a.status === 'accepted' ? 'ok-chip' : 'muted'}>
                  {t(lang, `add.status.${a.status}`)}
                </span>
              </div>

              <pre className="proposal-text">{a.payload.text}</pre>

              <div className="proposal-meta">
                {a.sourceUrl && (
                  <a href={a.sourceUrl} target="_blank" rel="noreferrer">
                    {t(lang, 'corpus.source')}
                  </a>
                )}
                {/* The run that produced it, so a reviewer reads the evidence and not only the
                    conclusion. */}
                {a.runId && <code>{a.runId.slice(0, 8)}</code>}
                {a.submittedBy && <span className="muted">{t(lang, 'add.by', { who: a.submittedBy })}</span>}
                {a.reviewedBy && (
                  <span className="muted">{t(lang, 'add.reviewedBy', { who: a.reviewedBy })}</span>
                )}
                <span className="muted">{new Date(a.createdAt).toLocaleString()}</span>
              </div>

              {a.status === 'pending' && (
                <div className="proposal-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={reviewing === a.id || !named}
                    onClick={() => void review(a.id, true)}
                  >
                    {t(lang, 'corpus.accept')}
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    disabled={reviewing === a.id || !named}
                    onClick={() => void review(a.id, false)}
                  >
                    {t(lang, 'corpus.reject')}
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </section>
    </div>
  );
}
