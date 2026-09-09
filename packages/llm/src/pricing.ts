import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

export const PriceSchema = z.object({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  cachedInputPerMTok: z.number().nonnegative().optional(),
});
export type Price = z.infer<typeof PriceSchema>;

export const PriceTableSchema = z.object({
  models: z.record(PriceSchema).default({}),
});
export type PriceTable = Record<string, Price>;

export function loadPriceTable(path: string): PriceTable {
  const parsed = PriceTableSchema.safeParse(parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    throw new Error(`invalid pricing table at ${path}: ${parsed.error.message}`);
  }
  return parsed.data.models;
}

export function estimateCost(
  usage:
    { inputTokens: number; outputTokens: number; cachedInputTokens?: number } | null | undefined,
  model: string,
  table: PriceTable | undefined,
): number | null {
  if (!usage || !table) return null;
  const price = table[model];
  if (!price) return null;

  const cached = Math.min(Math.max(usage.cachedInputTokens ?? 0, 0), usage.inputTokens);
  const fresh = usage.inputTokens - cached;
  const cachedRate = price.cachedInputPerMTok ?? price.inputPerMTok;

  return (
    (fresh / 1_000_000) * price.inputPerMTok +
    (cached / 1_000_000) * cachedRate +
    (usage.outputTokens / 1_000_000) * price.outputPerMTok
  );
}
