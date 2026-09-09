import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface RawPoem {
  edition: string;
  sourceFile: string;
  title: string | null;
  author: string | null;
  rhythmic: string | null;
  paragraphs: string[];
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
