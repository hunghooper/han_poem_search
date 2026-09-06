/**
 * Form classification — the spec §10.1.
 *
 * "A candidate whose form does not match the input's shape is almost certainly wrong."
 *
 * This is the cheapest verification available and, on this corpus, one of the strongest. It is
 * deterministic, costs no tokens, and rejects a class of error that semantic similarity is
 * blind to: a 七律 is not a plausible answer to a 五絕 fragment however close the embeddings
 * are, because the shape of the thing is different.
 */

export type PoemForm =
  | 'wujue'
  | 'qijue'
  | 'wulu'
  | 'qilu'
  | 'wupai'
  | 'qipai'
  | 'gushi'
  | 'ci'
  | 'unknown';

export const FORM_LABEL: Record<PoemForm, string> = {
  wujue: '五言絕句',
  qijue: '七言絕句',
  wulu: '五言律詩',
  qilu: '七言律詩',
  wupai: '五言排律',
  qipai: '七言排律',
  gushi: '古詩',
  ci: '詞',
  unknown: '未詳',
};

export interface FormAnalysis {
  form: PoemForm;
  lineCount: number;
  /** The dominant line length, or null when no length dominates. */
  lineLength: number | null;
  /** Fraction of lines at the dominant length. 1.0 means perfectly regular. */
  regularity: number;
  lineLengths: number[];
}

const mk = (
  form: PoemForm,
  lineCount: number,
  lineLength: number | null,
  regularity: number,
  lineLengths: number[],
): FormAnalysis => ({ form, lineCount, lineLength, regularity, lineLengths });

/**
 * Classify by line lengths.
 *
 * `lines` must already be in match form — punctuation stripped, one 句 per entry. Counting
 * characters on display text would count 、and 。as syllables and misclassify everything.
 */
export function analyseForm(lines: readonly string[]): FormAnalysis {
  const lengths = lines.map((l) => l.length).filter((n) => n > 0);
  const lineCount = lengths.length;

  if (lineCount === 0) return mk('unknown', 0, null, 0, []);

  const counts = new Map<number, number>();
  for (const n of lengths) counts.set(n, (counts.get(n) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
  const dominant = top[0];
  const regularity = top[1] / lineCount;

  // 詞 lines vary by design — that irregularity IS the identifying feature, not noise.
  if (regularity < 0.6) return mk('ci', lineCount, null, regularity, lengths);

  if (regularity === 1 && (dominant === 5 || dominant === 7)) {
    const five = dominant === 5;
    if (lineCount === 4) return mk(five ? 'wujue' : 'qijue', lineCount, dominant, regularity, lengths);
    if (lineCount === 8) return mk(five ? 'wulu' : 'qilu', lineCount, dominant, regularity, lengths);
    if (lineCount > 8 && lineCount % 2 === 0) {
      return mk(five ? 'wupai' : 'qipai', lineCount, dominant, regularity, lengths);
    }
  }

  return mk('gushi', lineCount, dominant, regularity, lengths);
}

/** True for the regulated forms, where tone and rhyme rules actually apply. */
export const isRegulated = (f: PoemForm): boolean =>
  f === 'wujue' || f === 'qijue' || f === 'wulu' || f === 'qilu' || f === 'wupai' || f === 'qipai';

/**
 * Is a candidate's form compatible with the shape of the input?
 *
 * Deliberately asymmetric. A pasted fragment is usually PARTIAL — two lines of an eight-line
 * poem — so a mismatch in line COUNT proves nothing and is ignored. A mismatch in line LENGTH
 * does prove something: no amount of truncation turns a 七言 line into a 五言 one.
 */
export function formCompatible(input: FormAnalysis, candidate: FormAnalysis): boolean {
  if (input.lineLength === null || candidate.lineLength === null) return true;
  if (candidate.form === 'ci' || input.form === 'ci') return true;
  return input.lineLength === candidate.lineLength;
}
