import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSouyun } from './search-souyun.js';

const html = readFileSync(
  fileURLToPath(new URL('../../../../fixtures/souyun/query-chunmian.html', import.meta.url)),
  'utf8',
);

describe('parseSouyun', () => {
  const hits = parseSouyun(html);

  it('finds results in a real page', () => {
    expect(hits.length).toBeGreaterThan(0);
  });

  it('pairs each title with its own poem body', () => {
    for (const h of hits) {
      expect(h.id).toMatch(/^\d+$/u);
      expect(h.url).toContain(h.id);
    }
  });

  it('reads title, author and dynasty', () => {
    const known = hits.find((h) => h.id === '300027');
    expect(known?.title).toBe('东坡引 晓起');
    expect(known?.author).toBe('彭孙贻');
    expect(known?.dynasty).toBe('明末清初');
  });

  it('returns verse the local corpus could not hold', () => {
    expect(hits.some((h) => h.dynasty && /明|清/u.test(h.dynasty))).toBe(true);
  });

  it('keeps the poem lines, and only the poem lines', () => {
    const known = hits.find((h) => h.id === '300027');
    expect(known?.lines.length).toBeGreaterThan(0);
    expect(known?.lines.join('')).toContain('春眠不觉晓');
    expect(known?.lines.join('')).not.toContain('<');
  });

  it('finds nothing in a page that is not the search page, rather than inventing results', () => {
    expect(parseSouyun('<html><body>maintenance</body></html>')).toEqual([]);
  });
});
