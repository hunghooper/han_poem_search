import { describe, expect, it } from 'vitest';
import { parseVerdict } from './verify-llm.js';

describe('parseVerdict', () => {
  it('reads a bare object', () => {
    const v = parseVerdict('{"verdict":"sufficient","confidence":0.9,"gaps":[],"notes":"ok"}');
    expect(v?.verdict).toBe('sufficient');
    expect(v?.confidence).toBe(0.9);
  });

  // Models fence JSON and introduce it. Both are normal and neither is an error.
  it('reads it out of a markdown fence with prose around it', () => {
    const v = parseVerdict(
      'Here is my judgement:\n```json\n{"verdict":"insufficient","confidence":0.2,"notes":"a refusal"}\n```\nHope that helps.',
    );
    expect(v?.verdict).toBe('insufficient');
    expect(v?.notes).toBe('a refusal');
  });

  it('handles nested objects without stopping at the first brace', () => {
    const v = parseVerdict('{"verdict":"conflicting","confidence":0.5,"gaps":["a","b"],"notes":"x"}');
    expect(v?.gaps).toEqual(['a', 'b']);
  });

  // A malformed verdict is not a verdict. Guessing at one would invent a judgement nobody
  // made, which is worse than reporting that verification did not happen.
  it('refuses anything that does not validate', () => {
    expect(parseVerdict('{"verdict":"maybe","confidence":0.5}')).toBeNull();
    expect(parseVerdict('{"verdict":"sufficient","confidence":7}')).toBeNull();
    expect(parseVerdict('no json here at all')).toBeNull();
    expect(parseVerdict('')).toBeNull();
    expect(parseVerdict(null)).toBeNull();
  });

  it('defaults the optional fields rather than failing on them', () => {
    const v = parseVerdict('{"verdict":"sufficient","confidence":1}');
    expect(v?.gaps).toEqual([]);
    expect(v?.notes).toBe('');
  });
});

/**
 * The judge may name a poem worth keeping. It may not write one in — the caller checks the
 * conditions and a person accepts the proposal, because a model that once counted its own
 * refusal as a finding does not get write access to what every later search reads.
 */
describe('the optional proposal', () => {
  it('is read when present and well formed', () => {
    const v = parseVerdict(
      '{"verdict":"sufficient","confidence":0.9,"propose":{"title":"東坡引","author":"彭孫貽","text":"綺窗紅日皦","source_url":"https://sou-yun.cn/x"}}',
    );
    expect(v?.propose?.title).toBe('東坡引');
    expect(v?.propose?.author).toBe('彭孫貽');
  });

  // Null is the normal answer and the safe one.
  it('is absent on an ordinary verdict', () => {
    expect(parseVerdict('{"verdict":"insufficient","confidence":0.2}')?.propose).toBeUndefined();
  });

  // A malformed proposal must not take the verdict down with it, nor slip through half-filled:
  // the schema refuses the whole object, and the caller sees no verdict rather than a bad one.
  it('refuses a proposal missing an author', () => {
    expect(
      parseVerdict('{"verdict":"sufficient","confidence":1,"propose":{"title":"x","text":"y"}}'),
    ).toBeNull();
  });
});
