'use client';

/**
 * The three things this app does, side by side.
 *
 * They were a page plus two modals, which made the batch panel and the corpus tools feel like
 * settings rather than work. They are not settings: a batch runs for hours and a corpus
 * addition changes what every future search can find. Tabs say that they are peers.
 *
 * The tab strip is a real tablist for the keyboard and for screen readers — arrow keys move
 * between tabs, and only the selected tab is in the tab order — because a person driving this
 * with a keyboard should not have to tab through three panels to reach the fourth.
 */

import type { UiLanguage } from '@han/shared/runtime-config';
import { t } from './i18n';

export type TabId = 'search' | 'batch' | 'corpus';

export const TAB_ORDER: readonly TabId[] = ['search', 'batch', 'corpus'];

const LABEL: Record<TabId, string> = {
  search: 'tab.search',
  batch: 'tab.batch',
  corpus: 'tab.corpus',
};

/** A short line under the strip saying what the open tab is for. */
const HINT: Record<TabId, string> = {
  search: 'tab.searchHint',
  batch: 'tab.batchHint',
  corpus: 'tab.corpusHint',
};

export function Tabs({
  lang,
  active,
  onChange,
}: {
  lang: UiLanguage;
  active: TabId;
  onChange: (id: TabId) => void;
}) {
  const move = (delta: number) => {
    const i = TAB_ORDER.indexOf(active);
    const next = TAB_ORDER[(i + delta + TAB_ORDER.length) % TAB_ORDER.length]!;
    onChange(next);
    document.getElementById(`tab-${next}`)?.focus();
  };

  return (
    <>
      <div className="tabstrip" role="tablist" aria-label={t(lang, 'tab.aria')}>
        {TAB_ORDER.map((id) => (
          <button
            key={id}
            id={`tab-${id}`}
            role="tab"
            type="button"
            aria-selected={active === id}
            aria-controls={`panel-${id}`}
            tabIndex={active === id ? 0 : -1}
            className={active === id ? 'tab on' : 'tab'}
            onClick={() => onChange(id)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') move(1);
              if (e.key === 'ArrowLeft') move(-1);
            }}
          >
            {t(lang, LABEL[id])}
          </button>
        ))}
      </div>
      <p className="tabhint">{t(lang, HINT[active])}</p>
    </>
  );
}
