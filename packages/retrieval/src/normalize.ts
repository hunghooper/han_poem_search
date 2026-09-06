/**
 * Text normalization — the spec §3.2.
 *
 * There is exactly ONE normalize() in this codebase. The corpus is normalized with it at
 * ingest and the query is normalized with it at search time. A second normalization path
 * anywhere is a bug that will only surface on some inputs (CONTRIBUTING.md, "Working with
 * the corpus text", rule 2).
 *
 * Four stored forms:
 *   textDisplay — original, with punctuation. Shown to the user. NEVER matched against.
 *   textTrad    — OpenCC-normalized Traditional
 *   textSimp    — OpenCC-normalized Simplified
 *   textMatch   — Traditional, punctuation stripped, variants folded, NFC. All matching.
 */

import * as OpenCC from 'opencc-js';
import variants from './data/variants.json' with { type: 'json' };

export interface NormalizedText {
  textDisplay: string;
  textTrad: string;
  textSimp: string;
  textMatch: string;
  /** For each character of textMatch, its index in textDisplay. Powers matchedSpan. */
  matchToDisplay: number[];
}

/**
 * Punctuation and whitespace — everything stripped from textMatch.
 *
 * Deliberately explicit rather than \p{P}: the Unicode property also strips characters that
 * appear inside rare poem titles, and silently dropping a character from the match text
 * misaligns every span after it.
 *
 * Written with \u escapes rather than the literal characters. An ideographic space (U+3000)
 * sitting in source is invisible and unreviewable.
 */
const PUNCT =
  /[\s!-/:-@[-`{-~\u00B7\u2000-\u206F\u3000-\u303F\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65]/u;

const isPunct = (ch: string): boolean => PUNCT.test(ch);

/** True for characters we are willing to index: CJK ideographs and their extensions. */
export const isCjk = (ch: string): boolean => {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return false;
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0x3400 && cp <= 0x4dbf) || // Extension A
    (cp >= 0xf900 && cp <= 0xfaff) || // Compatibility Ideographs
    (cp >= 0x20000 && cp <= 0x2a6df) || // Extension B
    (cp >= 0x2a700 && cp <= 0x2ebef) // Extensions C-F
  );
};

/**
 * 異體字 folding table. Data, not code (§3.2) — adding an entry requires a source for the
 * equivalence in the PR description. Guessing that two characters are variants because they
 * look similar is how you silently merge two distinct poems.
 */
const VARIANT_MAP: ReadonlyMap<string, string> = new Map(
  Object.entries(variants.fold as Record<string, string>),
);

export const foldVariant = (ch: string): string => VARIANT_MAP.get(ch) ?? ch;

const toTrad = OpenCC.Converter({ from: 'cn', to: 'tw' });
const toSimp = OpenCC.Converter({ from: 'tw', to: 'cn' });

/** The OpenCC configuration, asserted to match between ingest and query time. */
export const OPENCC_CONFIG = 'cn2tw+tw2cn' as const;

export function normalize(input: string): NormalizedText {
  const textDisplay = input.normalize('NFC');
  const textTrad = toTrad(textDisplay).normalize('NFC');
  const textSimp = toSimp(textDisplay).normalize('NFC');

  // Build textMatch from textTrad, keeping a position map back to textDisplay.
  //
  // OpenCC is character-for-character for the conversions we use, so index i of textTrad
  // corresponds to index i of textDisplay. That invariant is checked rather than assumed —
  // if a future OpenCC config changes length, spans would silently point at the wrong
  // characters, which is exactly the class of bug this file exists to prevent.
  const aligned = textTrad.length === textDisplay.length;

  const matchChars: string[] = [];
  const matchToDisplay: number[] = [];
  const trad = [...textTrad];
  let displayIdx = 0;

  for (const ch of trad) {
    const width = ch.length; // surrogate pairs count as 2 in the display string
    if (!isPunct(ch) && isCjk(ch)) {
      matchChars.push(foldVariant(ch));
      matchToDisplay.push(aligned ? displayIdx : -1);
    }
    displayIdx += width;
  }

  return {
    textDisplay,
    textTrad,
    textSimp,
    textMatch: matchChars.join('').normalize('NFC'),
    matchToDisplay,
  };
}

/** The match form only — the hot path for query normalization. */
export const toMatchForm = (input: string): string => normalize(input).textMatch;

/**
 * Split into visual segments, preserving order, dropping empties. Reordering starts here.
 *
 * Splits on whitespace as well as newlines. In CJK text a space is not a word separator — it
 * is a deliberate segment break, the way a transcriber marks where one column ended. Treating
 * a space-separated paste as a single line hides the grid from every reorder strategy.
 */
export const visualLines = (input: string): string[] =>
  input
    .split(/[\s\u3000]+/u)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
