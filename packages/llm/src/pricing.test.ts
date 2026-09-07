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

describe('cached input tokens', () => {
  const glm = { inputPerMTok: 2.8, outputPerMTok: 8.8, cachedInputPerMTok: 2.8 };
  const discounted = { inputPerMTok: 2.8, outputPerMTok: 8.8, cachedInputPerMTok: 0.28 };

  it('prices the real glm-5.3 rates', () => {
    const c = estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'glm-5.3', { 'glm-5.3': glm });
    expect(c).toBeCloseTo(2.8 + 8.8);
  });

  it('bills cached tokens once, at the cached rate', () => {
    // OpenAI's convention is that prompt_tokens INCLUDES cached_tokens. Adding the two counts
    // together would bill every cache hit twice.
    const c = estimateCost(
      { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 400_000 },
      'm',
      { m: discounted },
    );
    expect(c).toBeCloseTo(0.6 * 2.8 + 0.4 * 0.28);
  });

  it('changes nothing when the cached rate equals the input rate', () => {
    const withCache = estimateCost({ inputTokens: 1e6, outputTokens: 0, cachedInputTokens: 5e5 }, 'g', { g: glm });
    const without = estimateCost({ inputTokens: 1e6, outputTokens: 0 }, 'g', { g: glm });
    expect(withCache).toBeCloseTo(without!);
  });

  it('defaults the cached rate to the input rate when the model omits it', () => {
    const noCacheField = { inputPerMTok: 2, outputPerMTok: 4 };
    expect(estimateCost({ inputTokens: 1e6, outputTokens: 0, cachedInputTokens: 1e6 }, 'x', { x: noCacheField })).toBeCloseTo(2);
  });

  it('never lets a bogus cached count exceed the prompt total or go negative', () => {
    // The count comes from the gateway; a wrong one must not produce a negative fresh-token
    // charge and silently reduce the bill.
    const over = estimateCost({ inputTokens: 1000, outputTokens: 0, cachedInputTokens: 99_999 }, 'm', { m: discounted });
    expect(over).toBeCloseTo((1000 / 1e6) * 0.28);
    const neg = estimateCost({ inputTokens: 1000, outputTokens: 0, cachedInputTokens: -5 }, 'm', { m: discounted });
    expect(neg).toBeCloseTo((1000 / 1e6) * 2.8);
  });
});

describe('the shipped table', () => {
  it('prices the two GLM models the maintainer supplied', () => {
    const t = loadPriceTable('config/pricing.yaml');
    expect(t['glm-5.3']).toEqual({ inputPerMTok: 2.8, outputPerMTok: 8.8, cachedInputPerMTok: 2.8 });
    expect(t['glm-5.3-flash']).toEqual({ inputPerMTok: 0.6, outputPerMTok: 2, cachedInputPerMTok: 0.6 });
    expect(t['gemini-3.8-flash']).toEqual({ inputPerMTok: 1.5, outputPerMTok: 7.5, cachedInputPerMTok: 1.5 });
  });
});
