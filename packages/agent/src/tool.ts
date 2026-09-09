import type { z } from 'zod';
import type { Evidence } from '@han/shared/evidence';
import type { SourceId, StepStatus } from '@han/shared/status';
import type { ToolResult } from '@han/shared/tool-result';
import { StepStatus as Status } from '@han/shared/status';
import { toAppError } from '@han/shared/errors';

export interface ToolContext {
  signal: AbortSignal;
  debug: boolean;
  now: () => number;
}

export interface Tool<A = unknown> {
  name: string;
  source: SourceId;
  description: string;
  inputSchema: z.ZodType<A>;
  jsonSchema: Record<string, unknown>;
  timeoutMs: number;
  redact?: string[];
  unavailableReason?: () => string | null;
  execute(args: A, ctx: ToolContext): Promise<ToolResult>;
}

export const emptyResult = (
  tool: { name: string; source: string },
  status: StepStatus,
  latencyMs: number,
  error: { code: string; message: string } | null = null,
): ToolResult => ({
  toolName: tool.name,
  source: tool.source,
  status,
  resultCount: 0,
  results: [],
  latencyMs,
  error,
});

export const okResult = (
  tool: { name: string; source: string },
  results: Evidence[],
  latencyMs: number,
): ToolResult => ({
  toolName: tool.name,
  source: tool.source,
  status: results.length > 0 ? Status.HAS_RESULT : Status.NO_RESULT,
  resultCount: results.length,
  results,
  latencyMs,
  error: null,
});

export async function runTool(
  tool: Tool<never>,
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const started = ctx.now();

  const unavailable = tool.unavailableReason?.();
  if (unavailable) {
    return emptyResult(tool, Status.UNAVAILABLE, 0, {
      code: 'TOOL_UNAVAILABLE',
      message: unavailable,
    });
  }

  const parsed = tool.inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return emptyResult(tool, Status.ERROR, ctx.now() - started, {
      code: 'LLM_BAD_TOOL_ARGS',
      message: `invalid arguments for ${tool.name}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
    });
  }

  const timer = new AbortController();
  const onAbort = () => timer.abort();
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => timer.abort(), tool.timeoutMs);

  try {
    return await tool.execute(parsed.data as never, { ...ctx, signal: timer.signal });
  } catch (e) {
    const err = toAppError(e);
    const timedOut = timer.signal.aborted && !ctx.signal.aborted;
    return emptyResult(
      tool,
      timedOut
        ? Status.TIMEOUT
        : err.code === 'TOOL_UNAVAILABLE'
          ? Status.UNAVAILABLE
          : Status.ERROR,
      ctx.now() - started,
      {
        code: timedOut ? 'TOOL_TIMEOUT' : err.code,
        message: timedOut ? `exceeded ${tool.timeoutMs}ms` : err.message,
      },
    );
  } finally {
    clearTimeout(timeout);
    ctx.signal.removeEventListener('abort', onAbort);
  }
}

export function redactArgs(tool: Tool<never>, args: unknown): unknown {
  if (!tool.redact?.length || typeof args !== 'object' || args === null) return args;
  const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  for (const key of tool.redact) if (key in out) out[key] = '[redacted]';
  return out;
}
