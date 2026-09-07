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
  /**
   * True when the input was recognised as reordered (§7.3). Its line structure is then NOT the
   * poem's line structure — a transposed 4x10 grid has ten characters per row for a 五言 poem
   * with five — so comparing the two shapes reports a false failure on a correct answer. The
   * candidate's own form is still checked; only the input-shape comparison abstains.
   */
  inputReordered = false,
): Verification {
  const inputForm = analyseForm(inputLines);
  const candidateForm = analyseForm(candidateLines);
  const checks: Check[] = [];

  const formOk = inputReordered ? true : formCompatible(inputForm, candidateForm);
  checks.push({
    name: 'form',
    outcome:
      inputReordered || inputForm.lineLength === null || candidateForm.lineLength === null
        ? 'abstain'
        : formOk
          ? 'pass'
          : 'fail',
    detail: inputReordered
      ? `${FORM_LABEL[candidateForm.form]} — the input was reordered, so its line shape says nothing about the poem's`
      : formOk
      ? `${FORM_LABEL[candidateForm.form]} — ${candidateForm.lineLength ?? '?'} characters per line, matching the input`
      : `${FORM_LABEL[candidateForm.form]} has ${candidateForm.lineLength} characters per line but the input has ${inputForm.lineLength}`,
  });

  // Tone and rhyme rules only bind regulated verse. Applying them to 古詩 or 詞 would produce
  // failures that say nothing about whether the candidate is the right poem.
  if (isRegulated(candidateForm.form)) {
    // RHYME can reject — but not for 排律. `analyseForm` calls any uniform 5- or 7-character
    // poem of more than eight lines 排律, and in this corpus most of those are 古詩. Measured
    // over 25,000 poems (scripts/prosody-calibration.ts, ADR 011): rhyme fails on 10% of
    // 五排 and 72% of 七排, against 1-3% for 絕句 and 律詩. The bucket is a shape guess, so a
    // failure inside it is evidence about the guess, not about the match.
    const shapeGuess = candidateForm.form === 'wupai' || candidateForm.form === 'qipai';
    const rhyme = checkRhyme(candidateLines);
    checks.push({
      name: 'rhyme',
      outcome: shapeGuess ? 'abstain' : outcomeOf(rhyme.consistent),
      detail: shapeGuess
        ? `${rhyme.reason} — but a poem of this shape may be 古詩 rather than ${FORM_LABEL[candidateForm.form]}, so this decides nothing`
        : rhyme.reason,
    });

    // TONE NEVER REJECTS, and this is the important line in the file.
    //
    // 平仄 is computed from the candidate ALONE. Two different 七言律詩 both have clean 平仄,
    // so the check cannot tell them apart — it can only say whether this candidate is
    // well-formed regulated verse, which is a fact about the poem and not about the match.
    //
    // The corpus agrees: over 25,000 poems, 22% of everything the shape classifier calls
    // regulated FAILS its own tone check (6% of 七絕 up to 81% of 七排) — all of them correct
    // answers by construction. A `fail` that fires on a fifth of correct answers is worse
    // than no check, because a column of failures beside a column of correct titles teaches
    // the reader to ignore it. §16 agrees too: it asks that the "form/rhyme checker" reject a
    // mismatched candidate, and does not name tone.
    //
    // A PASS still corroborates, and the detail still reports what was found.
    const tone = checkTone(candidateLines);
    checks.push({
      name: 'tone',
      outcome: tone.consistent === true ? 'pass' : 'abstain',
      detail:
        tone.consistent === false
          ? `${tone.reason} — which makes this 古體, not a different poem`
          : tone.reason,
    });
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
