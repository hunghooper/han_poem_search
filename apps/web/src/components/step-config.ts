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

export const NOTABLE_FLAGS = new Set([
  'input_reordered',
  'exact_ambiguous',
  'variant_text_detected',
  'local_low_confidence',
  'no_local_result',
  'agent_budget_exhausted',
  'final_answer_uncited',
]);
