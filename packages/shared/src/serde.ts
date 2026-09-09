const SNAKE_BOUNDARY = /_([a-z0-9])/g;
const CAMEL_BOUNDARY = /([a-z0-9])([A-Z])/g;

export const toCamel = (s: string): string =>
  s.replace(SNAKE_BOUNDARY, (_, c: string) => c.toUpperCase());

export const toSnake = (s: string): string => s.replace(CAMEL_BOUNDARY, '$1_$2').toLowerCase();

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;

const convertKeys = (value: unknown, fn: (s: string) => string, depth: number): unknown => {
  if (depth > 64) return value; // cycle guard — malformed input must not hang the process
  if (Array.isArray(value)) return value.map((v) => convertKeys(v, fn, depth + 1));
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[fn(k)] = convertKeys(v, fn, depth + 1);
  return out;
};

export const decode = <T = unknown>(wire: unknown): T => convertKeys(wire, toCamel, 0) as T;

export const encode = (value: unknown): Json => convertKeys(value, toSnake, 0) as Json;
