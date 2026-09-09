export const SNIFF_BYTES = 64 * 1024;

export type FileKind = 'jsonl' | 'xlsx';

export type Detection =
  | { ok: true; kind: FileKind; note?: string }
  | { ok: false; reason: DetectionFailure; message: string };

export type DetectionFailure =
  'empty' | 'xls_legacy' | 'json_array' | 'csv_like' | 'not_utf8' | 'unknown';

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // "PK\x03\x04" — every .xlsx is a zip
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0]; // the pre-2007 binary .xls container

const startsWith = (buf: Uint8Array, magic: number[]): boolean =>
  magic.every((b, i) => buf[i] === b);

const hasWideBom = (buf: Uint8Array): boolean =>
  (buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff);

const stripUtf8Bom = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

export function detect(head: Uint8Array): Detection {
  if (head.length === 0) return { ok: false, reason: 'empty', message: 'The file is empty.' };

  if (startsWith(head, ZIP_MAGIC)) return { ok: true, kind: 'xlsx' };

  if (startsWith(head, OLE_MAGIC)) {
    return {
      ok: false,
      reason: 'xls_legacy',
      message:
        'This is the old binary .xls format. Re-save it as .xlsx (Excel: File → Save As → Excel Workbook).',
    };
  }

  if (hasWideBom(head)) {
    return {
      ok: false,
      reason: 'not_utf8',
      message:
        'This file is UTF-16, not UTF-8. Re-save it as UTF-8, or export it as .xlsx instead.',
    };
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(head);
  } catch {
    return {
      ok: false,
      reason: 'not_utf8',
      message: 'This file is not valid UTF-8 text. Re-save it as UTF-8, or export it as .xlsx.',
    };
  }

  const body = stripUtf8Bom(text).trimStart();
  if (body.length === 0) {
    return { ok: false, reason: 'empty', message: 'The file has no content.' };
  }

  if (body.startsWith('[')) {
    return {
      ok: false,
      reason: 'json_array',
      message:
        'This is a JSON array, not JSONL. JSONL is one JSON object per line, with no enclosing brackets or commas between records.',
    };
  }

  if (body.startsWith('{')) {
    const lines = completeLines(body);
    if (lines.length === 0) {
      return { ok: true, kind: 'jsonl', note: 'single_record_unverified' };
    }
    const bad = lines.findIndex((l) => !isJsonObject(l));
    if (bad === -1) return { ok: true, kind: 'jsonl' };

    if (isJsonObject(lines.join(''))) {
      return {
        ok: false,
        reason: 'json_array',
        message:
          'This looks like pretty-printed JSON, where one record spans several lines. JSONL needs each record on a single line.',
      };
    }
    return {
      ok: false,
      reason: 'unknown',
      message: `Line ${bad + 1} is not a JSON object, so this is not valid JSONL.`,
    };
  }

  if (looksDelimited(body)) {
    return {
      ok: false,
      reason: 'csv_like',
      message:
        'This looks like CSV or TSV, which is not supported yet. Save it as .xlsx, or convert it to JSONL.',
    };
  }

  return {
    ok: false,
    reason: 'unknown',
    message: 'Unrecognised file. Supported formats are JSONL (one JSON object per line) and .xlsx.',
  };
}

function completeLines(body: string): string[] {
  const parts = body.split(/\r?\n/u);
  parts.pop();
  return parts.map((l) => l.trim()).filter((l) => l.length > 0);
}

function isJsonObject(line: string): boolean {
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  } catch {
    return false;
  }
}

function looksDelimited(body: string): boolean {
  const lines = completeLines(body).slice(0, 10);
  if (lines.length < 2) return false;
  return [',', '\t', ';'].some((d) => {
    const counts = lines.map((l) => l.split(d).length - 1);
    return counts[0]! >= 1 && counts.every((c) => c === counts[0]);
  });
}
