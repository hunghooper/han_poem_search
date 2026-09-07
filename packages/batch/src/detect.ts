/**
 * What kind of file did the user actually give us?
 *
 * By content, never by extension. A `.jsonl` holding a JSON array, an `.xlsx` that is really
 * the old binary `.xls`, a UTF-16 export from Excel — all of these are common, and all of them
 * produce a confusing parse error three layers down if the extension is believed.
 *
 * The result is a discriminated union with a REASON, in the spirit of §5: "unsupported" is a
 * different answer from "supported but malformed", and both are different from "this looks
 * like a format we could support but do not". Telling the user which one it is decides whether
 * they should convert the file, fix it, or give up.
 */

/** Bytes we need to see to decide. The whole file is never read for detection. */
export const SNIFF_BYTES = 64 * 1024;

export type FileKind = 'jsonl' | 'xlsx';

export type Detection =
  | { ok: true; kind: FileKind; note?: string }
  | { ok: false; reason: DetectionFailure; message: string };

export type DetectionFailure =
  | 'empty'
  | 'xls_legacy'
  | 'json_array'
  | 'csv_like'
  | 'not_utf8'
  | 'unknown';

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // "PK\x03\x04" — every .xlsx is a zip
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0]; // the pre-2007 binary .xls container

const startsWith = (buf: Uint8Array, magic: number[]): boolean =>
  magic.every((b, i) => buf[i] === b);

/** UTF-16 and UTF-32 BOMs. Excel's "Unicode text" export writes UTF-16LE and it is not rare. */
const hasWideBom = (buf: Uint8Array): boolean =>
  (buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff);

const stripUtf8Bom = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/**
 * Decide from the first bytes of the file.
 *
 * `head` should be the first SNIFF_BYTES bytes; passing the whole file also works but reads
 * more than is needed.
 */
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

  // From here on it has to be text. A decoder in fatal mode is the honest test: invalid UTF-8
  // silently becoming U+FFFD would let a mojibake file through and fail much later, on
  // characters that no longer match anything in the corpus.
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
      // One object, no newline yet inside the sniff window: a single-record JSONL is legal and
      // a pretty-printed .json is not, and this window cannot yet tell them apart. Accepting
      // it means the parser decides, and the parser reports precisely.
      return { ok: true, kind: 'jsonl', note: 'single_record_unverified' };
    }
    const bad = lines.findIndex((l) => !isJsonObject(l));
    if (bad === -1) return { ok: true, kind: 'jsonl' };

    // Do the lines together form ONE object? Then this is pretty-printed JSON, and the fix
    // is to re-export it one record per line — a different instruction from "line 3 is
    // broken", which is what the user would otherwise be told to go and look for.
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

/** Only lines we have seen a newline for — the last fragment in the window may be truncated. */
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

/**
 * Delimited-text heuristic: several lines that each hold the same number of commas or tabs.
 * A consistent count across lines is what separates a table from prose that happens to have
 * commas in it.
 */
function looksDelimited(body: string): boolean {
  const lines = completeLines(body).slice(0, 10);
  if (lines.length < 2) return false;
  return [',', '\t', ';'].some((d) => {
    const counts = lines.map((l) => l.split(d).length - 1);
    return counts[0]! >= 1 && counts.every((c) => c === counts[0]);
  });
}
