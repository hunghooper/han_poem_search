# packages/corpus

Fetching and ingesting the poem corpus: 78,000+ Tang poems and Song ci, around 800,000 lines.

Ingest is idempotent on a content hash of (edition, file, text, title), so re-running it does
not duplicate. Every poem records the dataset it came from, the source file, and the commit of
the source repository — that provenance is what lets a result say where it came from, and it is
the reason an added poem records an empty commit rather than borrowing one.
