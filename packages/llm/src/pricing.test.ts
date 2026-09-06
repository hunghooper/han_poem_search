import { describe, expect, it } from 'vitest';
import { estimateCost, loadPriceTable } from './pricing.js';

const table = { 'gpt-4o': { inputPerMTok: 2.5, outputPerMTok: 10 } };

describe('estimateCost', () => {
  it('computes cost from the table', () => {
    expect(estimateCost({ inputTokens: 1_000_000, outputTokens: 0 }, 'gpt-4o', table)).toBeCloseTo(2.5);
    expect(estimateCost({ inputTokens: 0, outputTokens: 500_000 }, 'gpt-4o', table)).toBeCloseTo(5);
  });

  // §4.3: "Unknown model -> null, not a guess."
  it('returns null for an unknown model rather than guessing', () => {
    expect(estimateCost({ inputTokens: 100, outputTokens: 100 }, 'mystery', table)).toBeNull();
  });

  it('does not fuzzy-match — a gateway-prefixed id is a different id', () => {
    // 'openai/gpt-4o' and 'gpt-4o-2024-11-20' may or may not share pricing; guessing would
    // confidently price the wrong model.
    expect(estimateCost({ inputTokens: 100, outputTokens: 0 }, 'openai/gpt-4o', table)).toBeNull();
  });

  it('returns null when usage or the table is missing', () => {
    expect(estimateCost(null, 'gpt-4o', table)).toBeNull();
    expect(estimateCost({ inputTokens: 1, outputTokens: 1 }, 'gpt-4o', undefined)).toBeNull();
  });
});

describe('loadPriceTable', () => {
  it('loads the shipped table', () => {
    const t = loadPriceTable('config/pricing.yaml');
    expect(Object.keys(t).length).toBeGreaterThan(0);
    for (const price of Object.values(t)) {
      expect(price.inputPerMTok).toBeGreaterThanOrEqual(0);
      expect(price.outputPerMTok).toBeGreaterThanOrEqual(0);
    }
  });

  it('throws on a missing file rather than silently pricing nothing', () => {
    // A silently empty table turns every cost into null and disables the §12 budget.
    expect(() => loadPriceTable('config/does-not-exist.yaml')).toThrow();
  });
});
