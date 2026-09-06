/**
 * Client for the model sidecar — the spec §2.1.
 *
 * The sidecar is the only source of embeddings, at ingest time and at query time both. Nothing
 * else may embed text: two embedding paths that drift apart produce a vector index that
 * retrieves confidently and wrongly, with no error anywhere.
 */

import { AppError } from '@han/shared/errors';

export interface ModelHealth {
  ok: boolean;
  modelId: string;
  rerankerId: string;
  dim: number;
  normalized: boolean;
  openccConfig: string;
  device: string;
}

export interface ModelClientOptions {
  baseUrl: string;
  timeoutMs?: number;
}

const request = async <T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  what: string,
): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      throw new AppError('TOOL_UNAVAILABLE', `model service ${what} failed: HTTP ${res.status}`, {
        url,
        status: res.status,
      });
    }
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof AppError) throw e;
    const aborted = e instanceof Error && e.name === 'AbortError';
    throw new AppError(
      aborted ? 'TOOL_TIMEOUT' : 'TOOL_UNAVAILABLE',
      `model service ${what} ${aborted ? 'timed out' : 'is unreachable'}`,
      { url, cause: e instanceof Error ? e.message : String(e) },
    );
  } finally {
    clearTimeout(timer);
  }
};

export class ModelClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: ModelClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 15000;
  }

  async health(): Promise<ModelHealth> {
    const r = await request<{
      ok: boolean;
      model_id: string;
      reranker_id: string;
      dim: number;
      normalized: boolean;
      opencc_config: string;
      device: string;
    }>(`${this.baseUrl}/health`, { method: 'GET' }, this.timeoutMs, 'health');
    return {
      ok: r.ok,
      modelId: r.model_id,
      rerankerId: r.reranker_id,
      dim: r.dim,
      normalized: r.normalized,
      openccConfig: r.opencc_config,
      device: r.device,
    };
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const r = await request<{ vectors: number[][] }>(
      `${this.baseUrl}/embed/dense`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ texts }),
      },
      this.timeoutMs,
      'embed',
    );
    return r.vectors;
  }

  async rerank(query: string, documents: string[]): Promise<number[]> {
    if (documents.length === 0) return [];
    const r = await request<{ scores: number[] }>(
      `${this.baseUrl}/rerank`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, documents }),
      },
      this.timeoutMs,
      'rerank',
    );
    return r.scores;
  }
}
