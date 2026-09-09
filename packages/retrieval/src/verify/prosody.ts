import { msg, type TraceMsg } from '@han/shared/trace';
import prosody from '../data/prosody.json' with { type: 'json' };

export type Tone = 'ping' | 'ze' | 'either' | 'unknown';

const TONE_TABLE = prosody.tone as Record<string, { ping: number; ze: number }>;
const RHYME_TABLE = prosody.rhyme as Record<string, number>;

const TONE_DOMINANCE = 0.9;

export function toneOf(ch: string): Tone {
  const t = TONE_TABLE[ch];
  if (!t) return 'unknown';
  const total = t.ping + t.ze;
  if (total === 0) return 'unknown';
  if (t.ping / total >= TONE_DOMINANCE) return 'ping';
  if (t.ze / total >= TONE_DOMINANCE) return 'ze';
  return 'either';
}

export function rhymeGroupOf(ch: string): number | null {
  return RHYME_TABLE[ch] ?? null;
}

export interface RhymeCheck {
  consistent: boolean | null;
  rhymeChars: string[];
  groups: Array<number | null>;
  reason: string;
  trace: TraceMsg;
}

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
  violations: Array<[number, number]>;
  coverage: number;
  reason: string;
  trace: TraceMsg;
}

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

export const prosodyStats = (): { toneChars: number; rhymeChars: number; builtAt: string } => ({
  toneChars: Object.keys(TONE_TABLE).length,
  rhymeChars: Object.keys(RHYME_TABLE).length,
  builtAt: (prosody as { $builtAt?: string }).$builtAt ?? 'unknown',
});
