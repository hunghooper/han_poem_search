/**
 * What a batch run adds to the user's file.
 *
 * ONE definition, read by the API when it writes the file and by the UI when it draws the
 * column picker, so the two cannot drift (the same reason `runtime-config.ts` is shared).
 *
 * The shape follows §5.3's Evidence rather than inventing a parallel one, so a column here can
 * always be traced to the field it came from.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: `han_status` cannot be switched off. A spreadsheet is
 * read one row at a time by someone who will never open the trace, and a cell reading 李白 is
 * taken as fact. Without the status beside it there is no way to see that the row was a
 * low-confidence guess, a timeout, or a row the run never reached — §1 calls asserting what
 * the system cannot support the failure that matters most, and batch is where it would happen
 * at scale and in silence.
 */

export type ColumnGroup =
  | 'verdict'
  | 'identity'
  | 'text'
  | 'verification'
  | 'provenance'
  | 'audit'
  | 'raw';

export interface ExportColumn {
  /** Column header in XLSX; key inside the `han` object in JSONL (without the `han_` prefix). */
  key: string;
  group: ColumnGroup;
  /** Preselected in the picker. */
  byDefault: boolean;
  /** Cannot be deselected. Exactly one column is locked, and it is the status. */
  locked?: true;
  /** Holds a whole poem or a JSON blob — legal, but off by default so the sheet stays legible. */
  wide?: true;
}

export const EXPORT_COLUMNS: readonly ExportColumn[] = [
  // The verdict. Everything here answers "how much of the next group should you believe?"
  { key: 'status', group: 'verdict', byDefault: true, locked: true },
  { key: 'match_kind', group: 'verdict', byDefault: true },
  { key: 'confidence', group: 'verdict', byDefault: true },
  { key: 'flags', group: 'verdict', byDefault: true },

  // The answer.
  { key: 'title', group: 'identity', byDefault: true },
  { key: 'author', group: 'identity', byDefault: true },
  { key: 'dynasty', group: 'identity', byDefault: true },
  { key: 'work_id', group: 'identity', byDefault: true },
  { key: 'edition', group: 'identity', byDefault: false },

  // What was matched, and what was actually searched. `input_normalized` is worth more than it
  // looks: it shows variant folding and reading-order recovery having happened, which is the
  // difference between "the corpus lacks this poem" and "we searched for the wrong string".
  { key: 'matched_text', group: 'text', byDefault: true },
  { key: 'input_normalized', group: 'text', byDefault: false },
  { key: 'colophon', group: 'text', byDefault: false },
  { key: 'colophon_date', group: 'text', byDefault: false },
  { key: 'full_text', group: 'text', byDefault: false, wide: true },

  // §10.1's rule checks. Three-valued — pass, fail, ABSTAIN — and the abstention is the
  // point: a rhyme check that could not run is not a rhyme check that passed.
  { key: 'form', group: 'verification', byDefault: true },
  { key: 'verify_form', group: 'verification', byDefault: false },
  { key: 'verify_rhyme', group: 'verification', byDefault: false },
  { key: 'verify_tone', group: 'verification', byDefault: false },

  // Where it came from. `commit_sha` is what makes a result reproducible months later, when
  // the corpus has moved on.
  { key: 'source', group: 'provenance', byDefault: true },
  { key: 'retrieval_method', group: 'provenance', byDefault: false },
  { key: 'dataset', group: 'provenance', byDefault: false },
  { key: 'commit_sha', group: 'provenance', byDefault: false },
  { key: 'url', group: 'provenance', byDefault: false },

  // The audit trail. `run_id` opens the full trace in the UI — the escape hatch from any
  // single row back to the whole reasoning, which is what makes a flat export defensible.
  { key: 'run_id', group: 'audit', byDefault: true },
  { key: 'reordered', group: 'audit', byDefault: false },
  { key: 'reading', group: 'audit', byDefault: false },
  { key: 'cost_usd', group: 'audit', byDefault: false },
  { key: 'latency_ms', group: 'audit', byDefault: false },
  { key: 'model', group: 'audit', byDefault: false },

  // Ambiguity, kept rather than resolved. When several poems match equally the run says so
  // (`exact_ambiguous`), and collapsing that to one title in a spreadsheet would be the same
  // lie the status column exists to prevent.
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

/**
 * The selection actually used, given what the user asked for.
 *
 * Locked columns are added back silently; unknown keys are dropped. Order always follows
 * EXPORT_COLUMNS, never the request, so two exports of the same file line up column for column.
 */
export function resolveColumns(requested: readonly string[] | undefined): string[] {
  const want = new Set(requested ?? DEFAULT_COLUMNS);
  for (const k of LOCKED_COLUMNS) want.add(k);
  return EXPORT_COLUMNS.filter((c) => want.has(c.key) && KNOWN.has(c.key)).map((c) => c.key);
}

/** `title` → `han_title`. Applied for XLSX headers; JSONL nests under `han` instead. */
export const headerFor = (key: string): string => `${COLUMN_PREFIX}${key}`;
