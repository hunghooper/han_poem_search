"""Embedding and reranker sidecar — the spec §2.1.

The ONLY Python in the online path. Node cannot run these models well, so they are isolated
behind a small HTTP surface:

    POST /embed/dense   { texts }            -> { vectors }
    POST /rerank        { query, documents } -> { scores }
    GET  /health                             -> { modelId, dim, normalized, opencc_config }

The same service is imported as a library by the ingest pipeline, so index-time and query-time
embeddings come from one model. The API asserts on boot that the modelId reported here matches
the one recorded in the Qdrant collection metadata and refuses to start on mismatch — a silent
mismatch is the most common invisible failure in this architecture.
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from typing import Annotated

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from sentence_transformers import CrossEncoder, SentenceTransformer

log = logging.getLogger("model-service")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper())

EMBEDDING_MODEL_ID = os.environ.get("EMBEDDING_MODEL_ID", "BAAI/bge-m3")
RERANKER_MODEL_ID = os.environ.get("RERANKER_MODEL_ID", "BAAI/bge-reranker-v2-m3")

# Must match packages/retrieval/src/normalize.ts. Reported on /health so a drift between the
# two normalizations is visible rather than silently degrading recall.
OPENCC_CONFIG = "cn2tw+tw2cn"

# The reranker is loaded lazily: on a 6GB card both models resident at once leaves little room
# for activations, and reranking only happens after retrieval has produced candidates.
_state: dict[str, object] = {}


def _device() -> str:
    return "cuda" if torch.cuda.is_available() else "cpu"


def _dtype():
    """fp32 everywhere, unless the GPU has tensor cores.

    MEASURED, not assumed: on the development GPU (GTX 1660 Ti) fp16 embedding ran at 2/s
    against 14/s in fp32 — seven times SLOWER. That card is TU116, the one Turing die shipped
    without tensor cores, so half precision gets no matmul acceleration and falls back to
    slower kernels. Half precision is a real win on cards that have tensor cores (compute
    capability >= 7.0 excluding TU11x), so it is enabled by capability rather than banned.
    """
    if not torch.cuda.is_available():
        return torch.float32
    major, minor = torch.cuda.get_device_capability()
    name = torch.cuda.get_device_name(0)
    has_tensor_cores = (major, minor) >= (7, 0) and "GTX 16" not in name
    return torch.float16 if has_tensor_cores else torch.float32


def embedder() -> SentenceTransformer:
    if "embedder" not in _state:
        log.info("loading %s on %s", EMBEDDING_MODEL_ID, _device())
        _state["embedder"] = SentenceTransformer(
            EMBEDDING_MODEL_ID,
            device=_device(),
            model_kwargs={"torch_dtype": _dtype()},
        )
    return _state["embedder"]  # type: ignore[return-value]


def reranker() -> CrossEncoder:
    if "reranker" not in _state:
        log.info("loading %s on %s", RERANKER_MODEL_ID, _device())
        _state["reranker"] = CrossEncoder(
            RERANKER_MODEL_ID,
            device=_device(),
            max_length=512,
            model_kwargs={"torch_dtype": _dtype()},
        )
    return _state["reranker"]  # type: ignore[return-value]


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Load the embedder eagerly so /health is honest the moment the service accepts traffic:
    # a health check that passes before the model exists is worse than a slow boot.
    embedder()
    yield
    _state.clear()


app = FastAPI(title="han model service", version="0.1.0", lifespan=lifespan)


class EmbedRequest(BaseModel):
    texts: Annotated[list[str], Field(min_length=1, max_length=512)]
    # Index-time and query-time embeddings must be produced identically; the only legitimate
    # asymmetry is a prompt prefix, which BGE-M3 does not require.
    normalize: bool = True


class EmbedResponse(BaseModel):
    vectors: list[list[float]]
    model_id: str
    dim: int
    normalized: bool


class RerankRequest(BaseModel):
    query: str
    documents: Annotated[list[str], Field(min_length=1, max_length=200)]


class RerankResponse(BaseModel):
    scores: list[float]
    model_id: str


class HealthResponse(BaseModel):
    ok: bool
    model_id: str
    reranker_id: str
    dim: int
    normalized: bool
    opencc_config: str
    device: str
    dtype: str
    reranker_loaded: bool


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    m = embedder()
    return HealthResponse(
        ok=True,
        model_id=EMBEDDING_MODEL_ID,
        reranker_id=RERANKER_MODEL_ID,
        dim=m.get_sentence_embedding_dimension() or 0,
        normalized=True,
        opencc_config=OPENCC_CONFIG,
        device=_device(),
        dtype=str(_dtype()).replace("torch.", ""),
        reranker_loaded="reranker" in _state,
    )


@app.post("/embed/dense", response_model=EmbedResponse)
def embed_dense(req: EmbedRequest) -> EmbedResponse:
    if any(not t.strip() for t in req.texts):
        # An empty string embeds to something, and that something is a plausible-looking vector
        # that will match arbitrary poems. Reject rather than index noise.
        raise HTTPException(status_code=422, detail="texts must not contain blank entries")

    m = embedder()
    vectors = m.encode(
        req.texts,
        normalize_embeddings=req.normalize,
        convert_to_numpy=True,
        show_progress_bar=False,
        batch_size=64,
    )
    return EmbedResponse(
        vectors=[v.tolist() for v in vectors],
        model_id=EMBEDDING_MODEL_ID,
        dim=int(vectors.shape[1]),
        normalized=req.normalize,
    )


@app.post("/rerank", response_model=RerankResponse)
def rerank(req: RerankRequest) -> RerankResponse:
    if not req.query.strip():
        raise HTTPException(status_code=422, detail="query must not be blank")

    scores = reranker().predict(
        [(req.query, d) for d in req.documents],
        show_progress_bar=False,
        batch_size=16,
    )
    return RerankResponse(scores=[float(s) for s in scores], model_id=RERANKER_MODEL_ID)
