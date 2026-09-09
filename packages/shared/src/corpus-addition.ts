import { z } from 'zod';

export const REQUIRED_FIELDS = ['title', 'author', 'text'] as const;
export const OPTIONAL_FIELDS = ['dynasty', 'form', 'note', 'source_url'] as const;

export type RequiredField = (typeof REQUIRED_FIELDS)[number];

export type RefusalCode = 'title' | 'author' | 'text' | 'text_han' | 'text_long' | 'title_long';

export interface RowCheck {
  index: number;
  ok: boolean;
  missing: RefusalCode[];
  title: string;
  author: string;
  chars: number;
}

const HAN = /\p{Script=Han}/u;

export const hanCount = (s: string): number =>
  [...String(s ?? '')].filter((c) => HAN.test(c)).length;

export const MIN_HAN_CHARS = 4;

export const MAX_HAN_CHARS = 4000;
export const MAX_TITLE_CHARS = 200;

export function checkRow(row: Record<string, unknown>, index: number): RowCheck {
  const get = (k: string): string => String(row[k] ?? '').trim();
  const missing: RefusalCode[] = REQUIRED_FIELDS.filter((f) => get(f).length === 0);

  const title = get('title');
  const text = get('text');
  const chars = hanCount(text);

  if (!missing.includes('text')) {
    if (chars < MIN_HAN_CHARS) missing.push('text_han');
    else if (chars > MAX_HAN_CHARS) missing.push('text_long');
  }
  if (!missing.includes('title') && title.length > MAX_TITLE_CHARS) missing.push('title_long');

  return { index, ok: missing.length === 0, missing, title, author: get('author'), chars };
}

export const CorpusAdditionSchema = z
  .object({
    title: z.string().min(1).max(MAX_TITLE_CHARS),
    author: z.string().min(1).max(200),
    text: z.string().min(1),
    dynasty: z.string().max(100).nullish(),
    form: z.string().max(100).nullish(),
    note: z.string().max(2000).nullish(),
    source_url: z.string().url().nullish(),
  })
  .strict()
  .refine((v) => hanCount(v.text) >= MIN_HAN_CHARS, {
    message: `text must contain at least ${MIN_HAN_CHARS} Han characters`,
    path: ['text'],
  })
  .refine((v) => hanCount(v.text) <= MAX_HAN_CHARS, {
    message: `text must contain at most ${MAX_HAN_CHARS} Han characters`,
    path: ['text'],
  });

export type CorpusAddition = z.infer<typeof CorpusAdditionSchema>;

export const AdditionOrigin = {
  NONE: 'no',
  USER: 'user',
  AGENT: 'agent',
} as const;

export type AdditionOrigin = (typeof AdditionOrigin)[keyof typeof AdditionOrigin];

export const AdditionStatus = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
} as const;

export type AdditionStatus = (typeof AdditionStatus)[keyof typeof AdditionStatus];
