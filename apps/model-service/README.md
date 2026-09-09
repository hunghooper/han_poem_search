# apps/model-service

The only Python in the online path. FastAPI wrapping BGE-M3 (dense embeddings, 1024-dim,
normalised) and bge-reranker-v2-m3, on CUDA.

Endpoints: `/embed/dense`, `/rerank`, `/health`.

It is a separate service rather than a library because the rest of the system is TypeScript and
these two models are the only reason Python is needed at all. Keeping them behind HTTP means
the Node side never grows a Python dependency, and the GPU box can be a different machine.

The embedding model's identity is recorded in the Qdrant collection metadata, and the API
refuses to start if they disagree. An index built with one model and queried with another
returns plausible nonsense, which is the worst failure available.
