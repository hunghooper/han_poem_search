import { describe, expect, it } from 'vitest';
import { parseVerdict } from './verify-llm.js';

describe('parseVerdict', () => {
  it('reads a bare object', () => {
    const v = parseVerdict('{"verdict":"sufficient","confidence":0.9,"gaps":[],"notes":"ok"}');
    expect(v?.verdict).toBe('sufficient');
    expect(v?.confidence).toBe(0.9);
  });

  it('reads it out of a markdown fence with prose around it', () => {
    const v = parseVerdict(
      'Here is my judgement:\n```json\n{"verdict":"insufficient","confidence":0.2,"notes":"a refusal"}\n```\nHope that helps.',
    );
    expect(v?.verdict).toBe('insufficient');
    expect(v?.notes).toBe('a refusal');
  });

  it('handles nested objects without stopping at the first brace', () => {
    const v = parseVerdict(
      '{"verdict":"conflicting","confidence":0.5,"gaps":["a","b"],"notes":"x"}',
    );
    expect(v?.gaps).toEqual(['a', 'b']);
  });

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

describe('the optional proposal', () => {
  it('is read when present and well formed', () => {
    const v = parseVerdict(
      '{"verdict":"sufficient","confidence":0.9,"propose":{"title":"東坡引","author":"彭孫貽","text":"綺窗紅日皦","source_url":"https://sou-yun.cn/x"}}',
    );
    expect(v?.propose?.title).toBe('東坡引');
    expect(v?.propose?.author).toBe('彭孫貽');
  });

  it('is absent on an ordinary verdict', () => {
    expect(parseVerdict('{"verdict":"insufficient","confidence":0.2}')?.propose).toBeUndefined();
  });

  it('refuses a proposal missing an author', () => {
    expect(
      parseVerdict('{"verdict":"sufficient","confidence":1,"propose":{"title":"x","text":"y"}}'),
    ).toBeNull();
  });
});
