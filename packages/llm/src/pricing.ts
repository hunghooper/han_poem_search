/**
 * Cost estimation — the spec §4.3.
 *
 * "Cost is not in the OpenAI response. Compute it from config/pricing.yaml. Unknown model ->
 * null, not a guess."
 *
 * A guessed cost is worse than no cost: §12 enforces a budget against it, so a fabricated
 * number silently makes the budget wrong in an unknown direction. `null` propagates and the
 * run reports its accounting as degraded.
 */

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

export const PriceSchema = z.object({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
});
export type Price = z.infer<typeof PriceSchema>;

export const PriceTableSchema = z.object({
  models: z.record(PriceSchema).default({}),
});
export type PriceTable = Record<string, Price>;

export function loadPriceTable(path: string): PriceTable {
  const parsed = PriceTableSchema.safeParse(parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    // A malformed pricing file must not silently become an empty one — that would turn every
    // cost into null and quietly disable the budget.
    throw new Error(`invalid pricing table at ${path}: ${parsed.error.message}`);
  }
  return parsed.data.models;
}

/**
 * Cost in USD, or null when the model is unpriced.
 *
 * Matching is exact. Gateways prefix and suffix model ids freely (`openai/gpt-4o`,
 * `gpt-4o-2024-11-20`), and a fuzzy match would confidently price the wrong model — so an
 * unrecognised id is unpriced, and the operator adds the exact string their gateway reports.
 */
export function estimateCost(
  usage: { inputTokens: number; outputTokens: number } | null | undefined,
  model: string,
  table: PriceTable | undefined,
): number | null {
  if (!usage || !table) return null;
  const price = table[model];
  if (!price) return null;
  return (
    (usage.inputTokens / 1_000_000) * price.inputPerMTok +
    (usage.outputTokens / 1_000_000) * price.outputPerMTok
  );
}
