/**
 * Read a real file, write a real file, read it back.
 *
 * The readers and writers are the part where a mistake is invisible in review and obvious to
 * the user — a lost column, a shifted row, a Chinese character mangled by an encoding default.
 * So these tests go through the filesystem rather than mocking it.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { JsonlWriter, countJsonlRows, readJsonl } from './jsonl.js';
import { XlsxWriter, xlsxToJsonl } from './xlsx.js';
import { scanColumns } from './columns.js';

const dir = mkdtempSync(join(tmpdir(), 'han-batch-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const collect = async <T>(gen: AsyncGenerator<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
};

describe('jsonl', () => {
  const path = join(dir, 'in.jsonl');
  writeFileSync(
    path,
    [
      '{"id":"r1","poem":"床前明月光"}',
      '',
      '{"id":"r2","poem":"春眠不覺曉"}',
      'not json at all',
      '{"id":"r4","poem":"羣峭碧摩天"}',
    ].join('\n'),
    'utf8',
  );

  it('skips blank lines but keeps every record', async () => {
    const rows = await collect(readJsonl(path));
    expect(rows).toHaveLength(4);
    expect(rows[0]!.values.poem).toBe('床前明月光');
  });

  // A malformed line is neither skipped nor fatal. Skipping would shift every later index and
  // quietly shorten the output; throwing on line 40,000 would discard the work already done.
  it('reports a malformed line in place, without shifting the rows after it', async () => {
    const rows = await collect(readJsonl(path));
    expect(rows[2]!.parseError).toBeDefined();
    expect(rows[2]!.index).toBe(2);
    expect(rows[3]!.values.id).toBe('r4');
    expect(rows[3]!.index).toBe(3);
  });

  it('counts rows without parsing them', async () => {
    expect(await countJsonlRows(path)).toBe(4);
  });

  it('honours a limit, for the scan', async () => {
    expect(await collect(readJsonl(path, { limit: 2 }))).toHaveLength(2);
  });

  // Nested under `han` rather than prefixed and flattened: a file that already has an `author`
  // column keeps it, and ours sits beside it instead of overwriting it.
  it('writes results beside the original keys without colliding', async () => {
    const out = join(dir, 'out.jsonl');
    const w = new JsonlWriter(out);
    await w.write({ id: 'r1', author: 'ghi chú của tôi' }, { status: 'has_result', author: '李白' });
    await w.close();

    const [row] = await collect(readJsonl(out));
    expect(row!.values.author).toBe('ghi chú của tôi');
    expect((row!.values.han as Record<string, unknown>).author).toBe('李白');
  });
});

describe('xlsx', () => {
  it('converts a workbook to JSONL with headers and Chinese text intact', async () => {
    const path = join(dir, 'in.xlsx');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('data');
    ws.addRow(['id', 'poem', '', 'note']);
    ws.addRow(['r1', '床前明月光', 'x', 'album']);
    ws.addRow(['r2', '春眠不覺曉', 'y', '']);
    await wb.xlsx.writeFile(path);

    const jsonl = join(dir, 'in.converted.jsonl');
    const conv = await xlsxToJsonl(path, jsonl);

    // A blank header still gets a name: a column the picker cannot list is a column the user
    // cannot choose, and dropping it silently would hide the one they wanted.
    expect(conv.headers).toEqual(['id', 'poem', 'column_3', 'note']);
    expect(conv.total).toBe(2);

    const rows = await collect(readJsonl(jsonl));
    expect(rows).toHaveLength(2);
    // The regression this whole design exists for: the streaming reader returned
    // { sharedString: 0 } here, which reads as "no Chinese in this column" and would make the
    // scan abstain on a file that is nothing but poetry.
    expect(rows[0]!.values.poem).toBe('床前明月光');
    expect(rows.map((r) => r.index)).toEqual([0, 1]);

    expect(scanColumns(rows.map((r) => r.values), conv.headers).suggested).toBe('poem');
  });

  it('reads rich text, which hand-marked-up files are full of', async () => {
    const p = join(dir, 'rich.xlsx');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('data');
    ws.addRow(['poem']);
    ws.getCell('A2').value = {
      richText: [{ text: '床前', font: { bold: true } }, { text: '明月光' }],
    };
    await wb.xlsx.writeFile(p);

    const out = join(dir, 'rich.jsonl');
    await xlsxToJsonl(p, out);
    const rows = await collect(readJsonl(out));
    expect(rows[0]!.values.poem).toBe('床前明月光');
  });

  it('keeps an interior blank row so indexes stay aligned with the user file', async () => {
    const p = join(dir, 'gap.xlsx');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('data');
    ws.addRow(['poem']);
    ws.addRow(['床前明月光']);
    ws.addRow([null]);
    ws.addRow(['春眠不覺曉']);
    await wb.xlsx.writeFile(p);

    const out = join(dir, 'gap.jsonl');
    const conv = await xlsxToJsonl(p, out);
    expect(conv.total).toBe(3);
    const rows = await collect(readJsonl(out));
    expect(rows[2]!.values.poem).toBe('春眠不覺曉');
    expect(rows[2]!.index).toBe(2);
  });

  it('appends our columns to the user own and reads back aligned', async () => {
    const out = join(dir, 'out.xlsx');
    const w = new XlsxWriter(out, ['id', 'poem'], ['han_status', 'han_author']);
    w.write({ id: 'r1', poem: '床前明月光' }, ['has_result', '李白']);
    w.write({ id: 'r2', poem: '春眠不覺曉' }, ['no_result', null]);
    await w.close();

    const back = join(dir, 'out.jsonl');
    const conv = await xlsxToJsonl(out, back);
    expect(conv.headers).toEqual(['id', 'poem', 'han_status', 'han_author']);

    const rows = await collect(readJsonl(back));
    expect(rows[0]!.values).toMatchObject({ id: 'r1', han_status: 'has_result', han_author: '李白' });
    // Null must stay empty, not become the string "null" — a cell reading "null" would be
    // filtered as a value.
    expect(rows[1]!.values.han_author).toBeNull();
  });
});
