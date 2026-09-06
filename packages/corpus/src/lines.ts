/**
 * 句 segmentation.
 *
 * A "line" here is a 句 — the unit that ends at a comma or a full stop — not a JSON array
 * element. The two collections disagree about that, which is why this is its own module:
 *
 *   全唐诗/poet.tang.*.json  one couplet per array element: "群峭碧摩天，逍遙不記年。"
 *   御定全唐詩/json/*.json   several couplets per element, run together
 *
 * Splitting on array elements alone would give 御定全唐詩 lines of 20+ characters, and every
 * form check in §10.1 (5 or 7 characters per line) would then reject the entire edition.
 */

const BREAK = /[，。！？；]/;

/** Split a paragraph into 句, dropping empties. Punctuation is not retained. */
export const toSentences = (paragraph: string): string[] =>
  paragraph
    .split(BREAK)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

export const paragraphsToLines = (paragraphs: readonly string[]): string[] =>
  paragraphs.flatMap(toSentences);
