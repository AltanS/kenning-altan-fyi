# 0013: The device dictionary is imported by the reader and never reaches the server

- **Status:** Accepted
- **Date:** 2026-10-07
- **Deciders:** operator (the idea, the file-import route and the no-dependency route), implementing agent (the design)

**Provenance.** The operator proposed a dictionary the reader downloads to the
device. The agent found that the upstream hosts block browser downloads, and the
operator then chose the two answers recorded below. The legal reading of the
CC BY-SA terms is NOT settled by this document. It is still the operator's to
get checked.

## Context

Kenning serves only rows whose source licence is CC0-1.0, CC-BY-2.0-FR or
CC-BY-4.0 (`app/lib/dictionary/licences.ts`). The large bilingual dictionaries
(Wiktionary derived, CC BY-SA, and GPL ones) were excluded by operator decision
because serving them would put a share-alike or copyleft duty on the product.
The two importers that remain, `wikidata-lexemes` and `tatoeba`, hold few
word-to-word links, so the corpus has no stored translation for most simple
words. `resolveTriggeredTranslationPanel` then queues a paid model call for a
word a dictionary could have answered for free.

Facts measured on 2026-10-07: `download.wikdict.com` and `kaikki.org` send no
`access-control-allow-origin`, so a page on `kenning.altan.fyi` cannot fetch
them. A WikDict pair file is SQLite, 20 to 26 MB. Its `simple_translation` table
holds 124,751 rows and 3.7 MB of text for `en-de`.

## Decision

The reader downloads a WikDict `xx-yy.sqlite3` file themself and picks it in
`/settings`. The browser converts it to a word index in its own IndexedDB
database (`kenning-device-dictionary`). A search in an imported direction looks
the word up there and shows the hit first. The server never fetches, stores,
proxies or serves any of it. The only thing that crosses to the server is a
cookie, `device-dict`, that lists the imported directions such as `de-en,en-de`.
The loader reads that cookie to decide not to queue the AI translation by itself.

When the device has a hit, the AI translation waits for a button ("Ask the AI as
well"). When the device has no hit, the AI starts by itself, as before.

A small read-only SQLite table reader is part of the code
(`app/lib/local-dictionary/sqlite-table-reader.ts`). It scans one table. No
SQLite package is added.

## Alternatives Considered

- **A one-click download button backed by a pass-through server route.** Best
  UX, but the server then handles the share-alike data in transit. Declined by
  the operator in favour of the clean line: the data never touches our server.
- **A SQLite WebAssembly package (`sql.js`, `@sqlite.org/sqlite-wasm`).** Works,
  but adds a dependency and about 25 MB of memory per open file, to read one
  table. The import needs a full scan of one table, which a small reader does.
- **Adding the CC BY-SA licence to `SERVED_LICENCES`.** A legal decision that
  makes every such row public in every surface. Not taken.
- **Storing the dictionary in TinyBase.** TinyBase syncs to the server in a
  blob. That would send the data to the server. Never.

## Consequences

- A reader without an imported file sees no change at all. The loader is
  byte-identical when the cookie is absent.
- Simple words in an imported direction cost no model call unless the reader asks.
- The dictionary hit is never written to `search_history`, the favourites
  snapshot, the sync blob or any prompt. `tests/unit/device-dictionary-never-reaches-server.test.ts`
  fails the build if a server module imports `app/lib/local-dictionary/`.
- The settings card shows the WikDict attribution and the CC BY-SA 4.0 licence.
- The cookie can outlive a cleared IndexedDB. That reads as a miss, so the AI
  runs as it did before. Nothing breaks.
- Open: the enrichment panel (`resolveTriggeredPanel`) still queues its own job
  for a headword that has senses. It is a separate cost and is not deferred here.
- Open: the operator still owes a legal check of the CC BY-SA terms for the
  on-screen display next to Kenning's own content.

## References

- Tracker milestone M208, `.tracker/M208-trl-device-dictionary/`.
- `app/lib/dictionary/licences.ts`, `tests/unit/dictionary-licences.test.ts`.
- ADR-0011 (plain accounts), ADR-0012 (a shared pool that is not dictionary data).
