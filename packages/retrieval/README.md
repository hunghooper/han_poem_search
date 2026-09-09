# packages/retrieval

Everything that finds a poem: normalisation, the four retrievers, fusion, the confidence
policy, and the prosody checks.

## Normalisation decides what "the same" means

`normalize.ts` folds variants and produces a match form. Two line-splitting functions exist and
they are not interchangeable: `visualLines` is for display, `prosodyLines` is for form checks.
A spreadsheet cell holds a whole couplet on one line, and comparing that against a
five-character poem fails a poem it matched exactly.

## The confidence policy is where honesty lives

`confidence.ts` decides between "here is the answer", "here is a guess", and "nothing". Two
gates matter:

- **A lexical-overlap floor applied before the score is read.** A candidate sharing almost
  nothing with the query is not a low-confidence answer; it is not an answer. Calibrated over
  686 real matches: a 0.15 floor rejects 0.9% of them, and all six were wrong on inspection.
- **An exact run below that floor is a coincidence, not a match.** One example from the
  calibration set resolved to a later poem that _quotes_ the phrase being searched for.

## Prosody rejects almost nothing, on purpose

`verify/` checks form, rhyme and tone against tables derived from the corpus itself. Tone
**never rejects**: over 25,000 poems, 22% of everything the shape classifier calls regulated
verse fails its own tone check — all of them correct answers by construction. A check that
fires on a fifth of correct answers teaches the reader to ignore the column.
