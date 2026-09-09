import * as OpenCC from 'opencc-js';
import variants from './data/variants.json' with { type: 'json' };

export interface NormalizedText {
  textDisplay: string;
  textTrad: string;
  textSimp: string;
  textMatch: string;
  matchToDisplay: number[];
}

const PUNCT =
  /[\s!-/:-@[-`{-~\u00B7\u2000-\u206F\u3000-\u303F\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65]/u;

const isPunct = (ch: string): boolean => PUNCT.test(ch);

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

const VARIANT_MAP: ReadonlyMap<string, string> = new Map(
  Object.entries(variants.fold as Record<string, string>),
);

export const foldVariant = (ch: string): string => VARIANT_MAP.get(ch) ?? ch;

const toTrad = OpenCC.Converter({ from: 'cn', to: 'tw' });
const toSimp = OpenCC.Converter({ from: 'tw', to: 'cn' });

export const OPENCC_CONFIG = 'cn2tw+tw2cn' as const;

export function normalize(input: string): NormalizedText {
  const textDisplay = input.normalize('NFC');
  const textTrad = toTrad(textDisplay).normalize('NFC');
  const textSimp = toSimp(textDisplay).normalize('NFC');

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

export const toMatchForm = (input: string): string => normalize(input).textMatch;

export const visualLines = (input: string): string[] =>
  input
    .split(/[\s\u3000]+/u)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

export const prosodyLines = (input: string): string[] =>
  visualLines(input)
    .flatMap((line) => line.split(/[，。、；：？！,.;:?!·．｡､]+/u))
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
