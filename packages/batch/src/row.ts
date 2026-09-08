/**
 * One search outcome as one export row.
 *
 * Deliberately one row per INPUT row, never one per candidate. The export has to line up with
 * the file the user uploaded — they will paste the new columns back beside the old ones, or
 * join on row order — and a run that silently turned 5,000 rows into 5,400 breaks that in a
 * way nobody notices until the numbers are wrong. Ambiguity is carried sideways in
 * `alternatives` instead of downward into extra rows.
 */

import { StepStatus } from '@han/shared/status';
import type { Evidence } from '@han/shared/evidence';
import type { ExportRowInput, ExportValue } from './types.js';
import { cellText } from './columns.js';
import { formLabelVi } from './form-label.js';

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

/**
 * Statuses that carry an answer.
 *
 * LOW_CONFIDENCE is here on purpose: a flagged candidate is exactly what the user should see,
 * with the warning in the status column beside it. NO_RESULT is not, and that distinction is
 * the reason this set exists.
 */
const ANSWERING: readonly StepStatus[] = [StepStatus.HAS_RESULT, StepStatus.LOW_CONFIDENCE];

function valueFor(key: string, input: ExportRowInput): ExportValue {
  const { outcome } = input;
  // A run can hold evidence the confidence policy REJECTED — the trace keeps it, which is
  // right. Writing it into title/author beside a no_result status is not: the row then reads
  // as an answer to anyone scanning the column, and the one cell that contradicts it is the
  // one they are least likely to look at. Found live: nonsense input returned no_result with
  // 駑驥 / 韩愈 filled in from a vector near-miss.
  const top = ANSWERING.includes(input.status) ? input.top : null;
  // Gated with `top`, and for the same reason: these columns describe the candidate. Checks
  // reported against a candidate the row does not name read as findings about nothing.
  // The full picture stays one click away through run_id.
  const verification = ANSWERING.includes(input.status) ? (outcome?.verification ?? null) : null;
  const check = (name: 'form' | 'rhyme' | 'tone'): ExportValue =>
    verification?.checks.find((c) => c.name === name)?.outcome ?? null;

  switch (key) {
    // The verdict. `status` is present for every row without exception, including rows the
    // run never reached — those carry NOT_EXECUTED, which is the whole reason the vocabulary
    // has that member (§5.1).
    case 'status':
      return input.status;
    case 'match_kind':
      return input.matchKind ?? matchKindOf(input);
    case 'confidence':
      return outcome ? round(outcome.confidence) : null;
    case 'flags':
      return outcome && outcome.flags.length > 0 ? outcome.flags.join(';') : null;
    // NOT gated on ANSWERING. A judgement of `insufficient` is exactly what a row with no
    // answer needs to carry — blanking it would hide the reason there is no answer.
    case 'llm_verdict':
      return outcome?.llmVerdict?.verdict ?? null;
    case 'llm_notes':
      return outcome?.llmVerdict?.notes || null;

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
      return matchedText(top);
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
    case 'form_label':
      return formLabelVi(verification?.candidateForm.form);
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
 * How the match was made, from the flags the run already recorded.
 *
 * `ambiguous` is the one that earns its place: several poems matched the fragment equally
 * well, the system said so, and a spreadsheet that showed only the first title would be
 * presenting a coin toss as a finding.
 */
function matchKindOf(input: ExportRowInput): ExportValue {
  if (!ANSWERING.includes(input.status)) return 'none';
  const flags = input.outcome?.flags ?? [];
  if (flags.includes('exact_ambiguous')) return 'ambiguous';
  if (flags.includes('exact_full_match')) return 'full';
  if (flags.includes('exact_partial_match')) return 'partial';
  return input.top ? 'partial' : 'none';
}

/**
 * The corpus text that matched, narrowed to the matched span when there is one.
 *
 * Without the span this would be the whole poem, which defeats the point of the column: the
 * user wants to see WHICH line their fragment hit, beside the fragment they pasted.
 */
function matchedText(top: Evidence | null): ExportValue {
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
  if (!ANSWERING.includes(input.status)) return null;
  const rest = input.outcome?.evidence.slice(1, 4) ?? [];
  if (rest.length === 0) return null;
  return rest
    .map((e) => `${e.title ?? '?'} — ${e.author ?? '?'} (${round(e.rerankScore ?? e.score)})`)
    .join('; ');
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

/** Re-exported so the readers and the API agree on how a source cell becomes a query. */
export { cellText };
