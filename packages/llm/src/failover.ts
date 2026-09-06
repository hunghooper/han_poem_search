/**
 * Provider failover — the spec §4.4.
 *
 * "On ERROR, TIMEOUT, or UNAVAILABLE from the primary, fail over ONCE if a fallback is
 * configured, emit llm_failover, and record `provider` on every call in the trace. With
 * failover on, 'which model produced this answer' is otherwise unanswerable."
 *
 * Once, not repeatedly: a retry loop here would sit underneath Temporal's retry policy and
 * multiply attempts (§4.1 rule 2). This is a single sideways step to a different provider,
 * not a retry.
 */

import { isAppError } from '@han/shared/errors';
import type { LlmProvider, LlmRequest, LlmResponse } from './provider.js';

export const LLM_FAILOVER = 'llm_failover';

/** Errors that warrant trying the other provider. A bad request would fail identically. */
export function isFailoverWorthy(e: unknown): boolean {
  if (!isAppError(e)) return false;
  return e.code === 'TOOL_TIMEOUT' || e.code === 'TOOL_UNAVAILABLE' || e.code === 'INTERNAL';
}

export interface FailoverOptions {
  primary: LlmProvider;
  fallback?: LlmProvider | null;
  /** Called when a failover happens, for the event stream. */
  onFailover?: (info: { from: string; to: string; reason: string }) => void;
}

/**
 * Wrap two providers as one. The result is itself an LlmProvider, so callers never branch on
 * whether failover is configured — that stays a deployment decision.
 */
export function withFailover(opts: FailoverOptions): LlmProvider {
  const { primary, fallback } = opts;

  return {
    name: fallback ? `${primary.name}+${fallback.name}` : primary.name,
    // Capabilities are the INTERSECTION: the agent loop checks these before routing, and
    // claiming a capability the fallback lacks would fail only after failover, in production.
    supportsTools: fallback ? primary.supportsTools && fallback.supportsTools : primary.supportsTools,
    supportsStreaming: fallback
      ? primary.supportsStreaming && fallback.supportsStreaming
      : primary.supportsStreaming,

    async complete(req: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
      try {
        return await primary.complete(req, signal);
      } catch (e) {
        if (!fallback || !isFailoverWorthy(e)) throw e;
        // The caller's wall-clock budget still applies; a failover does not buy extra time.
        if (signal.aborted) throw e;

        const reason = isAppError(e) ? `${e.code}: ${e.message}` : String(e);
        opts.onFailover?.({ from: primary.name, to: fallback.name, reason });

        const res = await fallback.complete(req, signal);
        // `provider` is set by the adapter to whichever one served the call, so the trace can
        // answer "which model produced this answer" without inference.
        return { ...res, flags: [...res.flags, LLM_FAILOVER] };
      }
    },
  };
}
