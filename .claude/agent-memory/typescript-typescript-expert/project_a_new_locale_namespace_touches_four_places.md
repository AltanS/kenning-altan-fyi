---
name: a-new-locale-namespace-touches-four-places
description: A new `app/locales/<lng>/<ns>.json` pair needs registering in i18n.ts AND meta-title.ts, and the locales test has a 20-key floor that a small namespace fails
metadata:
  type: project
---

Adding a namespace (e.g. `welcome`) means four edits, not two: the en/de JSON
pair, `app/i18n/i18n.ts` (`resources` and `ns`), and `app/i18n/meta-title.ts`
(`CATALOGS` and `NAMESPACES`). Miss the last one and a `meta()` key prefixed
`welcome:` is treated as an unregistered prefix, looked up in `common`, missed,
and the raw dotted key is rendered into the document head.

**Why:** `meta()` runs outside the React tree and must not touch the i18next
singleton, so it carries its own static copy of the catalogs.

**How to apply:** `tests/unit/i18n-locales.test.ts` discovers namespaces from
the `en` directory. Its "non-trivial catalog" case demanded >= 20 flattened
keys per namespace, which a one-screen namespace cannot meet; that floor is now
`SUBSTANTIAL_NAMESPACES` (common, legal) at 20 and everything else at 1. The
product name is NOT a catalog key, render `APP_NAME`.
