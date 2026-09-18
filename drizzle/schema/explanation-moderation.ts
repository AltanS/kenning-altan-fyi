/**
 * `explanation_moderation`: the questions an operator has taken off the public
 * pages (M200).
 *
 * IT IS KEYED ON THE QUESTION, NOT ON ONE LEDGER ROW, and it carries no foreign
 * key onto the ledger, because a key is not a row. The operator's intent is
 * "this question must not be public", and the ledger is append only: a retry
 * after a failure, a later prompt version or a repair each opens a NEW row under
 * the same `(from, to, question_normalized)` triple. A per-row flag would be
 * lost the moment one of those opened, and the same question would be published
 * again under a new id with nobody having decided that.
 *
 * REPORTS STAY PER ROW, and the sibling table holds them. A report is a reader
 * saying one specific ANSWER is wrong; a hide is an operator saying one QUESTION
 * must not be shown. The operator screen maps a reported row back to its key
 * before it writes here.
 *
 * NO ROW MEANS VISIBLE. There is no `hidden` boolean and no soft delete: the
 * presence of the row is the whole state, so an un-hide is a `DELETE` and there
 * is no third reading for a listing query to get wrong.
 *
 * `hidden_by_user_id` IS `set null`, NOT `cascade`. Deleting the operator's
 * account must not silently un-hide everything they ever hid. The column records
 * who decided; the decision itself belongs to the installation.
 *
 * EVERY READ OR WRITE GOES THROUGH `getRawDb()`. This table describes no reader.
 */
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

import { users } from './users';

export const explanationModeration = pgTable(
  'explanation_moderation',
  {
    /** The language the words in the hidden question belong to. Plain text, like the ledger's own column. */
    fromLanguageCode: text('from_language_code').notNull(),
    /** The language the answer is written in. */
    toLanguageCode: text('to_language_code').notNull(),
    /** `normalizeQuery(question, from).normalized`, the same fold the cache key uses. */
    questionNormalized: text('question_normalized').notNull(),
    hiddenAt: timestamp('hidden_at', { withTimezone: true }).defaultNow().notNull(),
    /** Which operator decided. Null once that account is gone; the hide stands. */
    hiddenByUserId: integer('hidden_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Why, in the operator's own words. Never shown to a reader. */
    reason: text('reason'),
  },
  (table) => [
    // THE COMPOSITE KEY IS THE IDENTITY OF A QUESTION, and it is the same triple
    // the cache is keyed on. One hide per question, and a second attempt to hide
    // it is a no-op rather than a second row.
    primaryKey({ columns: [table.fromLanguageCode, table.toLanguageCode, table.questionNormalized] }),
  ],
);

export type InsertExplanationModeration = InferInsertModel<typeof explanationModeration>;
export type SelectExplanationModeration = InferSelectModel<typeof explanationModeration>;
