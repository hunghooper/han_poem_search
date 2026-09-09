const BREAK = /[，。！？；]/;

export const toSentences = (paragraph: string): string[] =>
  paragraph
    .split(BREAK)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

export const paragraphsToLines = (paragraphs: readonly string[]): string[] =>
  paragraphs.flatMap(toSentences);
