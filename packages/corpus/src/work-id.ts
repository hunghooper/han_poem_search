import { createHash } from 'node:crypto';
import { toMatchForm } from '@han/retrieval/normalize';

export interface WorkKeyInput {
  author: string | null;
  title: string | null;
  firstLine: string;
}

export function deriveWorkKey(input: WorkKeyInput): string {
  const parts = [toMatchForm(input.author ?? ''), toMatchForm(input.title ?? ''), input.firstLine];
  return createHash('sha256').update(parts.join('|'), 'utf8').digest('hex').slice(0, 32);
}

export function contentHash(
  edition: string,
  sourceFile: string,
  textMatch: string,
  title: string | null,
): string {
  return createHash('sha256')
    .update([edition, sourceFile, title ?? '', textMatch].join('|'), 'utf8')
    .digest('hex');
}
