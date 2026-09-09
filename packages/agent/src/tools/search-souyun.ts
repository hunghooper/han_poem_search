import { z } from 'zod';
import type { Evidence } from '@han/shared/evidence';
import { StepStatus } from '@han/shared/status';
import { emptyResult, okResult, type Tool, type ToolContext } from '../tool.js';

const ArgsSchema = z.object({
  query: z
    .string()
    .min(2)
    .max(60)
    .describe('A contiguous fragment of the poem in Han characters. Short is better.'),
});

type Args = z.infer<typeof ArgsSchema>;

const BASE = 'https://sou-yun.cn/QueryPoem.aspx';

export interface SouyunHit {
  id: string;
  title: string;
  author: string | null;
  dynasty: string | null;
  lines: string[];
  url: string;
}

export function parseSouyun(html: string): SouyunHit[] {
  const hits: SouyunHit[] = [];

  const titleRe =
    /<div id='poem_title_(\d+)'[^>]*>\s*<a href='([^']+)'[^>]*>([\s\S]*?)<\/a>([\s\S]{0,400}?)<\/div>/g;

  for (const m of html.matchAll(titleRe)) {
    const id = m[1]!;
    const href = m[2]!;
    const title = strip(m[3]!);
    const tail = m[4]!;

    const dynasty = strip(/<span class='inlineComment1'>([\s\S]*?)<\/span>/.exec(tail)?.[1] ?? '')
      .replace(/·\s*$/u, '')
      .trim();
    const author = strip(/<a href='javascript:[^']*'>([\s\S]*?)<\/a>/.exec(tail)?.[1] ?? '');

    const lines = contentLines(html, id);
    if (title.length === 0 && lines.length === 0) continue;

    hits.push({
      id,
      title,
      author: author || null,
      dynasty: dynasty || null,
      lines,
      url: href.startsWith('http') ? href : `https://sou-yun.cn${href}`,
    });
  }
  return hits;
}

function contentLines(html: string, id: string): string[] {
  const start = html.indexOf(`<div class='poemContent' id='poem_content_${id}'>`);
  if (start === -1) return [];
  const block = html.slice(start, start + 4000);
  const lines: string[] = [];
  for (const m of block.matchAll(/<div class='poemSentence'[^>]*>([\s\S]*?)(?:<div|<\/div>)/g)) {
    const text = strip(m[1]!);
    if (text.length > 0) lines.push(text);
  }
  return lines;
}

const strip = (s: string): string =>
  s
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

let lastRequestAt = 0;
const cache = new Map<string, { at: number; html: string }>();

async function politeFetch(
  url: string,
  key: string,
  opts: { userAgent: string; delayMs: number; cacheTtlMs: number },
  signal: AbortSignal,
): Promise<string> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < opts.cacheTtlMs) return hit.html;

  const since = Date.now() - lastRequestAt;
  if (since < opts.delayMs) {
    await new Promise((r) => setTimeout(r, opts.delayMs - since));
  }
  lastRequestAt = Date.now();

  const res = await fetch(url, {
    signal,
    headers: { 'user-agent': opts.userAgent, accept: 'text/html' },
  });
  if (!res.ok)
    throw Object.assign(new Error(`sou-yun returned ${res.status}`), { httpStatus: res.status });

  const html = await res.text();
  cache.set(key, { at: Date.now(), html });
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return html;
}

export function createSouyunTool(opts: {
  enabled: boolean;
  userAgent: string;
  timeoutMs: number;
  delayMs: number;
  cacheTtlMs: number;
}): Tool<Args> {
  return {
    name: 'search_souyun',
    source: 'souyun',
    description:
      'Search sou-yun.cn, an outside database of Chinese poetry that is MUCH broader than the ' +
      'local corpus: it covers Ming, Qing and modern verse, couplets and inscriptions, where ' +
      'the local corpus holds only Tang poetry and Song ci. Use it when the local search found ' +
      'nothing or found only weak candidates, and the text looks like real poetry rather than ' +
      'noise. Pass a SHORT contiguous fragment in Han characters — a whole scrambled paste ' +
      'will match nothing. It cannot search Vietnamese or transliterated text.',
    inputSchema: ArgsSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'A contiguous fragment of the poem in Han characters, 2-60 characters.',
        },
      },
      required: ['query'],
    },
    timeoutMs: opts.timeoutMs,

    unavailableReason: () =>
      opts.enabled ? null : 'sou-yun search is switched off (TOOL_SOUYUN_ENABLED)',

    async execute(args, ctx: ToolContext) {
      const started = ctx.now();
      const url = `${BASE}?key=${encodeURIComponent(args.query)}`;

      let html: string;
      try {
        html = await politeFetch(
          url,
          args.query,
          { userAgent: opts.userAgent, delayMs: opts.delayMs, cacheTtlMs: opts.cacheTtlMs },
          ctx.signal,
        );
      } catch (e) {
        if (typeof (e as { httpStatus?: number }).httpStatus === 'number') {
          return emptyResult(
            { name: 'search_souyun', source: 'souyun' },
            StepStatus.ERROR,
            ctx.now() - started,
            {
              code: 'HTTP_ERROR',
              message: (e as Error).message,
            },
          );
        }
        const aborted = ctx.signal.aborted || (e as Error)?.name === 'AbortError';
        return emptyResult(
          { name: 'search_souyun', source: 'souyun' },
          aborted ? StepStatus.TIMEOUT : StepStatus.ERROR,
          ctx.now() - started,
          {
            code: aborted ? 'TIMEOUT' : 'NETWORK',
            message: (e as Error)?.message ?? 'fetch failed',
          },
        );
      }

      if (!html.includes('poemTitle') && !html.includes('QueryPoem')) {
        return emptyResult(
          { name: 'search_souyun', source: 'souyun' },
          StepStatus.ERROR,
          ctx.now() - started,
          {
            code: 'UNEXPECTED_PAGE',
            message:
              'sou-yun returned a page this parser does not recognise — the markup has probably changed',
          },
        );
      }

      const hits = parseSouyun(html).slice(0, 8);
      if (hits.length === 0) {
        return emptyResult(
          { name: 'search_souyun', source: 'souyun' },
          StepStatus.NO_RESULT,
          ctx.now() - started,
        );
      }

      return okResult(
        { name: 'search_souyun', source: 'souyun' },
        hits.map((h) => toEvidence(h, args.query)),
        ctx.now() - started,
      );
    },
  };
}

function toEvidence(hit: SouyunHit, query: string): Evidence {
  return {
    id: `souyun:${hit.id}`,
    source: 'souyun',
    retrievalMethod: 'agent_web_search',
    workId: null,
    title: hit.title || null,
    author: hit.author,
    dynasty: hit.dynasty,
    edition: null,
    provenance: null,
    url: hit.url,
    content: hit.lines.join('\n'),
    matchedSpan: null,
    score: 0,
    rerankScore: null,
    metadata: { query },
  } as Evidence;
}
