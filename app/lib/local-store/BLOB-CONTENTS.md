# What is inside the synced document, and what is deliberately not

`app/lib/sync/engine/envelope/` specifies the *envelope*: how the document is
framed, versioned and compare-and-swapped. This file is the other half, a
statement of what the client actually puts inside it.

IT IS PLAIN JSON, AND THE OPERATOR CAN READ IT (M191). The document used to be
encrypted under a key the server could not derive; the account model that
carried that key is gone, so every "the server cannot read this" sentence below
has been rewritten rather than softened. The one privacy claim that survives is
the one that was always structural: the search log is not in the document at
all.

## In the blob

- **Lists.** A user's vocabulary lists: name, order, timestamps.
- **List items.** The entries in those lists, each referencing a shared-zone
  headword or sense by its immutable UUID.
- **Notes.** Anything the user wrote for themselves against a word or a list.
- **Review state.** What the flashcard loop recorded about one saved word: how
  many times it was answered got-it, how many times still-learning, and when it
  was last reviewed. Keyed by the list entry's own id, one row per saved word.
- **Favourites.** The words a reader kept with one tap on an answer: the word,
  the answer as it read when it was kept, and the language pair it was given in.
  Addressed by `(headwordId, senseId, to)`, folded into the row's id, so one
  word kept twice is one row and one word kept into two target languages is two.

Every one of these is a record of what a person does not yet know, which is why
none of it is stored in plaintext. Review state is the sharpest case of that: a
word answered still-learning twenty times is a precise statement about a
person's competence, and the server is not the place for it.

Review state carries no schedule. There is no due instant, no gap length and no
ease factor, so there is nothing in the blob a future scheduling algorithm could
be mistaken for. That is a product decision (milestone M174), and if it is ever
reversed the new fields arrive with a `SCHEMA_VERSION` bump like any other.

Review state joined the blob at `SCHEMA_VERSION` 2 and favourites at 3. Neither
needed a migration in either direction: every collection defaults to empty on the
way in, so a blob written by a v1 device reads as "that device recorded no
reviews" and one written by a v2 device as "that device kept no favourites",
which is exactly what was true of each.

Favourites are in the blob and search history is not, and the two are less alike
than they look. A favourite is a deliberate keep, one row per word, bounded by
how many words a person chooses to star; the log grows with every query typed.
The blob is a whole-document compare-and-swap, so what it can afford is a
collection whose size is a decision the reader makes.

Conflicts between two devices are resolved per entity by last write wins on
`(lamport, deviceId)`. The compare-and-swap on `blobVersion` protects the blob;
the lamport pair resolves the entities inside it. The server does neither, and
cannot: it sees one opaque byte string.

## Not in the blob: search history

Search history is **not in the synced document**, and since 2026-09-07 that no
longer means it is device-only. It is a server table of its own,
`search_history`, written through `POST /api/search-history` and read by the two
screens that render it. The decision is recorded in
[ADR-0011](../../../.adr/0011-plain-accounts-replace-the-encrypted-layer.md).

**Why it is not in the blob.** The document is a whole-document
compare-and-swap, so every push rewrites every byte, and `MAX_BLOB_BYTES` is
2 MiB (`app/lib/sync/server/blob-store.server.ts`). A collection that grows with
every query typed would make every push heavier for every reader, permanently,
and would spend the headroom the reader's actual saved data needs. A log and a
whole-document swap have opposite write patterns. That reasoning is unchanged
and is why the log did not simply join the blob when it left the device.

**Why it is not device-only any more.** The old rule said the server must never
learn what anybody looked up. It did not survive being read closely. The search
loader receives every word typed, because it queries the shared corpus with it,
so a device-only log reduced retention rather than disclosure. What it cost was
the whole point of a history: a word looked up on a laptop was missing on the
phone, and clearing a browser profile took the log with it. This is a
dictionary, the rows are ordinary vocabulary, and erasure comes free with the
`ON DELETE cascade` every other personal table already uses.

**What that means for this file's promise.** The synced document still does not
carry the log, and `blob-schema.ts`'s projection plus the unit test on the
serialized bytes still say so. What changed is that the claim is now about the
BLOB alone, not about the service. The service holds the log in its own table.

## The append-only history log, as built

The separate log this file used to describe as unbuilt is built, in the shape it
predicted: its own table and its own endpoint, never merged into the
compare-and-swap document. It is keyed by `(user_id, query, from_language,
to_language)` rather than by `(deviceId, lamport)`, because it is not a merge
stream: one row is one search by one reader, an upsert moves it, and there is no
second device's write to reconcile.

## What the server knows

Everything in the document: the lists, the entries in them, the notes, the
review tallies and the favourites. That is the honest answer since M191, and the privacy page says
it in as many words.

AND, SINCE 2026-09-07, WHAT WAS LOOKED UP. The search log is a table of the
service, `search_history`, not a part of this document. It is still absent from
the blob, and that absence is kept true by the projection in
`app/lib/local-store/blob-schema.ts` plus a unit test on the serialized bytes
(`tests/unit/personal/blob-serializer.test.ts`), not by encryption.

`sync_blobs.size_bytes` is a denormalised copy of the document's length, so
reporting storage usage does not mean reading a 2 MiB column.
