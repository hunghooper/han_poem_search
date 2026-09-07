import { describe, expect, it } from 'vitest';
import { detect } from './detect.js';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('detect', () => {
  it('accepts JSONL', () => {
    expect(detect(bytes('{"a":1}\n{"a":2}\n'))).toEqual({ ok: true, kind: 'jsonl' });
  });

  it('accepts a UTF-8 BOM, which Excel writes and users cannot see', () => {
    expect(detect(bytes('﻿{"a":1}\n{"a":2}\n')).ok).toBe(true);
  });

  it('recognises xlsx by its zip magic, not its extension', () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    expect(detect(zip)).toEqual({ ok: true, kind: 'xlsx' });
  });

  // Each of these is a real thing users hand over, and each needs its own sentence back. A
  // single "unsupported file" would leave them with no idea what to do next — the difference
  // between "convert it", "fix line 3" and "this format is not supported at all".
  it('tells a legacy .xls apart from an .xlsx', () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]);
    const d = detect(ole);
    expect(d.ok).toBe(false);
    expect(d.ok === false && d.reason).toBe('xls_legacy');
    expect(d.ok === false && d.message).toMatch(/Save As/u);
  });

  it('tells a JSON array apart from JSONL', () => {
    const d = detect(bytes('[{"a":1},\n{"a":2}]\n'));
    expect(d.ok === false && d.reason).toBe('json_array');
  });

  it('tells pretty-printed JSON apart from JSONL', () => {
    const d = detect(bytes('{\n  "a": 1\n}\n'));
    expect(d.ok === false && d.reason).toBe('json_array');
  });

  it('tells CSV apart rather than trying to parse it', () => {
    const d = detect(bytes('a,b,c\n1,2,3\n4,5,6\n'));
    expect(d.ok === false && d.reason).toBe('csv_like');
  });

  it('rejects UTF-16 instead of decoding it into mojibake', () => {
    // Mojibake would not throw. It would search for characters that match nothing and report
    // every row as no_result — a wrong answer that looks like a real one.
    const utf16 = new Uint8Array([0xff, 0xfe, 0x7b, 0x00, 0x22, 0x00]);
    const d = detect(utf16);
    expect(d.ok === false && d.reason).toBe('not_utf8');
  });

  it('rejects invalid UTF-8 rather than substituting replacement characters', () => {
    const d = detect(new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]));
    expect(d.ok === false && d.reason).toBe('not_utf8');
  });

  it('reports an empty file as empty', () => {
    const d = detect(new Uint8Array([]));
    expect(d.ok === false && d.reason).toBe('empty');
  });

  it('names the offending line when JSONL goes wrong partway', () => {
    const d = detect(bytes('{"a":1}\nnot json\n{"a":3}\n'));
    expect(d.ok).toBe(false);
    expect(d.ok === false && d.message).toMatch(/Line 2/u);
  });

  it('does not judge a single record truncated by the sniff window', () => {
    // The window ends mid-record on a large first row. Guessing "malformed" here would reject
    // a perfectly good file.
    const d = detect(bytes('{"poem":"床前明月光'));
    expect(d.ok).toBe(true);
  });
});
