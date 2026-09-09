import { describe, expect, it } from 'vitest';
import { t, tTrace, LANGUAGE_NAMES } from './i18n';
import { UI_LANGUAGES } from '@han/shared/runtime-config';
import { msg, TRACE_CODES } from '@han/shared/trace';
import { TRACE_LABELS } from './i18n-trace';

/**
 * Every key the settings panel derives must exist in every language. A missing one renders the
 * raw key in the UI — which is how `settings.enabled` shipped as literal text: the panel builds
 * its label key from the FIELD name, and the dictionary had a hand-picked alias instead.
 */
const DERIVED_KEYS = [
  // settings.${field} for every number and boolean the panel renders
  'topK', 'fuseTopN', 'rrfK',
  'verifyFloor', 'noiseFloor', 'minLexicalOverlap', 'minAgreeingWindows',
  'enabled', 'skipWhenNoOverlap', 'maxIterations', 'maxToolCalls', 'maxWallClockMs', 'maxCostUsd',
].map((k) => `settings.${k}`);

const STATIC_KEYS = [
  'app.tagline', 'search.placeholder', 'search.button', 'search.running',
  'settings.title', 'settings.close', 'settings.reset', 'settings.session',
  'settings.display', 'settings.language', 'settings.vertical', 'settings.debug',
  'settings.hideSkipped', 'settings.retrieval', 'settings.sources', 'settings.exactAlways',
  'settings.confidence', 'settings.uncalibrated', 'settings.agent', 'settings.models',
  'settings.modelReasoning', 'settings.modelAnswer', 'settings.fromEnv',
  'answer.none', 'answer.notAuthoritative', 'answer.horizontal', 'answer.vertical',
  'trace.inscription', 'answer.ambiguous',
];

describe('i18n', () => {
  it('has every key in every language', () => {
    for (const lang of UI_LANGUAGES) {
      for (const key of [...DERIVED_KEYS, ...STATIC_KEYS]) {
        expect(t(lang, key), `${lang} is missing ${key}`).not.toBe(key);
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

/**
 * The trace is the part a reader most needs in their own language: it is the system explaining
 * why it decided what it decided. A code emitted on the server with no label beside it renders
 * as English inside a Vietnamese page — which reads as a translation bug rather than the
 * omission it is, and nothing but this test would catch it.
 */
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

  /** The prosody summary is built from its checks; the whole sentence must be one language. */
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

  /**
   * The case that decides whether this design was worth building: a run recorded before the
   * codes existed replays with no trace at all, and must still read as the English it was.
   */
  it('falls back to the English the server sent when a code has no label', () => {
    expect(tTrace('vi', null, 'Reading your query')).toBe('Reading your query');
    expect(tTrace('vi', msg('trace.notAThing'), 'Reading your query')).toBe('Reading your query');
  });

  /**
   * Params cross the wire inside the event, and the wire codec (@han/shared/serde) rewrites
   * EVERY key it walks: snake_case going out, camelCase coming back. A param named
   * `source_url` would therefore arrive as `sourceUrl`, never match its own placeholder, and
   * render as the literal text "{source_url}" — with no error anywhere.
   *
   * One lowercase word per param keeps the codec a no-op. This test is the only thing that
   * says so.
   */
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
    // A test that walks nothing passes for the wrong reason. This one nearly did: an earlier
    // version of the pattern lost its escapes, matched no placeholders at all, and went green.
    expect(checked).toBeGreaterThan(100);
  });

  /** A raw key on screen teaches a reader nothing; with no fallback, say nothing. */
  it('returns null rather than a raw code when there is no fallback either', () => {
    expect(tTrace('vi', msg('trace.notAThing'))).toBeNull();
  });
});
