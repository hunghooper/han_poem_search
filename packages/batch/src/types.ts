import type { Evidence } from '@han/shared/evidence';
import type { StepStatus } from '@han/shared/status';

export type ExportValue = string | number | boolean | null;

export interface VerificationView {
  outcome: 'pass' | 'fail' | 'abstain';
  checks: Array<{ name: 'form' | 'rhyme' | 'tone'; outcome: 'pass' | 'fail' | 'abstain' }>;
  candidateForm: { form: string };
}

export interface OutcomeView {
  runId: string;
  status: StepStatus;
  confidence: number;
  flags: string[];
  evidence: Evidence[];
  colophon: { lines: string[]; cyclicalDate: string | null } | null;
  verification: VerificationView | null;
  llmVerdict: { verdict: string; confidence: number; notes: string } | null;
}

export interface ExportRowInput {
  status: StepStatus;
  outcome: OutcomeView | null;
  top: Evidence | null;
  matchKind?: 'full' | 'partial' | 'ambiguous' | 'none' | null;
  normalizedQuery?: string | null;
  reading?: string | null;
  costUsd?: number | null;
  latencyMs?: number | null;
  model?: string | null;
}

export interface SourceRow {
  index: number;
  values: Record<string, unknown>;
}
