import { describe, expect, it } from 'vitest';
import { StepStatus } from '@han/shared/status';
import { flag } from '@han/shared/flags';
import type { AgentRunOutput } from '@han/worker/shared';
import { agentStatusOf } from './search.js';
import { isSettled } from './batch-runner.js';
import { buildRow } from '@han/batch/row';
import { FORM_LABEL_VI, formLabelVi } from '@han/batch/form-label';
import { FORM_LABEL } from '@han/retrieval/verify/form';

const out = (over: Partial<AgentRunOutput>): AgentRunOutput => ({
  evidence: [],
  flags: [],
  stoppedBecause: 'model_finished',
  partial: false,
  iterations: 1,
  ...over,
});

describe('agentStatusOf', () => {
  it('reports found evidence as HAS_RESULT whatever ended the loop', () => {
    expect(
      agentStatusOf(out({ evidence: [{ id: 'x' }] as never, stoppedBecause: 'budget_exhausted' })),
    ).toBe(StepStatus.HAS_RESULT);
  });

  // The four below are the whole point of the function. §5 calls collapsing them the most
  // damaging mistake available: only NO_RESULT means "the corpus does not have it", and the
  // other three each point at a different fix — a broken gateway, a missing tool, a budget
  // that was too small. A live durability run reported a worker with no gateway key as
  // "budget exhausted", and the misconfiguration read as a run that merely needed longer.
  it('separates a model failure from finding nothing', () => {
    expect(agentStatusOf(out({ stoppedBecause: 'model_failed' }))).toBe(StepStatus.ERROR);
  });

  it('separates having no tool to try from finding nothing', () => {
    expect(agentStatusOf(out({ stoppedBecause: 'no_tools_available' }))).toBe(StepStatus.SKIPPED);
  });

  it('separates running out of budget from finding nothing', () => {
    expect(agentStatusOf(out({ stoppedBecause: 'budget_exhausted' }))).toBe(
      StepStatus.LOW_CONFIDENCE,
    );
  });

  it('reports an empty-handed but healthy agent as NO_RESULT', () => {
    expect(agentStatusOf(out({ stoppedBecause: 'model_finished' }))).toBe(StepStatus.NO_RESULT);
  });
});

describe('isSettled — what a re-run leaves alone', () => {
  it('leaves a match alone', () => {
    expect(isSettled(StepStatus.HAS_RESULT)).toBe(true);
  });

  // An empty cell will never resolve, however much agent is thrown at it. Counting those rows
  // as pending inflates every estimate — on a file with many blanks, by a lot — and quotes for
  // work that returns immediately.
  it('leaves an empty cell alone', () => {
    expect(isSettled(StepStatus.SKIPPED)).toBe(true);
  });

  // The whole point of the cheap-then-escalate workflow: these are the rows a second pass with
  // the agent exists to attempt.
  it('retries anything the corpus could not settle', () => {
    for (const s of [
      StepStatus.NO_RESULT,
      StepStatus.LOW_CONFIDENCE,
      StepStatus.ERROR,
      StepStatus.TIMEOUT,
      StepStatus.UNAVAILABLE,
      StepStatus.NOT_EXECUTED,
    ]) {
      expect(isSettled(s)).toBe(false);
    }
  });
});

/**
 * FOUND ON REAL DATA. A 14,519-row batch ran with the agent switched on and a $100 cap. The
 * gateway was not configured, so every one of those runs emitted an `agent / unavailable`
 * event saying so — and the exported spreadsheet carried no sign of it, because the branch
 * emitted an event without adding a flag to the outcome. Nobody opens 14,519 traces; the file
 * is the only thing that gets read, and `flags` is the only channel into it.
 */
describe('the agent reports its non-participation into the outcome', () => {
  it('has a distinct derived flag for each reason', () => {
    expect(flag('model', StepStatus.UNAVAILABLE)).toBe('model_unavailable');
    expect(flag('model', StepStatus.SKIPPED)).toBe('model_skipped');
  });

  // Switched off is a choice the user made; unavailable is a promise the system broke. They
  // must not look the same in a spreadsheet column someone filters on.
  it('does not let "switched off" and "could not run" collapse', () => {
    expect(flag('model', StepStatus.SKIPPED)).not.toBe(flag('model', StepStatus.UNAVAILABLE));
  });
});

/**
 * REPORTED FROM A REAL BATCH. "The model sets the has_result flag, but I don't see the form,
 * title and author columns filled."
 *
 * The run's status was the LOCAL layer's verdict, computed before the agent ran and never
 * updated. So a row where the corpus found nothing and the agent then found the poem carried
 * `model_has_result` with the agent's evidence attached — and a status of `no_result`. The
 * export blanks identity for a row that says it found nothing, correctly, given what it was
 * handed. Four rows in the first hundred looked like this.
 */
describe('agent evidence reaches the run status', () => {
  // Not HAS_RESULT. A model-sourced answer has not been matched against the corpus, and this
  // system does not promote an unverified claim to a confident one. LOW_CONFIDENCE is exactly
  // "here is a candidate, look at it" — and it is answer-carrying, so the columns fill.
  it('is answer-carrying, so identity columns are not blanked', () => {
    expect(agentStatusOf(out({ evidence: [{ id: 'x' }] as never }))).toBe(StepStatus.HAS_RESULT);
    const row = buildRow(
      { status: StepStatus.LOW_CONFIDENCE, outcome: null, top: { title: 'T', author: 'A' } as never },
      ['title', 'author'],
    );
    expect(row.title).toBe('T');
    expect(row.author).toBe('A');
  });

  // The other half: a run that genuinely found nothing still blanks them.
  it('still blanks identity when nothing was found at all', () => {
    const row = buildRow(
      { status: StepStatus.NO_RESULT, outcome: null, top: { title: 'T' } as never },
      ['title'],
    );
    expect(row.title).toBeNull();
  });
});

/**
 * FOUND IN AN EXPORT. Rows flagged `model_has_result` carried a title and an author but an
 * empty `han_form` and `han_form_label`.
 *
 * The cause was ordering, not the columns. Rule verification ran on the LOCAL candidate, before
 * the agent had its turn — so when the corpus found nothing and the agent supplied the answer
 * there was no verification at all, and the form columns went out blank on exactly the rows a
 * reader most wants them. Worse, when the corpus DID produce a candidate that the confidence
 * policy then rejected, the agent's answer was prepended in front of it while the form still
 * described the rejected poem: a form belonging to one poem beside the title of another.
 *
 * These test the two ends the fix has to hold together — that a form derived from an outside
 * poem still reaches the row, and that the columns stay gated on the row having an answer.
 */
describe('form columns on a model-sourced answer', () => {
  const verification = {
    outcome: 'pass',
    checks: [],
    candidateForm: { form: 'qijue' },
  } as never;

  it('carries the form of the poem that is actually being returned', () => {
    const row = buildRow(
      {
        status: StepStatus.LOW_CONFIDENCE,
        outcome: { verification } as never,
        top: { title: 'T', author: 'A' } as never,
      },
      ['title', 'form', 'form_label'],
    );
    expect(row.title).toBe('T');
    expect(row.form).toBe('qijue');
    expect(row.form_label).toBe('thất ngôn tứ tuyệt');
  });

  /**
   * A form with no poem beside it is a fact about nothing. Note the verification is PRESENT
   * here: a candidate the confidence policy rejected still has a real form analysis attached,
   * and the row must stay blank on the strength of its status alone.
   */
  it('stays blank when the run found nothing to describe', () => {
    const row = buildRow(
      {
        status: StepStatus.NO_RESULT,
        outcome: { verification } as never,
        top: { title: 'T' } as never,
      },
      ['title', 'form', 'form_label'],
    );
    expect(row.title).toBeNull();
    expect(row.form).toBeNull();
    expect(row.form_label).toBeNull();
  });
});

/**
 * The Vietnamese form names live in packages/batch, which cannot import the verifier that
 * produces the codes — so nothing but this test stops the two drifting. apps/api is the one
 * package that sees both.
 */
describe('every poem form has a Vietnamese name', () => {
  it('covers the whole vocabulary the verifier can emit', () => {
    for (const form of Object.keys(FORM_LABEL)) {
      expect(FORM_LABEL_VI[form], `no Vietnamese name for "${form}"`).toBeDefined();
    }
  });

  // A code this table has not been taught prints as the code, not as a blank: a gap in the
  // table should look like a gap, where an empty cell reads as "this poem has no form".
  it('falls back to the code rather than to nothing', () => {
    expect(formLabelVi('a_form_nobody_added')).toBe('a_form_nobody_added');
    expect(formLabelVi(null)).toBeNull();
  });
});
