import { describe, expect, it } from 'vitest';
import {
  applyOverrides,
  DEFAULT_RUNTIME_CONFIG,
  OverridesSchema,
  RuntimeConfigSchema,
} from './runtime-config.js';

describe('RuntimeConfigSchema', () => {
  it('fills every section from an empty document', () => {
    const c = RuntimeConfigSchema.parse({});
    expect(c.retrieval.topK).toBe(8);
    expect(c.confidence.noiseFloor).toBe(0.35);
    expect(c.agent.maxIterations).toBe(6);
    expect(c.ui.language).toBe('vi');
  });

  it('rejects out-of-range numbers rather than clamping them silently', () => {
    for (const bad of [
      { confidence: { noiseFloor: 1.5 } },
      { confidence: { noiseFloor: -0.1 } },
      { agent: { maxWallClockMs: 1 } },
      { agent: { maxIterations: 0 } },
      { retrieval: { topK: 999 } },
      { retrieval: { fuseTopN: 0 } },
    ]) {
      expect(OverridesSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('rejects unknown keys, so a typo is an error rather than a silent no-op', () => {
    expect(OverridesSchema.safeParse({ confidence: { noiseFloor: 0.4 } }).success).toBe(true);
    expect(OverridesSchema.safeParse({ retreival: { topK: 4 } }).success).toBe(false);
  });

  it('does not accept ui settings — presentation never reaches the server', () => {
    expect(OverridesSchema.safeParse({ ui: { language: 'en' } }).success).toBe(false);
  });

  it('treats model ids as opaque strings (§4.1 rule 5)', () => {
    const r = OverridesSchema.safeParse({ models: { reasoning: 'anything-the-gateway-calls-it' } });
    expect(r.success).toBe(true);
  });
});

describe('applyOverrides', () => {
  it('returns the base untouched when nothing is overridden', () => {
    expect(applyOverrides(DEFAULT_RUNTIME_CONFIG, undefined)).toEqual(DEFAULT_RUNTIME_CONFIG);
  });

  it('changes only what was named, per section', () => {
    const c = applyOverrides(DEFAULT_RUNTIME_CONFIG, { confidence: { noiseFloor: 0.5 } });
    expect(c.confidence.noiseFloor).toBe(0.5);
    expect(c.confidence.verifyFloor).toBe(DEFAULT_RUNTIME_CONFIG.confidence.verifyFloor);
    expect(c.agent).toEqual(DEFAULT_RUNTIME_CONFIG.agent);
  });

  it('merges source toggles without dropping the unmentioned ones', () => {
    const c = applyOverrides(DEFAULT_RUNTIME_CONFIG, { retrieval: { sources: { vector: false } } });
    expect(c.retrieval.sources).toEqual({ bm25: true, vector: false, reranker: true });
  });

  it('never lets an override change ui — the server has no say in presentation', () => {
    const c = applyOverrides(DEFAULT_RUNTIME_CONFIG, {
      confidence: { noiseFloor: 0.9 },
    } as never);
    expect(c.ui).toEqual(DEFAULT_RUNTIME_CONFIG.ui);
  });

  it('is pure — the base is not mutated', () => {
    const before = JSON.stringify(DEFAULT_RUNTIME_CONFIG);
    applyOverrides(DEFAULT_RUNTIME_CONFIG, { agent: { enabled: false } });
    expect(JSON.stringify(DEFAULT_RUNTIME_CONFIG)).toBe(before);
  });
});
