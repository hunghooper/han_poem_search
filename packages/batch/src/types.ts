/**
 * The batch contracts, in one place.
 *
 * `packages/batch` must not import from `apps/api`, so the search outcome arrives here as a
 * structural type. It is deliberately a subset of `SearchOutcome` — only the fields the export
 * actually reads — so that a change to the API's internals does not silently change the shape
 * of a file the user has already built a spreadsheet against.
 */

import type { Evidence } from '@han/shared/evidence';
import type { StepStatus } from '@han/shared/status';

export type ExportValue = string | number | boolean | null;

/** Verification as the export needs it: three-valued checks, kept three-valued. */
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
}

export interface ExportRowInput {
  /**
   * The row's status. Separate from `outcome.status` on purpose: a row that was skipped,
   * errored, or never reached has a status but no outcome at all, and the export still owes
   * the user that cell.
   */
  status: StepStatus;
  outcome: OutcomeView | null;
  /** The best candidate, already chosen. Null when the run found nothing. */
  top: Evidence | null;
  matchKind?: 'full' | 'partial' | 'ambiguous' | 'none' | null;
  normalizedQuery?: string | null;
  reading?: string | null;
  costUsd?: number | null;
  latencyMs?: number | null;
  model?: string | null;
}

/** One row of the user's file, as read. */
export interface SourceRow {
  /** Zero-based position in the file, excluding the XLSX header row. */
  index: number;
  values: Record<string, unknown>;
}
