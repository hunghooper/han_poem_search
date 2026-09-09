import { describe, expect, it } from 'vitest';
import { t, tTrace, DICTS, LANGUAGE_NAMES } from './i18n';
import { UI_LANGUAGES } from '@han/shared/runtime-config';
import { msg, TRACE_CODES } from '@han/shared/trace';
import { TRACE_LABELS } from './i18n-trace';

const DERIVED_KEYS = [
  'topK',
  'fuseTopN',
  'rrfK',
  'verifyFloor',
  'noiseFloor',
  'minLexicalOverlap',
  'minAgreeingWindows',
  'enabled',
  'skipWhenNoOverlap',
  'maxIterations',
  'maxToolCalls',
  'maxWallClockMs',
  'maxCostUsd',
].map((k) => `settings.${k}`);

const STATIC_KEYS = [
  'app.tagline',
  'search.placeholder',
  'search.button',
  'search.running',
  'settings.title',
  'settings.close',
  'settings.reset',
  'settings.session',
  'settings.display',
  'settings.language',
  'settings.vertical',
  'settings.debug',
  'settings.hideSkipped',
  'settings.retrieval',
  'settings.sources',
  'settings.exactAlways',
  'settings.confidence',
  'settings.uncalibrated',
  'settings.agent',
  'settings.models',
  'settings.modelReasoning',
  'settings.modelAnswer',
  'settings.fromEnv',
  'answer.none',
  'answer.notAuthoritative',
  'answer.horizontal',
  'answer.vertical',
  'trace.inscription',
  'answer.ambiguous',
];

describe('i18n', () => {
  it('has every key in every language', () => {
    for (const lang of UI_LANGUAGES) {
      for (const key of [...DERIVED_KEYS, ...STATIC_KEYS]) {
        expect(t(lang, key), `${lang} is missing ${key}`).not.toBe(key);
      }
    }
  });

  it('has identical key sets in all three languages', () => {
    const keys = Object.fromEntries(
      UI_LANGUAGES.map((l) => [l, new Set(Object.keys(DICTS[l]))]),
    ) as Record<(typeof UI_LANGUAGES)[number], Set<string>>;
    for (const a of UI_LANGUAGES) {
      for (const b of UI_LANGUAGES) {
        const missing = [...keys[a]].filter((k) => !keys[b].has(k));
        expect(missing, `${b} is missing what ${a} has: ${missing.join(', ')}`).toEqual([]);
      }
    }
  });

  it('names all three languages', () => {
    for (const lang of UI_LANGUAGES) expect(LANGUAGE_NAMES[lang]).toBeTruthy();
  });

  it('interpolates variables', () => {
    expect(t('en', 'app.tagline', { n: '78,455' })).toContain('78,455');
  });

  it('falls back to the key itself so a gap is visible rather than blank', () => {
    expect(t('vi', 'nope.not.here')).toBe('nope.not.here');
  });
});

describe('trace labels', () => {
  it('has every code the server can emit, in every language', () => {
    for (const lang of UI_LANGUAGES) {
      for (const code of TRACE_CODES) {
        expect(TRACE_LABELS[lang][code], `${lang} is missing ${code}`).toBeTruthy();
      }
    }
  });

  it('has no label for a code no producer emits', () => {
    const known = new Set<string>(TRACE_CODES);
    for (const lang of UI_LANGUAGES) {
      for (const code of Object.keys(TRACE_LABELS[lang])) {
        expect(known.has(code), `${lang} has ${code}, which no producer emits`).toBe(true);
      }
    }
  });

  it('renders values into the sentence', () => {
    expect(tTrace('vi', msg('trace.normalised', { n: 10 }))).toContain('10');
    expect(tTrace('en', msg('trace.normalised', { n: 10 }))).toBe('Normalised to 10 characters');
  });

  it('renders composed messages, not a translated frame around English', () => {
    const composed = msg('trace.verify.passed', {}, [
      msg('trace.rhyme.share', { chars: '霜、鄉' }),
      msg('trace.tone.clean', { n: 0, coverage: '100' }),
    ]);
    const vi = tTrace('vi', composed) ?? '';
    expect(vi).toContain('Thể thức khớp');
    expect(vi).toContain('các chữ vần 霜、鄉');
    expect(vi).toContain('luật 平仄');
    expect(vi).not.toContain('rhyme characters');
    expect(vi).not.toContain('alternation');
  });

  it('falls back to the English the server sent when a code has no label', () => {
    expect(tTrace('vi', null, 'Reading your query')).toBe('Reading your query');
    expect(tTrace('vi', msg('trace.notAThing'), 'Reading your query')).toBe('Reading your query');
  });

  it('uses only param names the wire codec leaves alone', () => {
    const safe = /^[a-z][a-z0-9]*$/;
    let checked = 0;
    for (const lang of UI_LANGUAGES) {
      for (const [code, template] of Object.entries(TRACE_LABELS[lang])) {
        for (const m of template.matchAll(/\{(\w+)\}/gu)) {
          const name = m[1] ?? '';
          checked += 1;
          expect(safe.test(name), `${lang} ${code} has param {${name}}`).toBe(true);
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('returns null rather than a raw code when there is no fallback either', () => {
    expect(tTrace('vi', msg('trace.notAThing'))).toBeNull();
  });
});
