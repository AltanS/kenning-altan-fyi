/**
 * `explanation_asks`, the log of what one reader has asked on `/explain`.
 *
 * IT IS A SECOND TABLE, AND `explanations` STAYS READERLESS. That table is a
 * shared ledger and a cache: one row per attempt to answer one question, keyed
 * by the question alone, carrying no account id, no session id and no address.
 * The header of `drizzle/schema/explanations.ts` says why, and this table does
 * not change it. The two answer different questions. That one answers "where
 * does this question stand, for anybody"; this one answers "what have I asked".
 * Folding a reader onto the ledger would make the second reader of a cached
 * answer indistinguishable from its author, and would put a person beside every
 * row an operator reads while debugging a run.
 *
 * A THIRD TABLE NAMES THE ASKER TOO, AND IT IS NARROWER THAN THIS ONE (M200).
 * This table records the ask whatever the panel answered, one served straight
 * from the cache included, with one exception: a question longer than
 * `EXPLAIN_MAX_QUESTION_CHARS` is refused before any run can open, and
 * `explain.tsx`'s loader writes no row for it. That length cap is the only
 * thing that stops the write, and it is the same length cap `refuseExplain`
 * applies.
 * `drizzle/schema/explanation-authorship.ts` records only the ledger row a
 * reader's own request OPENED, and it is the table the public pages read: an
 * answer with no row there is never listed. Removing a question deletes both,
 * `withdrawOwnAuthorship` before `removeExplanationAsk`, and deleting the
 * account cascades both away in the one statement. The ledger itself still
 * carries neither.
 *
 * WHY THE ASK IS STORED AT ALL, when the kept-explanation collection in the
 * device store was the earlier answer. A reader who asks a question and comes
 * back the next day had to have kept it deliberately, on a screen where keeping
 * was a second action after reading. Almost nobody takes it. Every asked
 * question is worth having back, the same way every search is, so the ask is
 * recorded by the loader and the reader chooses what to REMOVE rather than what
 * to keep.
 *
 * IT IS MODELLED ON `search_history`, DELIBERATELY AND DOWN TO THE INDEXES. One
 * row per distinct ask, an upsert that MOVES the instant rather than adding a
 * second row, and one index serving the single read shape, this reader's rows
 * newest first. A second shape here would be a second thing to keep in step
 * with a screen that looks exactly like `/history`.
 *
 * THE IDENTITY IS `(user, from, to, question_normalized)`, NOT THE RAW TEXT.
 * The fold is `normalizeQuery(question, from).normalized`, the same one the
 * ledger's cache key uses, so a reader who retypes their question with a
 * different capitalisation or a trailing question mark moves one row instead of
 * collecting near-duplicates. The text AS TYPED is kept beside it, because a log
 * has to say what the person actually wrote.
 *
 * `onDelete: 'cascade'` is the erasure mechanism, as on `search_history` and
 * `sync_blobs`: deleting a user takes their whole ask log with them in the same
 * statement, with no cleanup job to forget to run.
 *
 * NOTHING HERE IS LOGGED. This table holds an account id beside free text a
 * person typed, which makes its model one of the few places the product could
 * turn its own log file into a transcript. See `app/models/explanation-asks.server.ts`.
 *
 * EVERY READ OR WRITE GOES THROUGH `getRawDb()`.
 */
import { relations, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { index, integer, pgTable, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

import { users } from './users';

export const explanationAsks = pgTable(
  'explanation_asks',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The question as typed, trimmed and nothing else. It is what a re-ask would send. */
    question: text('question').notNull(),
    /** The folded form, `normalizeQuery(question, from).normalized`. Part of the row's identity. */
    questionNormalized: text('question_normalized').notNull(),
    /**
     * The two sides the ask RAN in, which is not always the pair the reader
     * stated: `detect` resolves to a real language before the panel is
     * resolved, and the resolution is what makes the row repeatable.
     */
    fromLanguage: text('from_language').notNull(),
    toLanguage: text('to_language').notNull(),
    /** When it was asked. This IS the ordering key, and a repeat moves it rather than adding a row. */
    askedAt: timestamp('asked_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('explanation_asks_identity_idx').on(
      table.userId,
      table.fromLanguage,
      table.toLanguage,
      table.questionNormalized,
    ),
    // The one read shape the list screen uses: this reader's rows, newest first.
    index('explanation_asks_user_asked_idx').on(table.userId, table.askedAt.desc()),
  ],
);

export const explanationAsksRelations = relations(explanationAsks, ({ one }) => ({
  user: one(users, { fields: [explanationAsks.userId], references: [users.id] }),
}));

export type SelectExplanationAsk = InferSelectModel<typeof explanationAsks>;
export type InsertExplanationAsk = InferInsertModel<typeof explanationAsks>;
