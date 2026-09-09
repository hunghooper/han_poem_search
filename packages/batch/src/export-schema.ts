export type ColumnGroup =
  'verdict' | 'identity' | 'text' | 'verification' | 'provenance' | 'audit' | 'raw';

export interface ExportColumn {
  key: string;
  group: ColumnGroup;
  byDefault: boolean;
  locked?: true;
  wide?: true;
}

export const EXPORT_COLUMNS: readonly ExportColumn[] = [
  { key: 'status', group: 'verdict', byDefault: true, locked: true },
  { key: 'match_kind', group: 'verdict', byDefault: true },
  { key: 'confidence', group: 'verdict', byDefault: true },
  { key: 'flags', group: 'verdict', byDefault: true },
  { key: 'llm_verdict', group: 'verdict', byDefault: true },
  { key: 'llm_notes', group: 'verdict', byDefault: false },

  { key: 'title', group: 'identity', byDefault: true },
  { key: 'author', group: 'identity', byDefault: true },
  { key: 'dynasty', group: 'identity', byDefault: true },
  { key: 'work_id', group: 'identity', byDefault: true },
  { key: 'edition', group: 'identity', byDefault: false },

  { key: 'matched_text', group: 'text', byDefault: true },
  { key: 'input_normalized', group: 'text', byDefault: false },
  { key: 'colophon', group: 'text', byDefault: false },
  { key: 'colophon_date', group: 'text', byDefault: false },
  { key: 'full_text', group: 'text', byDefault: false, wide: true },

  { key: 'form', group: 'verification', byDefault: false },
  { key: 'form_label', group: 'verification', byDefault: true },
  { key: 'verify_form', group: 'verification', byDefault: false },
  { key: 'verify_rhyme', group: 'verification', byDefault: false },
  { key: 'verify_tone', group: 'verification', byDefault: false },

  { key: 'source', group: 'provenance', byDefault: true },
  { key: 'added', group: 'provenance', byDefault: true },
  { key: 'added_source', group: 'provenance', byDefault: false },
  { key: 'retrieval_method', group: 'provenance', byDefault: false },
  { key: 'dataset', group: 'provenance', byDefault: false },
  { key: 'commit_sha', group: 'provenance', byDefault: false },
  { key: 'url', group: 'provenance', byDefault: false },

  { key: 'run_id', group: 'audit', byDefault: true },
  { key: 'reordered', group: 'audit', byDefault: false },
  { key: 'reading', group: 'audit', byDefault: false },
  { key: 'cost_usd', group: 'audit', byDefault: false },
  { key: 'latency_ms', group: 'audit', byDefault: false },
  { key: 'model', group: 'audit', byDefault: false },

  { key: 'alternatives', group: 'raw', byDefault: false },
  { key: 'json', group: 'raw', byDefault: false, wide: true },
] as const;

export const COLUMN_PREFIX = 'han_';

export const LOCKED_COLUMNS: readonly string[] = EXPORT_COLUMNS.filter((c) => c.locked).map(
  (c) => c.key,
);

export const DEFAULT_COLUMNS: readonly string[] = EXPORT_COLUMNS.filter((c) => c.byDefault).map(
  (c) => c.key,
);

const KNOWN = new Set(EXPORT_COLUMNS.map((c) => c.key));

export function resolveColumns(requested: readonly string[] | undefined): string[] {
  const want = new Set(requested ?? DEFAULT_COLUMNS);
  for (const k of LOCKED_COLUMNS) want.add(k);
  return EXPORT_COLUMNS.filter((c) => want.has(c.key) && KNOWN.has(c.key)).map((c) => c.key);
}

export const headerFor = (key: string): string => `${COLUMN_PREFIX}${key}`;
