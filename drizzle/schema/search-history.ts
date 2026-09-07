/**
 * `search_history`, the log of what one reader looked up.
 *
 * IT IS ON THE SERVER NOW, AND THAT IS A REVERSAL. Until this table existed
 * the log lived only in the browser's own store, was capped there, and had no
 * endpoint to leave through. The reason given was privacy, and it did not
 * survive contact with the product: this is a dictionary, the server already
 * receives every word typed into it because it has to search the corpus with
 * it, and a device-only log is simply a log that does not follow the reader to
 * their phone. What the old design bought was a small reduction in RETENTION,
 * at the cost of the one thing a person actually wants from a history: finding
 * a word they looked up last week, on whatever device is in their hand. The
 * full argument, and what replaced it, is in
 * [ADR-0011](../../.adr/0011-plain-accounts-replace-the-encrypted-layer.md).
 *
 * IT IS NOT IN THE SYNC BLOB, AND MUST NOT BE. That document is rewritten
 * whole under a compare-and-swap on every push and it is capped at 2 MiB, so a
 * collection that grows with every query typed would spend the headroom the
 * reader's actual saved data needs. A log and a whole-document swap have
 * opposite write patterns. This is its own table with its own endpoint, which
 * is the shape `app/lib/local-store/BLOB-CONTENTS.md` sketched and declined to
 * build; it is built now.
 *
 * ONE ROW PER SEARCH, NOT ONE ROW PER LOOKUP. The unique index below is over
 * `(user_id, query, from_language, to_language)`, so searching one word five
 * times leaves one row carrying the latest instant. `headword_id` is
 * deliberately OUTSIDE that key: the same typed word can land on a different
 * top hit as the dictionary grows, and a reader who types the same thing twice
 * has run the same search either way. This is the identity the device store
 * used, kept unchanged so a migrated log collapses exactly as it did before.
 *
 * `onDelete: 'cascade'` is the erasure mechanism, as on `sync_blobs`: deleting
 * a user removes their whole log in the same statement, with no cleanup job to
 * forget to run.
 *
 * EVERY READ OR WRITE GOES THROUGH `getRawDb()`.
 */
import { relations, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { index, integer, pgTable, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

import { users } from './users';

export const searchHistory = pgTable(
  'search_history',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The text as typed, never folded. A log has to say what the person actually wrote. */
    query: text('query').notNull(),
    /**
     * The two sides the search RAN in, which is not always the pair the reader
     * stated: `detect` resolves to a real language before the search happens,
     * and the resolution is what makes the row repeatable.
     */
    fromLanguage: text('from_language').notNull(),
    toLanguage: text('to_language').notNull(),
    /** The headword the search landed on, or `NULL` when it matched none. Not part of the row's identity. */
    headwordId: text('headword_id'),
    /**
     * The answer the reader was shown, as a SNAPSHOT.
     *
     * `NULL` is a true state rather than a gap: a word being translated for the
     * first time is recorded before any answer exists, and the row renders the
     * term alone until one arrives. It is never re-read from the dictionary
     * afterwards. A later run may improve the answer, and a log of what a
     * person saw must keep saying what they saw.
     */
    translation: text('translation'),
    /** When the search ran. This IS the ordering key, and a repeat moves it rather than adding a row. */
    at: timestamp('at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('search_history_identity_idx').on(table.userId, table.query, table.fromLanguage, table.toLanguage),
    // The one read shape both screens use: this reader's rows, newest first.
    index('search_history_user_at_idx').on(table.userId, table.at.desc()),
  ],
);

export const searchHistoryRelations = relations(searchHistory, ({ one }) => ({
  user: one(users, { fields: [searchHistory.userId], references: [users.id] }),
}));

export type SelectSearchHistory = InferSelectModel<typeof searchHistory>;
export type InsertSearchHistory = InferInsertModel<typeof searchHistory>;
