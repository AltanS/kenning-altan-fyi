---
name: drizzle-sql-array-renders-parenthesised
description: A JS array interpolated into a Drizzle `sql` template renders as `($1, $2)`, so `= any(${ids}::text[])` and `in (${ids})` both fail at runtime
metadata:
  type: project
---

Drizzle (0.39) renders `${someArray}` inside a `sql` template as a PARENTHESISED
parameter list, `($1, $2)`, never as one array parameter. So inside a raw
fragment write `where col in ${ids}` with NO braces of your own.

The two natural spellings both fail, and only at runtime against a real database:

- `= any(${ids}::text[])` → `cannot cast type record to text[]` (42846)
- `in (${ids})` → `operator does not exist: text = record` (42883)

**Why:** found writing the `translation_runs.written -> 'translations'`
containment test in `app/lib/reports/translation-feedback-export.server.ts`.
Typecheck and lint are both blind to it.

**How to apply:** any hand-written `sql` fragment that filters on a list of ids.
Only the integration tier catches it, so run the DB-backed test before believing
the statement works.

See [[project_verify_commands]].
