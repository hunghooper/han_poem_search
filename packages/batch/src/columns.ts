const HAN = /\p{Script=Han}/gu;

const NOISE = /[\s\p{P}\p{S}]/gu;

export function cjkRatio(value: string): number {
  const dense = value.replace(NOISE, '');
  const chars = [...dense];
  if (chars.length === 0) return 0;
  return (dense.match(HAN)?.length ?? 0) / chars.length;
}

export interface ColumnProfile {
  name: string;
  cjkRatio: number;
  filled: number;
  meanLength: number;
  samples: string[];
  score: number;
}

export interface ColumnScan {
  columns: ColumnProfile[];
  suggested: string | null;
  abstainReason?: 'no_cjk' | 'ambiguous';
}

const MIN_CJK_RATIO = 0.5;

const MIN_FILLED = 0.5;

const DECISIVE_MARGIN = 1.5;

export function scanColumns(rows: Array<Record<string, unknown>>, names?: string[]): ColumnScan {
  const columnNames = names ?? unionOfKeys(rows);
  const columns = columnNames.map((name) => profile(name, rows));

  const eligible = columns
    .filter((c) => c.cjkRatio >= MIN_CJK_RATIO && c.filled >= MIN_FILLED)
    .sort((a, b) => b.score - a.score);

  if (eligible.length === 0) {
    return { columns, suggested: null, abstainReason: 'no_cjk' };
  }
  const [best, second] = eligible;
  if (second && best!.score < second.score * DECISIVE_MARGIN) {
    return { columns, suggested: null, abstainReason: 'ambiguous' };
  }
  return { columns, suggested: best!.name };
}

function profile(name: string, rows: Array<Record<string, unknown>>): ColumnProfile {
  const values = rows.map((r) => cellText(r[name]));
  const nonEmpty = values.filter((v) => v.length > 0);
  const filled = values.length === 0 ? 0 : nonEmpty.length / values.length;
  const ratio =
    nonEmpty.length === 0 ? 0 : nonEmpty.reduce((s, v) => s + cjkRatio(v), 0) / nonEmpty.length;
  const meanLength =
    nonEmpty.length === 0 ? 0 : nonEmpty.reduce((s, v) => s + v.length, 0) / nonEmpty.length;

  return {
    name,
    cjkRatio: ratio,
    filled,
    meanLength,
    samples: nonEmpty.slice(0, 3),
    score: ratio * filled * Math.log1p(meanLength),
  };
}

export function unionOfKeys(rows: Array<Record<string, unknown>>): string[] {
  const seen = new Set<string>();
  for (const row of rows) for (const k of Object.keys(row)) seen.add(k);
  return [...seen];
}

export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}
