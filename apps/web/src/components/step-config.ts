/**
 * Step presentation — the spec §14.2.
 *
 * "A trace that reads like a sentence, not a log." The message a step shows must be readable
 * by someone who does not know what BM25 is (CONTRIBUTING.md, extension point 2).
 *
 * Icons must be distinguishable WITHOUT colour, so each status gets its own glyph rather than
 * a coloured dot.
 */

// Step NAMES live in the label tables (`step.<name>` in i18n.ts), not here — a name shown
// to a reader has to be in their language, and a second copy in this file would be the drift
// this file's own header warns about.

export interface StatusStyle {
  icon: string;
  className: string;
}

export const STATUS_STYLE: Record<string, StatusStyle> = {
  has_result: { icon: '✓', className: 's-ok' }, // check
  no_result: { icon: '·', className: 's-none' }, // middle dot
  low_confidence: { icon: '⚠', className: 's-warn' }, // warning sign
  error: { icon: '✗', className: 's-err' }, // ballot X
  timeout: { icon: '⏱', className: 's-err' }, // stopwatch
  unavailable: { icon: '⊘', className: 's-err' }, // circled slash
  skipped: { icon: '–', className: 's-skip' }, // en dash
  not_executed: { icon: '○', className: 's-skip' }, // hollow circle
};

export const styleFor = (status: string | undefined): StatusStyle =>
  STATUS_STYLE[status ?? 'not_executed'] ?? { icon: '○', className: 's-skip' };

/** Flags worth drawing attention to — the ones that change how a result should be read. */
export const NOTABLE_FLAGS = new Set([
  'input_reordered',
  'exact_ambiguous',
  'variant_text_detected',
  'local_low_confidence',
  'no_local_result',
  'agent_budget_exhausted',
  'final_answer_uncited',
]);
