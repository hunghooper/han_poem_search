export type ErrorCode =
  | 'CONFIG_INVALID'
  | 'MODEL_MISMATCH'
  | 'CORPUS_NOT_INGESTED'
  | 'NORMALIZATION_FAILED'
  | 'INDEX_QUERY_FAILED'
  | 'TOOL_TIMEOUT'
  | 'TOOL_UNAVAILABLE'
  | 'LLM_EMPTY_RESPONSE'
  | 'LLM_BAD_TOOL_ARGS'
  | 'EVENT_SEQ_CONFLICT'
  | 'RUN_NOT_FOUND'
  | 'INTERNAL';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }

  toJSON(): { code: ErrorCode; message: string; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export class ConfigError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('CONFIG_INVALID', message, details);
  }
}

export class RetrievalError extends AppError {}

export class LlmError extends AppError {}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;

export const toAppError = (e: unknown, fallback: ErrorCode = 'INTERNAL'): AppError => {
  if (isAppError(e)) return e;
  if (e instanceof Error) return new AppError(fallback, e.message, { cause: e.name });
  return new AppError(fallback, String(e));
};
