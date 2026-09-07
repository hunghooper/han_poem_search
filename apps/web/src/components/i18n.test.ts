import { describe, expect, it } from 'vitest';
import { t, LANGUAGE_NAMES } from './i18n';
import { UI_LANGUAGES } from '@han/shared/runtime-config';

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
  'trace.inscription',
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
