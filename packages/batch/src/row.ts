/**
 * One search outcome as one export row.
 *
 * Deliberately one row per INPUT row, never one per candidate. The export has to line up with
 * the file the user uploaded — they will paste the new columns back beside the old ones, or
 * join on row order — and a run that silently turned 5,000 rows into 5,400 breaks that in a
 * way nobody notices until the numbers are wrong. Ambiguity is carried sideways in
 * `alternatives` instead of downward into extra rows.
 */

import type { ExportRowInput, ExportValue } from './types.js';
import { cellText } from './columns.js';

export type { ExportRowInput, ExportValue };

/**
 * Build the `han_*` values for one row, for the selected columns only.
 *
 * Every value is a primitive or null. Null means "this run has nothing to say here", which the
 * writers render as an empty cell (XLSX) or `null` (JSONL) — never as an empty string, so a
 * field that is genuinely absent stays distinguishable from one that is present and blank.
 */
export function buildRow(
  input: ExportRowInput,
  columns: readonly string[],
): Record<string, ExportValue> {
  const out: Record<string, ExportValue> = {};
  for (const key of columns) out[key] = valueFor(key, input);
  return out;
}

function valueFor(key: string, input: ExportRowInput): ExportValue {
  const { outcome, top } = input;
  const verification = outcome?.verification ?? null;
  const check = (name: 'form' | 'rhyme' | 'tone'): ExportValue =>
    verification?.checks.find((c) => c.name === name)?.outcome ?? null;

  switch (key) {
    // The verdict. `status` is present for every row without exception, including rows the
    // run never reached — those carry NOT_EXECUTED, which is the whole reason the vocabulary
    // has that member (§5.1).
    case 'status':
      return input.status;
    case 'match_kind':
      return input.matchKind ?? null;
    case 'confidence':
      return outcome ? round(outcome.confidence) : null;
    case 'flags':
      return outcome && outcome.flags.length > 0 ? outcome.flags.join(';') : null;

    case 'title':
      return top?.title ?? null;
    case 'author':
      return top?.author ?? null;
    case 'dynasty':
      return top?.dynasty ?? null;
    case 'work_id':
      return top?.workId ?? null;
    case 'edition':
      return top?.edition ?? null;

    case 'matched_text':
      return matchedText(input);
    case 'input_normalized':
      return input.normalizedQuery ?? null;
    case 'colophon':
      return outcome?.colophon?.lines.join(' / ') ?? null;
    case 'colophon_date':
      return outcome?.colophon?.cyclicalDate ?? null;
    case 'full_text':
      return top?.content ?? null;

    case 'form':
      return verification?.candidateForm.form ?? null;
    case 'verify_form':
      return check('form');
    case 'verify_rhyme':
      return check('rhyme');
    case 'verify_tone':
      return check('tone');

    case 'source':
      return top?.source ?? null;
    case 'retrieval_method':
      return top?.retrievalMethod ?? null;
    case 'dataset':
      return top?.provenance?.dataset ?? null;
    case 'commit_sha':
      return top?.provenance?.commitSha ?? null;
    case 'url':
      return top?.url ?? null;

    case 'run_id':
      return outcome?.runId ?? null;
    case 'reordered':
      return outcome ? outcome.flags.includes('input_reordered') : null;
    case 'reading':
      return input.reading ?? null;
    case 'cost_usd':
      return input.costUsd ?? null;
    case 'latency_ms':
      return input.latencyMs ?? null;
    case 'model':
      return input.model ?? null;

    case 'alternatives':
      return alternatives(input);
    case 'json':
      return outcome ? JSON.stringify(outcome) : null;

    default:
      return null;
  }
}

/**
 * The corpus text that matched, narrowed to the matched span when there is one.
 *
 * Without the span this would be the whole poem, which defeats the point of the column: the
 * user wants to see WHICH line their fragment hit, beside the fragment they pasted.
 */
function matchedText(input: ExportRowInput): ExportValue {
  const top = input.top;
  if (!top) return null;
  if (!top.matchedSpan) return top.content;
  const { start, end } = top.matchedSpan;
  const span = top.content.slice(start, end);
  return span.length > 0 ? span : top.content;
}

/**
 * Runner-up candidates, as `title — author (score)`.
 *
 * Populated whenever there is more than one, not only on `exact_ambiguous`: a row whose top
 * two candidates are near-tied is exactly the row a human should look at, and the score
 * difference is what tells them so.
 */
function alternatives(input: ExportRowInput): ExportValue {
  const rest = input.outcome?.evidence.slice(1, 4) ?? [];
  if (rest.length === 0) return null;
  return rest
    .map((e) => `${e.title ?? '?'} — ${e.author ?? '?'} (${round(e.rerankScore ?? e.score)})`)
    .join('; ');
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

/** Re-exported so the readers and the API agree on how a source cell becomes a query. */
export { cellText };
