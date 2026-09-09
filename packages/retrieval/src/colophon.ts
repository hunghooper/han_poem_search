import { toMatchForm, visualLines } from './normalize.js';

const STEMS = '甲乙丙丁戊己庚辛壬癸';
const BRANCHES = '子丑寅卯辰巳午未申酉戌亥';

const DATE_TAIL = '年月日春夏秋冬';

const COLOPHON_MARKERS = [
  '書',
  '寫',
  '題',
  '錄',
  '録',
  '臨',
  '作',
  '撰',
  '並書',
  '敬書',
  '謹書',
  '節錄',
  '節録',
  '印',
  '鈐',
  '篆',
  '刻',
  '先生',
  '女士',
  '雅正',
  '清賞',
  '惠存',
  '正之',
  '指正',
  '詩',
  '詞',
  '句',
  '聯',
];

export interface Colophon {
  body: string[];
  colophonLines: string[];
  cyclicalDate: string | null;
  author: string | null;
  title: string | null;
}

export function hasCyclicalDate(text: string): boolean {
  for (let i = 0; i + 1 < text.length; i += 1) {
    if (STEMS.includes(text[i]!) && BRANCHES.includes(text[i + 1]!)) return true;
  }
  return false;
}

export function extractCyclicalDate(text: string): string | null {
  for (let i = 0; i + 1 < text.length; i += 1) {
    if (STEMS.includes(text[i]!) && BRANCHES.includes(text[i + 1]!)) {
      let end = i + 2;
      while (end < text.length && DATE_TAIL.includes(text[end]!)) end += 1;
      return text.slice(i, end);
    }
  }
  return null;
}

export function colophonScore(line: string): number {
  const m = toMatchForm(line);
  if (m.length === 0) return 0;

  let score = 0;
  if (hasCyclicalDate(m)) score += 3;
  for (const marker of COLOPHON_MARKERS) if (m.includes(marker)) score += 1;

  if (m.length <= 3) score += 1;
  if (m.length > 12) score += 1;

  return score;
}

export const COLOPHON_THRESHOLD = 2;

export function splitColophon(input: string): Colophon {
  const lines = visualLines(input);
  if (lines.length === 0) {
    return { body: [], colophonLines: [], cyclicalDate: null, author: null, title: null };
  }

  const scores = lines.map((l) => colophonScore(l));
  const allColophon = scores.every((s) => s >= COLOPHON_THRESHOLD);
  if (allColophon) {
    const joined = lines.join(' ');
    return {
      body: [],
      colophonLines: lines,
      cyclicalDate: extractCyclicalDate(toMatchForm(joined)),
      author: null,
      title: null,
    };
  }

  let end = lines.length;
  while (end > 0 && (scores[end - 1] ?? 0) >= COLOPHON_THRESHOLD) end -= 1;

  let start = 0;
  while (start < end && hasCyclicalDate(toMatchForm(lines[start] ?? ''))) start += 1;
  if (end - start > 2 && (scores[start] ?? 0) >= COLOPHON_THRESHOLD) start += 1;

  const body = lines.slice(start, end);
  const colophonLines = [...lines.slice(0, start), ...lines.slice(end)];
  const joined = colophonLines.join(' ');

  return {
    body,
    colophonLines,
    cyclicalDate: colophonLines.length ? extractCyclicalDate(toMatchForm(joined)) : null,
    author: null,
    title: start > 0 ? (lines[0] ?? null) : null,
  };
}
