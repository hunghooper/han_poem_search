/**
 * XLSX in, XLSX out.
 *
 * **Reading is NOT streamed, and that is a measured decision.** exceljs ships a streaming
 * WorkbookReader, and it is the obvious choice at the stated scale — but it resolves a cell's
 * text against a shared-string table it may not have parsed yet, because it processes zip
 * entries in whatever order the file stores them. On a workbook exceljs itself wrote, every
 * text cell comes back as `{ sharedString: 0 }`. It also crashes outright when the sheet
 * precedes `workbook.xml`, dereferencing a `model` that is still undefined. A reader that
 * returns unresolved handles for Chinese text is not usable here: the column scan would see no
 * CJK anywhere and abstain on a file that is nothing but poetry.
 *
 * So an upload is converted once, in full, to an internal JSONL file, and everything after
 * that streams over JSONL — the scan, the run and the export all read one code path.
 *
 * MEASURED on this machine before choosing:
 *
 *   50,000 rows x 3 columns of poetry    1.0 MB file   0.7s   214 MB RSS
 *   200,000 rows x 12 unique columns    20.9 MB file   8.8s  1351 MB RSS
 *
 * The second is four times the scale the user asked for and still finishes in nine seconds, so
 * the spike is bounded and happens once, at upload, rather than during a run that must survive
 * a restart.
 *
 * Writing IS streamed — the streaming writer has no such problem, and an export is the one
 * place where row count really is unbounded.
 */

import ExcelJS from 'exceljs';
import { JsonlWriter } from './jsonl.js';
import type { ExportValue } from './types.js';

/**
 * A cell as a plain value.
 *
 * exceljs hands back rich text, hyperlinks, formula results and dates as objects. Poetry
 * arrives as a string or as rich text (a cell with mixed formatting — common in files people
 * have marked up by hand), and losing the rich-text case would read as an empty column for a
 * file that visibly has text in it.
 */
export function cellValue(value: ExcelJS.CellValue): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map((r) => r.text).join('');
    if ('text' in value) return value.text;
    // A formula cell: the computed result is what the user sees, so it is what we search.
    if ('result' in value) return value.result ?? null;
    if ('error' in value) return null;
    return null;
  }
  return value;
}

export interface XlsxConversion {
  headers: string[];
  /** Data rows written, excluding the header. */
  total: number;
}

/**
 * Read a workbook and write it out as JSONL, one object per row keyed by header.
 *
 * A header cell that is blank or duplicated gets a positional name (`column_3`), because a
 * column the picker cannot name is a column the user cannot choose, and silently dropping it
 * would hide the very column they wanted.
 */
export async function xlsxToJsonl(path: string, outPath: string): Promise<XlsxConversion> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);

  const sheet = workbook.worksheets[0];
  if (!sheet) return { headers: [], total: 0 };

  const headers = headerNames(sheet.getRow(1));
  const writer = new JsonlWriter(outPath);
  let total = 0;

  try {
    for (let n = 2; n <= sheet.rowCount; n += 1) {
      const row = sheet.getRow(n);
      // A trailing blank row is an artefact of how the sheet was saved, not a row the user
      // meant. An interior blank one IS meaningful — dropping it would shift every index
      // after it out of alignment with their file — so it is written as an empty object.
      if (n === sheet.rowCount && !row.hasValues) break;
      await writer.writeRaw(rowValues(row, headers));
      total += 1;
    }
  } finally {
    await writer.close();
  }

  return { headers, total };
}

function headerNames(row: ExcelJS.Row): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (let i = 1; i <= row.cellCount; i += 1) {
    const raw = cellValue(row.getCell(i).value);
    let name = typeof raw === 'string' ? raw.trim() : raw === null ? '' : String(raw);
    if (name.length === 0) name = `column_${i}`;
    // Two columns sharing a header would silently merge into one key.
    if (seen.has(name)) name = `${name}_${i}`;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function rowValues(row: ExcelJS.Row, headers: string[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  headers.forEach((name, i) => {
    values[name] = cellValue(row.getCell(i + 1).value);
  });
  return values;
}

/** Appends our columns to the user's, in the order the schema defines. */
export class XlsxWriter {
  private readonly workbook: ExcelJS.stream.xlsx.WorkbookWriter;
  private readonly sheet: ExcelJS.Worksheet;

  constructor(
    path: string,
    private readonly sourceHeaders: string[],
    hanHeaders: string[],
  ) {
    this.workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: path, useStyles: true });
    // The header stays visible while scrolling 50,000 rows, and the added columns are
    // filterable without the user setting it up. Both must be set BEFORE any row is
    // committed: a streaming sheet writes rows out as they arrive and a committed row can no
    // longer be styled.
    this.sheet = this.workbook.addWorksheet('results', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    this.sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: sourceHeaders.length + hanHeaders.length },
    };
    const header = this.sheet.addRow([...sourceHeaders, ...hanHeaders]);
    header.font = { bold: true };
    header.commit();
  }

  write(original: Record<string, unknown>, han: ExportValue[]): void {
    const source = this.sourceHeaders.map((h) => normalise(original[h]));
    this.sheet.addRow([...source, ...han]).commit();
  }

  async close(): Promise<void> {
    await this.workbook.commit();
  }
}

/** Objects and arrays would be written as `[object Object]`; JSON is at least recoverable. */
function normalise(value: unknown): ExportValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return String(value);
}
