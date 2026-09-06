/**
 * Rule-based verification — the spec §10.1.
 *
 * "Run rules first, and call the LLM only for what rules cannot decide." This domain permits
 * deterministic verification, which is far stronger than an LLM judge and costs nothing.
 *
 * The output distinguishes three states, and the third is the one that matters:
 *   pass    — the rules were applicable and were satisfied
 *   fail    — the rules were applicable and were violated
 *   abstain — the rules could not be applied
 *
 * Collapsing `abstain` into `fail` would reject correct answers for lack of data; collapsing
 * it into `pass` would claim verification that never happened. It is its own outcome.
 */

import { AggregateFlag } from '@han/shared/flags';
import { analyseForm, formCompatible, isRegulated, type FormAnalysis, FORM_LABEL } from './form.js';
import { checkRhyme, checkTone } from './prosody.js';

export type CheckOutcome = 'pass' | 'fail' | 'abstain';

export interface Check {
  name: 'form' | 'rhyme' | 'tone';
  outcome: CheckOutcome;
  detail: string;
}

export interface Verification {
  outcome: CheckOutcome;
  checks: Check[];
  inputForm: FormAnalysis;
  candidateForm: FormAnalysis;
  flags: string[];
  /** One sentence, written for the trace UI (§14.2). */
  summary: string;
}

const outcomeOf = (b: boolean | null): CheckOutcome => (b === null ? 'abstain' : b ? 'pass' : 'fail');

/**
 * Verify a candidate against the shape of what the user pasted.
 *
 * `inputLines` and `candidateLines` are 句 in match form. The input is usually a fragment, so
 * the checks that depend on a complete poem run against the CANDIDATE — we are asking "is this
 * candidate a well-formed poem of the shape the fragment implies", not "is the fragment
 * well-formed", which it never is.
 */
export function verifyCandidate(
  inputLines: readonly string[],
  candidateLines: readonly string[],
): Verification {
  const inputForm = analyseForm(inputLines);
  const candidateForm = analyseForm(candidateLines);
  const checks: Check[] = [];

  const formOk = formCompatible(inputForm, candidateForm);
  checks.push({
    name: 'form',
    outcome: inputForm.lineLength === null || candidateForm.lineLength === null ? 'abstain' : formOk ? 'pass' : 'fail',
    detail: formOk
      ? `${FORM_LABEL[candidateForm.form]} — ${candidateForm.lineLength ?? '?'} characters per line, matching the input`
      : `${FORM_LABEL[candidateForm.form]} has ${candidateForm.lineLength} characters per line but the input has ${inputForm.lineLength}`,
  });

  // Tone and rhyme rules only bind regulated verse. Applying them to 古詩 or 詞 would produce
  // failures that say nothing about whether the candidate is the right poem.
  if (isRegulated(candidateForm.form)) {
    const rhyme = checkRhyme(candidateLines);
    checks.push({ name: 'rhyme', outcome: outcomeOf(rhyme.consistent), detail: rhyme.reason });

    const tone = checkTone(candidateLines);
    checks.push({ name: 'tone', outcome: outcomeOf(tone.consistent), detail: tone.reason });
  } else {
    checks.push({
      name: 'rhyme',
      outcome: 'abstain',
      detail: `${FORM_LABEL[candidateForm.form]} is not regulated verse — rhyme and tone rules do not apply`,
    });
  }

  const failed = checks.filter((c) => c.outcome === 'fail');
  const passed = checks.filter((c) => c.outcome === 'pass');
  const outcome: CheckOutcome = failed.length > 0 ? 'fail' : passed.length > 0 ? 'pass' : 'abstain';

  const flags: string[] = [];
  if (outcome === 'fail') flags.push('rule_verify_fail');

  return {
    outcome,
    checks,
    inputForm,
    candidateForm,
    flags,
    summary:
      outcome === 'fail'
        ? `Form check failed — ${failed.map((c) => c.detail).join('; ')}`
        : outcome === 'pass'
          ? `Form checks out — ${passed.map((c) => c.detail).join('; ')}`
          : 'Not enough structure to verify — the candidate was neither confirmed nor rejected',
  };
}

export { AggregateFlag };
