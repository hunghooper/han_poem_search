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

  it('leaves an empty cell alone', () => {
    expect(isSettled(StepStatus.SKIPPED)).toBe(true);
  });

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

describe('the agent reports its non-participation into the outcome', () => {
  it('has a distinct derived flag for each reason', () => {
    expect(flag('model', StepStatus.UNAVAILABLE)).toBe('model_unavailable');
    expect(flag('model', StepStatus.SKIPPED)).toBe('model_skipped');
  });

  it('does not let "switched off" and "could not run" collapse', () => {
    expect(flag('model', StepStatus.SKIPPED)).not.toBe(flag('model', StepStatus.UNAVAILABLE));
  });
});

describe('agent evidence reaches the run status', () => {
  it('is answer-carrying, so identity columns are not blanked', () => {
    expect(agentStatusOf(out({ evidence: [{ id: 'x' }] as never }))).toBe(StepStatus.HAS_RESULT);
    const row = buildRow(
      {
        status: StepStatus.LOW_CONFIDENCE,
        outcome: null,
        top: { title: 'T', author: 'A' } as never,
      },
      ['title', 'author'],
    );
    expect(row.title).toBe('T');
    expect(row.author).toBe('A');
  });

  it('still blanks identity when nothing was found at all', () => {
    const row = buildRow(
      { status: StepStatus.NO_RESULT, outcome: null, top: { title: 'T' } as never },
      ['title'],
    );
    expect(row.title).toBeNull();
  });
});

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

describe('every poem form has a Vietnamese name', () => {
  it('covers the whole vocabulary the verifier can emit', () => {
    for (const form of Object.keys(FORM_LABEL)) {
      expect(FORM_LABEL_VI[form], `no Vietnamese name for "${form}"`).toBeDefined();
    }
  });

  it('falls back to the code rather than to nothing', () => {
    expect(formLabelVi('a_form_nobody_added')).toBe('a_form_nobody_added');
    expect(formLabelVi(null)).toBeNull();
  });
});
