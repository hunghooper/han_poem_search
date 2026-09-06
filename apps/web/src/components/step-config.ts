/**
 * Step presentation — the spec §14.2.
 *
 * "A trace that reads like a sentence, not a log." The message a step shows must be readable
 * by someone who does not know what BM25 is (CONTRIBUTING.md, extension point 2).
 *
 * Icons must be distinguishable WITHOUT colour, so each status gets its own glyph rather than
 * a coloured dot.
 */

export const STEP_LABEL: Record<string, string> = {
  query_understanding: 'Read your query',
  normalization: 'Normalised the text',
  local_search: 'Searched the corpus',
  exact: 'Exact match',
  bm25: 'Keyword search',
  vector: 'Semantic search',
  hybrid: 'Combined results',
  reranker: 'Re-ranked candidates',
  local_evaluation: 'Judged the results',
  agent: 'Agent',
  tool_call: 'External source',
  aggregation: 'Merged evidence',
  rule_verification: 'Checked form and rhyme',
  llm_verification: 'Verified with a model',
  final_answer: 'Answer',
};

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
