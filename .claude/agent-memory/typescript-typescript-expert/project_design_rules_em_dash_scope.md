---
name: design-rules-em-dash-scope
description: tests/unit/design-rules.test.ts bans em dashes in app/**/*.tsx and cli/**/*.ts, including comments, not just .tsx copy
metadata:
  type: project
---

`tests/unit/design-rules.test.ts` enforces two operator design rules
mechanically: no thick left border accents (`app/**/*.{css,tsx}`), and no em
dash, U+2014 (`app/**/*.tsx` AND `cli/**/*.ts`). The em-dash scan is a raw
line-level string scan, so it fires on comments too, not just rendered copy.
`cli/**/*.ts` is every `.ts` file under `cli/`, including `cli/lib/*.ts`, so a
new CLI command file's doc comments must avoid em dashes even though most of
this codebase's own `.server.ts`/`.md` comments use them freely elsewhere
(AGENTS.md and drizzle/schema/*.ts do, for instance; those extensions are not
scanned). Concretely: writing `cli/commands/*.ts` in this repo's own dense
comment style needs commas or parens in place of the usual em dash.

See [[project_kenning]].
