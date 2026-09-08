/**
 * 搜韻 (sou-yun.cn) — the first tool that looks outside the corpus.
 *
 * WHY THIS SOURCE. The local corpus is Tang poetry and Song ci. Real calligraphy is mostly
 * neither: couplets, aphorisms, Buddhist phrases, Ming and Qing verse. Sou-yun covers all of
 * it, and the very first query run against it during development returned a late-Ming poem —
 * exactly the kind the corpus cannot hold.
 *
 * WHY NOT THE OTHERS, measured from this machine on 2026-09-08:
 *
 *   ctext.org, api.ctext.org   unreachable — connection refused and timeouts, while other
 *                              hosts answered, so a tool built against it could not run here
 *   thivien.net                reachable, but its `Content` field does not index Han text:
 *                              searching a distinctive five-character phrase moved the result
 *                              count from 88,264 to 79,760, which is not a match
 *   Google Custom Search       documented and stable, but needs a key that is not configured
 *
 * THIS IS A SCRAPER AND IT WILL BREAK. There is no API; the parser reads markup that the site
 * owes us no stability on. It is written to fail LOUDLY when the shape changes — a page that
 * parses to nothing reports NO_RESULT, and a page that does not parse at all reports ERROR,
 * because "the site changed" and "the poem is not there" must not look the same. The recorded
 * fixture beside this file is the contract; when it stops matching the live site, the test
 * fails before a user sees silence.
 */

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

/** One parsed result. Kept separate from Evidence so the parser is testable on its own. */
export interface SouyunHit {
  id: string;
  title: string;
  author: string | null;
  dynasty: string | null;
  lines: string[];
  url: string;
}

/**
 * Pull results out of the page.
 *
 * Regex over HTML, deliberately. A DOM parser would be tidier and would add a dependency to a
 * package that has none for this, and the markup here is machine-generated and uniform. The
 * fragility is the scraping, not the regex.
 */
export function parseSouyun(html: string): SouyunHit[] {
  const hits: SouyunHit[] = [];

  // Each result opens with a title block carrying the poem id, then a content block with the
  // same id. Anchoring on the id is what keeps the two halves paired when results interleave.
  const titleRe =
    /<div id='poem_title_(\d+)'[^>]*>\s*<a href='([^']+)'[^>]*>([\s\S]*?)<\/a>([\s\S]{0,400}?)<\/div>/g;

  for (const m of html.matchAll(titleRe)) {
    const id = m[1]!;
    const href = m[2]!;
    const title = strip(m[3]!);
    const tail = m[4]!;

    // ' 明末清初 · ' — the dynasty sits in its own inline comment before the author link.
    const dynasty = strip(/<span class='inlineComment1'>([\s\S]*?)<\/span>/.exec(tail)?.[1] ?? '')
      .replace(/·\s*$/u, '')
      .trim();
    // The author's name is the link text; the href is a javascript: call, so the text is all
    // there is to take.
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

/** The poem's own lines, from the content block bearing the same id as its title block. */
function contentLines(html: string, id: string): string[] {
  const start = html.indexOf(`<div class='poemContent' id='poem_content_${id}'>`);
  if (start === -1) return [];
  // Bounded rather than balanced: these blocks are a few hundred bytes and a balanced scan
  // would buy nothing but a way to run off the end of a truncated page.
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

/**
 * Politeness, enforced in code rather than promised in a comment.
 *
 * Sou-yun is run by a small company, not a platform with a quota API. Its robots.txt blocks
 * one named crawler and nothing else, and its About page states no restriction on automated
 * access — checked 2026-09-08, recorded in ADR 013. Permission that broad is a reason to be
 * careful, not a reason to hammer it.
 *
 * Three things keep the load defensible: one request at a time with a gap between them, a
 * short cache so a repeated query costs the site nothing, and a user agent that says who is
 * calling. The agent only reaches this tool when the local corpus has already failed, so the
 * natural rate is low to begin with.
 */
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
  if (!res.ok) throw Object.assign(new Error(`sou-yun returned ${res.status}`), { httpStatus: res.status });

  const html = await res.text();
  cache.set(key, { at: Date.now(), html });
  // Bounded: this is a per-process convenience, not a store.
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return html;
}

export function createSouyunTool(opts: {
  enabled: boolean;
  userAgent: string;
  timeoutMs: number;
  /** Minimum gap between outbound requests. */
  delayMs: number;
  /** How long an identical query is served from memory instead of the site. */
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
          return emptyResult({ name: 'search_souyun', source: 'souyun' }, StepStatus.ERROR, ctx.now() - started, {
            code: 'HTTP_ERROR',
            message: (e as Error).message,
          });
        }
        // An aborted request is a TIMEOUT, not an error and certainly not an empty result:
        // "we ran out of time" and "there is nothing there" are different facts (§5.1).
        const aborted = ctx.signal.aborted || (e as Error)?.name === 'AbortError';
        return emptyResult(
          { name: 'search_souyun', source: 'souyun' },
          aborted ? StepStatus.TIMEOUT : StepStatus.ERROR,
          ctx.now() - started,
          { code: aborted ? 'TIMEOUT' : 'NETWORK', message: (e as Error)?.message ?? 'fetch failed' },
        );
      }

      // A page that does not even look like the search page is a changed site, not an empty
      // result. Reporting NO_RESULT here would turn a broken scraper into a silent one.
      if (!html.includes('poemTitle') && !html.includes('QueryPoem')) {
        return emptyResult({ name: 'search_souyun', source: 'souyun' }, StepStatus.ERROR, ctx.now() - started, {
          code: 'UNEXPECTED_PAGE',
          message: 'sou-yun returned a page this parser does not recognise — the markup has probably changed',
        });
      }

      const hits = parseSouyun(html).slice(0, 8);
      if (hits.length === 0) {
        return emptyResult({ name: 'search_souyun', source: 'souyun' }, StepStatus.NO_RESULT, ctx.now() - started);
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
    // No workId: this is not our corpus and nothing here maps onto it. Inventing one would
    // claim a link between an outside record and a local work that nobody established.
    workId: null,
    title: hit.title || null,
    author: hit.author,
    dynasty: hit.dynasty,
    edition: null,
    // Provenance is for LOCAL results, whose dataset and commit we know. An outside page has
    // a URL and nothing else we can vouch for.
    provenance: null,
    url: hit.url,
    content: hit.lines.join('\n'),
    matchedSpan: null,
    // Rank order only. Sou-yun exposes no score, and inventing one would put a number the
    // fusion layer would then weigh against numbers that mean something.
    score: 0,
    rerankScore: null,
    metadata: { query },
  } as Evidence;
}
