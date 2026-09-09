# packages/batch

A file in, the same file plus columns out.

`detect.ts` works out which column holds the query — CJK ratio, fill rate, mean length.
`row.ts` builds one output row. `export-schema.ts` is the column registry.

## Columns are gated on the row having an answer

A row whose status says it found nothing must not carry a title, an author, or a form. Those
columns describe a candidate, and a run that found nothing has no candidate to describe —
naming one anyway is how a rejected guess becomes an answer in a spreadsheet nobody re-reads.

## `han_added` defaults on

Every other optional column defaults off. This one does not, for the same reason `han_status`
cannot be switched off at all: an added poem has no dataset, file or commit behind it and is
returned exactly as confidently as the ones that do. At scale, a row that cannot say what it is
gets read as a row like any other.

## Vietnamese form names live here

`form-label.ts` maps form codes to readable names. The map is a copy of one in
`packages/retrieval`, because this package must not depend on the retrieval layer to reach one
table. The cost of the copy is drift, so a test in `apps/api` — the one package that sees both
— asserts every form the verifier can produce has a name here.
