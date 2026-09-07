'use client';

/**
 * The settings panel — configuration for the whole app, not just the search box.
 *
 * Everything here is a SESSION setting. Display preferences never leave the browser; the rest
 * travel with each search as overrides and are never written back to the server. That is the
 * point: CONTRIBUTING.md requires a recorded calibration run before retrieval thresholds
 * change, so a panel that silently rewrote the project defaults would be a way around a rule
 * that exists for good reason. The panel says so, in the reader's language.
 */

import { useEffect, useState } from 'react';
import {
  DEFAULT_RUNTIME_CONFIG,
  UI_LANGUAGES,
  type Overrides,
  type RuntimeConfig,
  type UiConfig,
  type UiLanguage,
} from '@han/shared/runtime-config';
import { LANGUAGE_NAMES, t } from './i18n';

const STORAGE_KEY = 'han-search.settings.v1';

export interface Settings {
  ui: UiConfig;
  overrides: Overrides;
}

export const DEFAULT_SETTINGS: Settings = { ui: DEFAULT_RUNTIME_CONFIG.ui, overrides: {} };

/**
 * localStorage throws in some contexts (private windows, blocked site data, thumbnailing), and
 * a settings panel is not worth a blank page. Every access is guarded and falls back to the
 * committed defaults.
 */
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      ui: { ...DEFAULT_RUNTIME_CONFIG.ui, ...parsed.ui },
      overrides: parsed.overrides ?? {},
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // A viewer who blocks site data still gets a working app; they just re-set it next visit.
  }
}

export interface ServerConfig {
  config: RuntimeConfig;
  availableModels: string[];
  envModels: Record<string, string | null>;
}

interface Props {
  open: boolean;
  onClose: () => void;
  settings: Settings;
  server: ServerConfig | null;
  onChange: (s: Settings) => void;
}

export function SettingsPanel({ open, onClose, settings, server, onChange }: Props) {
  const lang = settings.ui.language;
  const base = server?.config ?? DEFAULT_RUNTIME_CONFIG;
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const setUi = (patch: Partial<UiConfig>) => {
    onChange({ ...settings, ui: { ...settings.ui, ...patch } });
    setDirty(true);
  };

  /** Section-scoped override setter. An undefined value clears the override for that field. */
  const setOver = <S extends keyof Overrides>(section: S, patch: Partial<NonNullable<Overrides[S]>>) => {
    onChange({
      ...settings,
      overrides: {
        ...settings.overrides,
        [section]: { ...(settings.overrides[section] ?? {}), ...patch },
      },
    });
    setDirty(true);
  };

  /** Effective value: the session override if there is one, otherwise the committed default. */
  const eff = <S extends keyof Overrides, K extends string>(section: S, key: K, fallback: number | boolean | string | null) => {
    const o = settings.overrides[section] as Record<string, unknown> | undefined;
    return (o?.[key] ?? fallback) as number | boolean | string | null;
  };

  const isOverridden = <S extends keyof Overrides>(section: S, key: string) =>
    (settings.overrides[section] as Record<string, unknown> | undefined)?.[key] !== undefined;

  const num = (
    section: keyof Overrides,
    key: string,
    fallback: number,
    opts: { min: number; max: number; step?: number },
  ) => (
    <label className={`field${isOverridden(section, key) ? ' over' : ''}`} key={key}>
      <span className="fname">{t(lang, `settings.${key}`)}</span>
      <input
        type="number"
        value={String(eff(section, key, fallback))}
        min={opts.min}
        max={opts.max}
        step={opts.step ?? 1}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) setOver(section, { [key]: v } as never);
        }}
      />
    </label>
  );

  const bool = (section: keyof Overrides, key: string, fallback: boolean) => (
    <label className={`check${isOverridden(section, key) ? ' over' : ''}`} key={key}>
      <input
        type="checkbox"
        checked={Boolean(eff(section, key, fallback))}
        onChange={(e) => setOver(section, { [key]: e.target.checked } as never)}
      />
      <span>{t(lang, `settings.${key}`)}</span>
    </label>
  );

  const uiBool = (key: keyof UiConfig, label: string) => (
    <label className="check" key={key}>
      <input
        type="checkbox"
        checked={Boolean(settings.ui[key])}
        onChange={(e) => setUi({ [key]: e.target.checked } as Partial<UiConfig>)}
      />
      <span>{label}</span>
    </label>
  );

  const modelSelect = (key: 'reasoning' | 'answer') => {
    const current = (settings.overrides.models?.[key] ?? base.models[key] ?? '') as string;
    return (
      <label className={`field${isOverridden('models', key) ? ' over' : ''}`} key={key}>
        <span className="fname">{t(lang, key === 'reasoning' ? 'settings.modelReasoning' : 'settings.modelAnswer')}</span>
        <select
          value={current}
          onChange={(e) => setOver('models', { [key]: e.target.value || null } as never)}
        >
          <option value="">
            {server?.envModels[key] ?? '—'} ({t(lang, 'settings.fromEnv')})
          </option>
          {(server?.availableModels ?? []).map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
    );
  };

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label={t(lang, 'settings.title')}>
      <div className="sheet-head">
        <h2>{t(lang, 'settings.title')}</h2>
        <div className="sheet-actions">
          {dirty && (
            <button
              type="button"
              className="ghost"
              onClick={() => {
                onChange(DEFAULT_SETTINGS);
                setDirty(false);
              }}
            >
              {t(lang, 'settings.reset')}
            </button>
          )}
          <button type="button" className="ghost" onClick={onClose}>
            {t(lang, 'settings.close')}
          </button>
        </div>
      </div>

      <p className="sheet-note">{t(lang, 'settings.session')}</p>

      <section className="group">
        <h3>{t(lang, 'settings.display')}</h3>
        <label className="field">
          <span className="fname">{t(lang, 'settings.language')}</span>
          <select value={lang} onChange={(e) => setUi({ language: e.target.value as UiLanguage })}>
            {UI_LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {LANGUAGE_NAMES[l]}
              </option>
            ))}
          </select>
        </label>
        <div className="checks">
          {uiBool('vertical', t(lang, 'settings.vertical'))}
          {uiBool('debug', t(lang, 'settings.debug'))}
          {uiBool('hideSkipped', t(lang, 'settings.hideSkipped'))}
        </div>
      </section>

      <section className="group">
        <h3>{t(lang, 'settings.retrieval')}</h3>
        <div className="fields">
          {num('retrieval', 'topK', base.retrieval.topK, { min: 1, max: 50 })}
          {num('retrieval', 'fuseTopN', base.retrieval.fuseTopN, { min: 1, max: 200 })}
          {num('retrieval', 'rrfK', base.retrieval.rrfK, { min: 1, max: 1000 })}
        </div>
        <p className="fnote">{t(lang, 'settings.sources')}</p>
        <div className="checks">
          {(['bm25', 'vector', 'reranker'] as const).map((k) => (
            <label className="check" key={k}>
              <input
                type="checkbox"
                checked={settings.overrides.retrieval?.sources?.[k] ?? base.retrieval.sources[k]}
                onChange={(e) =>
                  setOver('retrieval', {
                    sources: { ...settings.overrides.retrieval?.sources, [k]: e.target.checked },
                  } as never)
                }
              />
              <span>{k}</span>
            </label>
          ))}
        </div>
        <p className="fnote quiet">{t(lang, 'settings.exactAlways')}</p>
      </section>

      <section className="group">
        <h3>{t(lang, 'settings.confidence')}</h3>
        <p className="fnote warn">{t(lang, 'settings.uncalibrated')}</p>
        <div className="fields">
          {num('confidence', 'verifyFloor', base.confidence.verifyFloor, { min: 0, max: 1, step: 0.01 })}
          {num('confidence', 'noiseFloor', base.confidence.noiseFloor, { min: 0, max: 1, step: 0.01 })}
          {num('confidence', 'minLexicalOverlap', base.confidence.minLexicalOverlap, { min: 0, max: 1, step: 0.01 })}
          {num('confidence', 'minAgreeingWindows', base.confidence.minAgreeingWindows, { min: 1, max: 10 })}
        </div>
      </section>

      <section className="group">
        <h3>{t(lang, 'settings.agent')}</h3>
        <div className="checks">
          {bool('agent', 'enabled', base.agent.enabled)}
          {bool('agent', 'skipWhenNoOverlap', base.agent.skipWhenNoOverlap)}
        </div>
        <div className="fields">
          {num('agent', 'maxIterations', base.agent.maxIterations, { min: 1, max: 20 })}
          {num('agent', 'maxToolCalls', base.agent.maxToolCalls, { min: 1, max: 40 })}
          {num('agent', 'maxWallClockMs', base.agent.maxWallClockMs, { min: 1000, max: 300000, step: 1000 })}
          {num('agent', 'maxCostUsd', base.agent.maxCostUsd, { min: 0, max: 20, step: 0.05 })}
        </div>
      </section>

      <section className="group">
        <h3>{t(lang, 'settings.models')}</h3>
        <div className="fields">
          {modelSelect('reasoning')}
          {modelSelect('answer')}
        </div>
      </section>
    </div>
  );
}
