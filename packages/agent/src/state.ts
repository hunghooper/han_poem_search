import type { Evidence } from '@han/shared/evidence';
import type { ToolResult } from '@han/shared/tool-result';
import type { StepStatus } from '@han/shared/status';

export interface SourceSummary {
  source: string;
  status: StepStatus;
  resultCount: number;
  latencyMs: number;
  errorCode?: string;
}

export interface AgentState {
  query: string;
  sources: SourceSummary[];
  flags: string[];
  evidence: Evidence[];
  iteration: number;
  toolCallsMade: string[];
}

export const initialAgentState = (
  query: string,
  flags: string[],
  sources: SourceSummary[],
): AgentState => ({
  query,
  sources,
  flags: [...flags],
  evidence: [],
  iteration: 0,
  toolCallsMade: [],
});

export function reduceToolResult(state: AgentState, tool: string, result: ToolResult): AgentState {
  return {
    ...state,
    sources: [
      ...state.sources.filter((s) => s.source !== result.source),
      {
        source: result.source,
        status: result.status,
        resultCount: result.resultCount,
        latencyMs: result.latencyMs,
        ...(result.error ? { errorCode: result.error.code } : {}),
      },
    ],
    evidence: [...state.evidence, ...result.results],
    toolCallsMade: [...state.toolCallsMade, tool],
    flags: [...new Set([...state.flags, `${result.source}_${result.status}`])],
  };
}

const SNIPPET_CHARS = 40;

export interface CompactState {
  query: string;
  iteration: number;
  sources: Array<{ source: string; status: string; results: number }>;
  flags: string[];
  candidates: Array<{
    id: string;
    title: string | null;
    author: string | null;
    edition: string | null;
    snippet: string;
  }>;
  toolsAlreadyCalled: string[];
}

export function compact(state: AgentState, maxCandidates = 5): CompactState {
  return {
    query: state.query,
    iteration: state.iteration,
    sources: state.sources.map((s) => ({
      source: s.source,
      status: s.status,
      results: s.resultCount,
    })),
    flags: state.flags,
    candidates: state.evidence.slice(0, maxCandidates).map((e) => ({
      id: e.id,
      title: e.title,
      author: e.author,
      edition: e.edition,
      snippet: e.content.replace(/\s+/gu, ' ').slice(0, SNIPPET_CHARS),
    })),
    toolsAlreadyCalled: [...new Set(state.toolCallsMade)],
  };
}

export const satisfied = (state: AgentState): boolean => state.evidence.length > 0;
