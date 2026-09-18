/**
 * `explanation_authorship`: who caused one `explanations` row to be written,
 * and what they chose to show beside it (M200).
 *
 * IT IS A THIRD TABLE, AND `explanations` STAYS READERLESS. The ledger itself
 * gains no column and no reader-facing index; the only edge between a person
 * and a row is this table's own foreign key, which points AT the ledger and
 * never the other way. An operator reading `explanations` while debugging a run
 * still meets no account id, which is the whole reason the header of
 * `drizzle/schema/explanations.ts` gives for keeping that table as it is.
 *
 * THE PRIMARY KEY IS `explanation_id` ALONE. One ledger row is one attempt to
 * answer one question, and exactly one request caused it, so there is one author
 * per authored row and never a (row, reader) pair. A composite key would invite
 * a second reader's row beside the first and leave every later read asking which
 * of them the byline means.
 *
 * THE ROW IS WRITTEN IN THE SAME TRANSACTION AS THE LEDGER ROW IT NAMES, inside
 * `enqueueExplain` and before the job is ever sent. The reason is written out in
 * full at the top of `app/lib/translation/explain-enqueue.server.ts`: that is
 * the last point in the call chain at which the two writes can still be
 * committed together, because everything after it has already left Postgres.
 *
 * `onDelete: 'cascade'` TWICE, AND BOTH MATTER. Off `explanations`, it is what
 * makes the dedupe path free: `deletePendingExplanation` removes the row a
 * losing request opened, and this row goes with it, so a deduped caller leaves
 * no authorship claim on a row that no longer exists. Off `users`, it is the
 * erasure mechanism every reader-owned table here uses: deleting a person takes
 * their bylines with them in the same statement.
 *
 * `listed` DEFAULTS TO TRUE AND `show_name` DEFAULTS TO FALSE, and the two are
 * independent. An explanation is public by its `listed` flag alone, whether or
 * not a name is attached; attaching one is a second, separate choice a reader
 * makes, and it can only be made once they have set a public name in
 * `user_profiles`. The initial `listed` value the write path supplies comes from
 * that same profile row, never from a value a client sent.
 *
 * THE INDEX ON `user_id` SERVES A SCREEN THAT DOES NOT EXIST YET, "which
 * explanations did this reader author". Nothing in M200 queries that direction.
 * It is here because the foreign key needs the reader column anyway and an index
 * added later would be a migration for a read the table was always going to get.
 *
 * EVERY READ OR WRITE GOES THROUGH `getRawDb()`.
 */
import { relations, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { boolean, index, integer, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';

import { explanations } from './explanations';
import { users } from './users';

export const explanationAuthorship = pgTable(
  'explanation_authorship',
  {
    /** The ledger row this claim is about. One author per row, so it is the whole key. */
    explanationId: uuid('explanation_id')
      .primaryKey()
      .references(() => explanations.id, { onDelete: 'cascade' }),
    /** Whose request opened that row. */
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Whether the item appears on the public pages at all. */
    listed: boolean('listed').default(true).notNull(),
    /** Whether the author's public name is written beside it. Needs a name to show. */
    showName: boolean('show_name').default(false).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('explanation_authorship_user_idx').on(table.userId)],
);

export const explanationAuthorshipRelations = relations(explanationAuthorship, ({ one }) => ({
  explanation: one(explanations, {
    fields: [explanationAuthorship.explanationId],
    references: [explanations.id],
  }),
  user: one(users, { fields: [explanationAuthorship.userId], references: [users.id] }),
}));

export type SelectExplanationAuthorship = InferSelectModel<typeof explanationAuthorship>;
export type InsertExplanationAuthorship = InferInsertModel<typeof explanationAuthorship>;
