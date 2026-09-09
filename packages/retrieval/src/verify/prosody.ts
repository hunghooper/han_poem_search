/**
 * Tone and rhyme verification — the spec §10.1.
 *
 * The tables are DERIVED FROM THE CORPUS (see packages/corpus/src/build-prosody.ts and
 * ADR 007), because the corpus ships no 平水韻 table. That makes them a description of what
 * this corpus does, not an authority on what classical Chinese is — which is the correct
 * standard here, since what we are verifying is a candidate drawn from this same corpus.
 *
 * Everything in this module is written to ABSTAIN rather than guess. A verifier that returns
 * "fails" when it simply lacks data is worse than no verifier: it would reject correct answers
 * for characters the tables never saw, and the confidence policy would quietly downgrade them.
 */

import { msg, type TraceMsg } from '@han/shared/trace';
import prosody from '../data/prosody.json' with { type: 'json' };

export type Tone = 'ping' | 'ze' | 'either' | 'unknown';

const TONE_TABLE = prosody.tone as Record<string, { ping: number; ze: number }>;
const RHYME_TABLE = prosody.rhyme as Record<string, number>;

/** How lopsided the counts must be before a character is called one tone rather than 多音. */
const TONE_DOMINANCE = 0.9;

export function toneOf(ch: string): Tone {
  const t = TONE_TABLE[ch];
  if (!t) return 'unknown';
  const total = t.ping + t.ze;
  if (total === 0) return 'unknown';
  if (t.ping / total >= TONE_DOMINANCE) return 'ping';
  if (t.ze / total >= TONE_DOMINANCE) return 'ze';
  // 多音字 — 看, 過, 望 and many others genuinely take either tone depending on sense.
  // Collapsing them to a majority would make the tone check reject correct regulated verse.
  return 'either';
}

export function rhymeGroupOf(ch: string): number | null {
  return RHYME_TABLE[ch] ?? null;
}

export interface RhymeCheck {
  /** null when there was not enough data to judge — never conflated with a failure. */
  consistent: boolean | null;
  rhymeChars: string[];
  groups: Array<number | null>;
  reason: string;
  /** The same reason, renderable in the reader's language. */
  trace: TraceMsg;
}

/**
 * Do the even-numbered lines rhyme?
 *
 * `lines` are 句 in match form, in poem order, 0-indexed — so the rhyming positions are the
 * ODD indices (line 2, 4, 6, 8 in the traditional 1-based reading).
 */
export function checkRhyme(lines: readonly string[]): RhymeCheck {
  const rhymeChars: string[] = [];
  for (let i = 1; i < lines.length; i += 2) {
    const ch = lines[i]?.slice(-1);
    if (ch) rhymeChars.push(ch);
  }

  if (rhymeChars.length < 2) {
    return {
      consistent: null,
      rhymeChars,
      groups: [],
      reason: 'fewer than two rhyme positions — nothing to compare',
      trace: msg('trace.rhyme.tooFew'),
    };
  }

  const groups = rhymeChars.map((c) => rhymeGroupOf(c));
  const known = groups.filter((g): g is number => g !== null);

  if (known.length < 2) {
    return {
      consistent: null,
      rhymeChars,
      groups,
      reason: 'rhyme characters are not in the derived table — cannot judge',
      trace: msg('trace.rhyme.notInTable'),
    };
  }

  const first = known[0]!;
  const consistent = known.every((g) => g === first);
  return {
    consistent,
    rhymeChars,
    groups,
    reason: consistent
      ? `rhyme characters ${rhymeChars.join('、')} share a derived 韻部`
      : `rhyme characters ${rhymeChars.join('、')} fall in different derived 韻部`,
    trace: msg(consistent ? 'trace.rhyme.share' : 'trace.rhyme.differ', {
      chars: rhymeChars.join('、'),
    }),
  };
}

export interface ToneCheck {
  consistent: boolean | null;
  /** Positions that violate the alternation, as [lineIndex, charIndex]. */
  violations: Array<[number, number]>;
  coverage: number;
  reason: string;
  /** The same reason, renderable in the reader's language. */
  trace: TraceMsg;
}

/**
 * The 二四六分明 rule: within a line, the tones at positions 2, 4 and 6 (1-based) alternate,
 * and between the two lines of a couplet they are opposed (對). Positions 1, 3, 5 are free —
 * 一三五不論 — so checking them would reject correct verse.
 *
 * This is the workable subset of 平仄. The full rules include 拗救, where a deliberate
 * violation is repaired elsewhere in the couplet; a checker that does not model 拗救 must not
 * treat a single violation as disqualifying, which is why this reports a count and coverage
 * rather than a verdict the caller might read as proof.
 */
export function checkTone(lines: readonly string[]): ToneCheck {
  const positions = [1, 3, 5]; // 0-indexed 2nd, 4th, 6th characters
  const violations: Array<[number, number]> = [];
  let compared = 0;
  let known = 0;

  for (let i = 0; i + 1 < lines.length; i += 2) {
    const a = lines[i]!;
    const b = lines[i + 1]!;
    for (const p of positions) {
      if (p >= a.length || p >= b.length) continue;
      const ta = toneOf(a[p]!);
      const tb = toneOf(b[p]!);
      compared += 1;
      if (ta === 'unknown' || tb === 'unknown') continue;
      known += 1;
      // 'either' satisfies any requirement — that is what makes a character 多音.
      if (ta === 'either' || tb === 'either') continue;
      if (ta === tb) violations.push([i, p]);
    }
  }

  const coverage = compared === 0 ? 0 : known / compared;
  if (known < 3) {
    return {
      consistent: null,
      violations,
      coverage,
      reason: 'too few characters found in the derived tone table to judge',
      trace: msg('trace.tone.tooFew'),
    };
  }

  // One violation is normal in real regulated verse (拗救). Two or more in a short poem is not.
  const consistent = violations.length <= 1;
  return {
    consistent,
    violations,
    coverage,
    reason: consistent
      ? `平仄 alternation holds at 二四六 (${violations.length} exception, ${(coverage * 100).toFixed(0)}% coverage)`
      : `平仄 alternation broken at ${violations.length} positions (${(coverage * 100).toFixed(0)}% coverage)`,
    trace: msg(consistent ? 'trace.tone.clean' : 'trace.tone.broken', {
      n: violations.length,
      coverage: (coverage * 100).toFixed(0),
    }),
  };
}

/** Table sizes, so a caller can report honestly how much evidence exists. */
export const prosodyStats = (): { toneChars: number; rhymeChars: number; builtAt: string } => ({
  toneChars: Object.keys(TONE_TABLE).length,
  rhymeChars: Object.keys(RHYME_TABLE).length,
  builtAt: (prosody as { $builtAt?: string }).$builtAt ?? 'unknown',
});
