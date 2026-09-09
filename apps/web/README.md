# apps/web

Next.js 15 / React 19 front end. Four tabs: single search, batch, corpus additions, and the
proposal history.

## Everything is translated, including the reasoning

`src/components/i18n.ts` holds UI labels; `src/components/i18n-trace.ts` holds the sentences
the _server_ produced. Those are separate on purpose: the second set is the system explaining
why it decided what it decided, and a Vietnamese page that answers that in English has failed
at the only part that was hard.

The server sends a code and its values, not a finished sentence, and `tTrace` renders it here.
That is what lets one recorded run be re-read in a different language without re-searching.

`i18n.test.ts` checks all three dictionaries have identical key sets, and every trace code has
a label in every language — in both directions. Without it, a key added in one language and
forgotten in another is invisible to anyone working in that one language.

## Settings are per browser

Thresholds, model choice, language and the agent toggle live in `localStorage` and travel with
each request. They never write the project's configuration. A visitor can experiment without
changing what anyone else sees.
