import { isAppError } from '@han/shared/errors';
import type { LlmProvider, LlmRequest, LlmResponse } from './provider.js';

export const LLM_FAILOVER = 'llm_failover';

export function isFailoverWorthy(e: unknown): boolean {
  if (!isAppError(e)) return false;
  return e.code === 'TOOL_TIMEOUT' || e.code === 'TOOL_UNAVAILABLE' || e.code === 'INTERNAL';
}

export interface FailoverOptions {
  primary: LlmProvider;
  fallback?: LlmProvider | null;
  onFailover?: (info: { from: string; to: string; reason: string }) => void;
}

export function withFailover(opts: FailoverOptions): LlmProvider {
  const { primary, fallback } = opts;

  return {
    name: fallback ? `${primary.name}+${fallback.name}` : primary.name,
    supportsTools: fallback
      ? primary.supportsTools && fallback.supportsTools
      : primary.supportsTools,
    supportsStreaming: fallback
      ? primary.supportsStreaming && fallback.supportsStreaming
      : primary.supportsStreaming,

    async complete(req: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
      try {
        return await primary.complete(req, signal);
      } catch (e) {
        if (!fallback || !isFailoverWorthy(e)) throw e;
        if (signal.aborted) throw e;

        const reason = isAppError(e) ? `${e.code}: ${e.message}` : String(e);
        opts.onFailover?.({ from: primary.name, to: fallback.name, reason });

        const res = await fallback.complete(req, signal);
        return { ...res, flags: [...res.flags, LLM_FAILOVER] };
      }
    },
  };
}
