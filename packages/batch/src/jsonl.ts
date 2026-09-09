import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import type { SourceRow } from './types.js';
import type { ExportValue } from './types.js';

export interface JsonlReadOptions {
  limit?: number;
}

export interface ParsedRow extends SourceRow {
  parseError?: string;
}

export async function* readJsonl(
  path: string,
  options: JsonlReadOptions = {},
): AsyncGenerator<ParsedRow> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let index = 0;
  try {
    for await (const raw of lines) {
      const line = raw.trim();
      if (line.length === 0) continue;
      if (options.limit !== undefined && index >= options.limit) break;
      yield parseLine(line, index);
      index += 1;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

function parseLine(line: string, index: number): ParsedRow {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { index, values: {}, parseError: 'line is not a JSON object' };
    }
    return { index, values: value as Record<string, unknown> };
  } catch (e) {
    return { index, values: {}, parseError: e instanceof Error ? e.message : String(e) };
  }
}

export async function countJsonlRows(path: string): Promise<number> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const raw of lines) if (raw.trim().length > 0) n += 1;
  } finally {
    lines.close();
    stream.destroy();
  }
  return n;
}

export class JsonlWriter {
  private readonly out: ReturnType<typeof createWriteStream>;

  constructor(path: string) {
    this.out = createWriteStream(path, { encoding: 'utf8' });
  }

  async write(original: Record<string, unknown>, han: Record<string, ExportValue>): Promise<void> {
    await this.writeRaw({ ...original, han });
  }

  async writeRaw(row: Record<string, unknown>): Promise<void> {
    if (!this.out.write(JSON.stringify(row) + String.fromCharCode(10)))
      await once(this.out, 'drain');
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.out.end((e?: Error | null) => (e ? reject(e) : resolve()));
    });
  }
}
