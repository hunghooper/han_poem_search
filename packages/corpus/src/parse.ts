/**
 * Collection readers. Shapes verified against the pinned corpus, not assumed — see the notes
 * in each reader. §3 of the brief says to do exactly this before coding, and three of its
 * stated assumptions turned out not to hold.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface RawPoem {
  edition: string;
  sourceFile: string;
  title: string | null;
  author: string | null;
  /** 詞牌, for 詞 records. */
  rhythmic: string | null;
  paragraphs: string[];
  /** Upstream id where one exists. Absent for 宋詞 and 御定全唐詩. */
  upstreamId: string | null;
}

export interface RawAuthor {
  edition: string;
  sourceFile: string;
  name: string;
  bio: string | null;
}

const readJson = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, 'utf8')) as T;

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * 全唐诗/poet.{tang,song}.*.json
 * { id, title, author, paragraphs[] } — Traditional script, one couplet per paragraph.
 */
export async function readQuanTangShi(root: string, prefix: 'tang' | 'song'): Promise<RawPoem[]> {
  const dir = join(root, '全唐诗');
  const files = (await readdir(dir))
    .filter((f) => f.startsWith(`poet.${prefix}.`) && f.endsWith('.json'))
    .sort();

  const out: RawPoem[] = [];
  for (const file of files) {
    const rows = await readJson<Array<Record<string, unknown>>>(join(dir, file));
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      if (!isStringArray(r.paragraphs)) continue;
      out.push({
        edition: '全唐詩',
        sourceFile: `全唐诗/${file}`,
        title: typeof r.title === 'string' ? r.title : null,
        author: typeof r.author === 'string' ? r.author : null,
        rhythmic: null,
        paragraphs: r.paragraphs,
        upstreamId: typeof r.id === 'string' ? r.id : null,
      });
    }
  }
  return out;
}

/**
 * 宋词/ci.song.*.json
 * { author, rhythmic, paragraphs[] } — NO id field, and SIMPLIFIED script, contradicting
 * §3.1 item 3 which lists 宋詞 as Traditional. normalize() converts it, so the effect is
 * confined to this note. Records also contain □ placeholders for illegible characters, which
 * are stripped from textMatch by isCjk() — a line with □ is genuinely shorter than it looks.
 */
export async function readSongCi(root: string): Promise<RawPoem[]> {
  const dir = join(root, '宋词');
  const files = (await readdir(dir))
    .filter((f) => f.startsWith('ci.song.') && f.endsWith('.json'))
    .sort();

  const out: RawPoem[] = [];
  for (const file of files) {
    const rows = await readJson<Array<Record<string, unknown>>>(join(dir, file));
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      if (!isStringArray(r.paragraphs)) continue;
      const rhythmic = typeof r.rhythmic === 'string' ? r.rhythmic : null;
      out.push({
        edition: '宋詞',
        sourceFile: `宋词/${file}`,
        title: rhythmic,
        author: typeof r.author === 'string' ? r.author : null,
        rhythmic,
        paragraphs: r.paragraphs,
        upstreamId: null,
      });
    }
  }
  return out;
}

/**
 * 全唐诗/authors.{tang,song}.json — { id, name, desc }
 * 宋词/author.song.json          — { name, description, short_description }, no id
 */
export async function readAuthors(root: string): Promise<RawAuthor[]> {
  const specs: Array<{ file: string; edition: string; bioKey: string }> = [
    { file: '全唐诗/authors.tang.json', edition: '全唐詩', bioKey: 'desc' },
    { file: '全唐诗/authors.song.json', edition: '全唐詩', bioKey: 'desc' },
    { file: '宋词/author.song.json', edition: '宋詞', bioKey: 'description' },
  ];

  const out: RawAuthor[] = [];
  for (const spec of specs) {
    let rows: Array<Record<string, unknown>>;
    try {
      rows = await readJson<Array<Record<string, unknown>>>(join(root, spec.file));
    } catch {
      continue; // a collection that is not present is not an error
    }
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      if (typeof r.name !== 'string') continue;
      const bio = r[spec.bioKey];
      out.push({
        edition: spec.edition,
        sourceFile: spec.file,
        name: r.name,
        bio: typeof bio === 'string' ? bio : null,
      });
    }
  }
  return out;
}
