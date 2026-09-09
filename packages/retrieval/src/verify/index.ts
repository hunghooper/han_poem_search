import { msg, type TraceMsg } from '@han/shared/trace';
import { AggregateFlag } from '@han/shared/flags';
import { analyseForm, formCompatible, isRegulated, type FormAnalysis, FORM_LABEL } from './form.js';
import { checkRhyme, checkTone } from './prosody.js';

export type CheckOutcome = 'pass' | 'fail' | 'abstain';

export interface Check {
  name: 'form' | 'rhyme' | 'tone';
  outcome: CheckOutcome;
  detail: string;
  trace: TraceMsg;
}

export interface Verification {
  outcome: CheckOutcome;
  checks: Check[];
  inputForm: FormAnalysis;
  candidateForm: FormAnalysis;
  flags: string[];
  summary: string;
  summaryTrace: TraceMsg;
}

const outcomeOf = (b: boolean | null): CheckOutcome =>
  b === null ? 'abstain' : b ? 'pass' : 'fail';

export function verifyCandidate(
  inputLines: readonly string[],
  candidateLines: readonly string[],
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
    trace: inputReordered
      ? msg('trace.verify.formReordered', { form: FORM_LABEL[candidateForm.form] })
      : formOk
        ? msg('trace.verify.formMatches', {
            form: FORM_LABEL[candidateForm.form],
            n: candidateForm.lineLength ?? '?',
          })
        : msg('trace.verify.formDiffers', {
            form: FORM_LABEL[candidateForm.form],
            n: candidateForm.lineLength ?? '?',
            input: inputForm.lineLength ?? '?',
          }),
  });

  if (isRegulated(candidateForm.form)) {
    const shapeGuess = candidateForm.form === 'wupai' || candidateForm.form === 'qipai';
    const rhyme = checkRhyme(candidateLines);
    checks.push({
      name: 'rhyme',
      outcome: shapeGuess ? 'abstain' : outcomeOf(rhyme.consistent),
      detail: shapeGuess
        ? `${rhyme.reason} — but a poem of this shape may be 古詩 rather than ${FORM_LABEL[candidateForm.form]}, so this decides nothing`
        : rhyme.reason,
      trace: shapeGuess
        ? msg('trace.verify.shapeGuess', { form: FORM_LABEL[candidateForm.form] }, [rhyme.trace])
        : rhyme.trace,
    });

    const tone = checkTone(candidateLines);
    checks.push({
      name: 'tone',
      outcome: tone.consistent === true ? 'pass' : 'abstain',
      detail:
        tone.consistent === false
          ? `${tone.reason} — which makes this 古體, not a different poem`
          : tone.reason,
      trace:
        tone.consistent === false ? msg('trace.verify.toneBroken', {}, [tone.trace]) : tone.trace,
    });
  } else {
    checks.push({
      name: 'rhyme',
      outcome: 'abstain',
      detail: `${FORM_LABEL[candidateForm.form]} is not regulated verse — rhyme and tone rules do not apply`,
      trace: msg('trace.verify.notRegulated', { form: FORM_LABEL[candidateForm.form] }),
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
    summaryTrace:
      outcome === 'fail'
        ? msg(
            'trace.verify.failed',
            {},
            failed.map((c) => c.trace),
          )
        : outcome === 'pass'
          ? msg(
              'trace.verify.passed',
              {},
              passed.map((c) => c.trace),
            )
          : msg('trace.verify.abstained'),
  };
}

export { AggregateFlag };
