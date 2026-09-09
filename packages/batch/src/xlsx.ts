import ExcelJS from 'exceljs';
import { JsonlWriter } from './jsonl.js';
import type { ExportValue } from './types.js';

export function cellValue(value: ExcelJS.CellValue): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map((r) => r.text).join('');
    if ('text' in value) return value.text;
    if ('result' in value) return value.result ?? null;
    if ('error' in value) return null;
    return null;
  }
  return value;
}

export interface XlsxConversion {
  headers: string[];
  total: number;
}

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

export class XlsxWriter {
  private readonly workbook: ExcelJS.stream.xlsx.WorkbookWriter;
  private readonly sheet: ExcelJS.Worksheet;

  constructor(
    path: string,
    private readonly sourceHeaders: string[],
    hanHeaders: string[],
  ) {
    this.workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: path, useStyles: true });
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

function normalise(value: unknown): ExportValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return String(value);
}
