---
name: synced-collection-has-nine-seams
description: Adding a collection to Kenning's local store means editing nine enumerations plus two literal key-set assertions, or the rows strand on one device
metadata:
  type: project
---

A new SYNCED collection in `app/lib/local-store/` is not one file. It is nine
enumerations, and typecheck catches only six of them.

**Why:** the store's collections are named by hand in nine places rather than
derived from one list. `savedExplanations` (M198, `SCHEMA_VERSION` 4) is the
third collection to go in, after review state and favourites, and each time the
hazard is that a missed seam leaves the rows working perfectly on the device
that wrote them and invisible everywhere else, with every test green.

**How to apply:** edit, in this order.
- `schema.ts` — `SCHEMA_VERSION`, the `*_TABLE` const, the interface, and
  `LocalStoreSnapshot`.
- `store.ts` — re-export the table id.
- the collection's own module, mirroring `favorites.ts`.
- `blob-schema.ts` — `SyncedSnapshot`, `toSyncedSnapshot`, its zod schema,
  `syncedSnapshotSchema` (`.default([])`).
- `backup.ts` — its zod schema, `snapshotSchema`, `readSnapshot`,
  `importSnapshot`, `hasAnyLocalData`.
- `primary-store.ts` — the `PrimaryEntity` union, `purgeDeletedBefore`'s table
  list, `writeMergedSnapshot`.
- `sync/snapshot-sync.ts` — `SYNC_ENTITY_TYPES`, `SyncEntityValue`,
  `flattenSnapshot`, `MergedCollections`, `appendEntity`, `canonicalize`.
- `sync/local-store-bridge.ts` — `readLocalSnapshot`.
- `local-store/index.ts` — the exports.

Then the two seams NOTHING type-checks:
`tests/unit/personal/blob-serializer.test.ts` asserts the projection's key set
as a sorted LITERAL, twice, and `BLOB-CONTENTS.md` is normative about what the
document carries. Both must be updated by hand.

No migration step is needed for a pure ADDITION: both readers default every
collection to empty, so an older blob reads as "that device had none", which is
true. See [[jsonb-reorders-object-keys]], [[one-projection-decides-the-blob-keys]].
