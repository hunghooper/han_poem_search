import { StepStatus } from '@han/shared/status';
import type { Evidence } from '@han/shared/evidence';
import type { ExportRowInput, ExportValue } from './types.js';
import { cellText } from './columns.js';
import { formLabelVi } from './form-label.js';

export type { ExportRowInput, ExportValue };

export function buildRow(
  input: ExportRowInput,
  columns: readonly string[],
): Record<string, ExportValue> {
  const out: Record<string, ExportValue> = {};
  for (const key of columns) out[key] = valueFor(key, input);
  return out;
}

const ANSWERING: readonly StepStatus[] = [StepStatus.HAS_RESULT, StepStatus.LOW_CONFIDENCE];

function valueFor(key: string, input: ExportRowInput): ExportValue {
  const { outcome } = input;
  const top = ANSWERING.includes(input.status) ? input.top : null;
  const verification = ANSWERING.includes(input.status) ? (outcome?.verification ?? null) : null;
  const check = (name: 'form' | 'rhyme' | 'tone'): ExportValue =>
    verification?.checks.find((c) => c.name === name)?.outcome ?? null;

  switch (key) {
    case 'status':
      return input.status;
    case 'match_kind':
      return input.matchKind ?? matchKindOf(input);
    case 'confidence':
      return outcome ? round(outcome.confidence) : null;
    case 'flags':
      return outcome && outcome.flags.length > 0 ? outcome.flags.join(';') : null;
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
    case 'added':
      return ANSWERING.includes(input.status)
        ? additionOrigin(top?.provenance?.dataset ?? null)
        : null;
    case 'added_source':
      return top?.provenance?.dataset && top.provenance.dataset !== 'chinese-poetry'
        ? (top.url ?? top.provenance.file ?? null)
        : null;
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

function matchKindOf(input: ExportRowInput): ExportValue {
  if (!ANSWERING.includes(input.status)) return 'none';
  const flags = input.outcome?.flags ?? [];
  if (flags.includes('exact_ambiguous')) return 'ambiguous';
  if (flags.includes('exact_full_match')) return 'full';
  if (flags.includes('exact_partial_match')) return 'partial';
  return input.top ? 'partial' : 'none';
}

function additionOrigin(dataset: string | null): ExportValue {
  if (dataset === 'user-added') return 'user';
  if (dataset === 'agent-proposed') return 'agent';
  return 'no';
}

function matchedText(top: Evidence | null): ExportValue {
  if (!top) return null;
  if (!top.matchedSpan) return top.content;
  const { start, end } = top.matchedSpan;
  const span = top.content.slice(start, end);
  return span.length > 0 ? span : top.content;
}

function alternatives(input: ExportRowInput): ExportValue {
  if (!ANSWERING.includes(input.status)) return null;
  const rest = input.outcome?.evidence.slice(1, 4) ?? [];
  if (rest.length === 0) return null;
  return rest
    .map((e) => `${e.title ?? '?'} — ${e.author ?? '?'} (${round(e.rerankScore ?? e.score)})`)
    .join('; ');
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

export { cellText };
