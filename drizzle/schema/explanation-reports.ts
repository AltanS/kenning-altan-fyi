/**
 * `explanation_reports`: a signed-in reader flagging one public answer (M200).
 *
 * PER ROW, WHERE A HIDE IS PER QUESTION. A report is a statement about one
 * specific answer, the prose the reader is looking at, so it points at the
 * ledger row that carries it. The moderation table beside this one is keyed on
 * the question instead, and its own header says why.
 *
 * REPORTING NEEDS AN ACCOUNT, which is why there is a foreign key here at all.
 * An anonymous report channel is a channel for mass-flagging a disliked answer
 * at no cost to the person doing it, and the same argument already gates voting.
 *
 * THE UNIQUE INDEX IS THE "ONE REPORT PER READER PER ANSWER" RULE. A repeat
 * report from the same reader upserts: it replaces the reason and moves
 * `created_at`, rather than stacking rows and making the operator's count a
 * count of clicks.
 *
 * BOTH LINKS CASCADE. A report about an answer that no longer exists flags
 * nothing, and deleting a person takes their reports with them in the same
 * statement, which is the erasure path every reader-owned table here uses.
 *
 * REPORTING HIDES NOTHING BY ITSELF. Nothing automatic reads this table: it is
 * a queue a person triages on `/super/explanations`, and the hide is a separate,
 * explicit decision written to the moderation table.
 *
 * EVERY READ OR WRITE GOES THROUGH `getRawDb()`.
 */
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { integer, pgTable, serial, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { explanations } from './explanations';
import { users } from './users';

export const explanationReports = pgTable(
  'explanation_reports',
  {
    id: serial('id').primaryKey(),
    /** The answer being flagged. */
    explanationId: uuid('explanation_id')
      .notNull()
      .references(() => explanations.id, { onDelete: 'cascade' }),
    /** Who flagged it. Never shown on any screen, operator's included. */
    accountId: integer('account_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** What they said is wrong, at most 500 characters. Null when they sent none. */
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex('explanation_reports_reader_idx').on(table.explanationId, table.accountId)],
);

export type InsertExplanationReport = InferInsertModel<typeof explanationReports>;
export type SelectExplanationReport = InferSelectModel<typeof explanationReports>;
