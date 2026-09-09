import { describe, expect, it } from 'vitest';
import { DEFAULT_COLUMNS, EXPORT_COLUMNS, headerFor, resolveColumns } from './export-schema.js';

describe('resolveColumns', () => {
  it('falls back to the defaults', () => {
    expect(resolveColumns(undefined)).toEqual([...DEFAULT_COLUMNS]);
  });

  it('adds han_status back even when the caller leaves it out', () => {
    expect(resolveColumns(['title', 'author'])).toContain('status');
  });

  it('cannot be talked out of it by an empty selection', () => {
    expect(resolveColumns([])).toEqual(['status']);
  });

  it('drops unknown keys instead of writing empty columns for them', () => {
    expect(resolveColumns(['title', 'nonsense'])).toEqual(['status', 'title']);
  });

  it('orders by the schema, not by the request', () => {
    expect(resolveColumns(['author', 'title', 'status'])).toEqual(['status', 'title', 'author']);
  });

  it('prefixes headers so nothing collides with the user own columns', () => {
    expect(headerFor('author')).toBe('han_author');
  });

  it('has exactly one locked column', () => {
    expect(EXPORT_COLUMNS.filter((c) => c.locked).map((c) => c.key)).toEqual(['status']);
  });

  it('keeps wide columns off by default so the sheet stays readable', () => {
    expect(EXPORT_COLUMNS.filter((c) => c.wide).every((c) => !c.byDefault)).toBe(true);
  });

  it('has no duplicate keys', () => {
    const keys = EXPORT_COLUMNS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
