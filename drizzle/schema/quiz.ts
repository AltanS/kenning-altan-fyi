/**
 * The quiz scaffold: a shared, global pool of starter flashcards for a
 * language pair, generated once by a model and reused by every reader after.
 *
 * A SCAFFOLD CARD IS NEVER DICTIONARY DATA, for the same class of reason a
 * phrase answer is not (M195, `drizzle/schema/phrase-translations.ts`). It is
 * a flashcard-shaped fact, a word, a translation and a short note, not a
 * sense-to-sense edge. Forcing it through `headwords`/`senses`/`translations`
 * would need a sense graph, a licence and a pos precision nothing here reads,
 * for a row the dictionary query never serves. It has its own table instead.
 *
 * THIS TABLE GROWS, IT IS NEVER PRUNED OR REFRESHED. Once a card is written
 * for a pair it is read forever, the way a generated dictionary row is
 * (`translate-headword.ts`). A quiz session that finds it stale is a product
 * decision for a later milestone, not a reason to delete it now.
 *
 * `quiz_scaffold_runs` IS THE DEDUPE GUARD, AND IT IS NOT A CACHE OF STATUS
 * ANYBODY POLLS. Unlike `translation_runs`, nothing on screen reads it: a
 * quiz session only ever asks "are there cards for this pair", never "is a
 * backfill running". Its whole job is to make sure at most one backfill is
 * ever REQUESTED per pair, which is why it is ONE ROW per `(from, to)` rather
 * than an append-only ledger: `claimScaffoldRun` (`app/models/quiz.server.ts`)
 * opens it with an upsert, and only the caller whose write actually landed
 * gets to enqueue the job.
 *
 * THAT ONE ROW IS RE-CLAIMABLE, NOT A PERMANENT LOCK. A `pending` row still
 * blocks every other caller, because a job is already queued or running, and
 * an `ok` row blocks every other caller too, because the pair is already
 * served. A `failed` or `budget` row is different: both mean nothing was ever
 * written, and `claimScaffoldRun`'s `ON CONFLICT ... DO UPDATE ... WHERE
 * status IN ('failed', 'budget')` resets exactly those two back to `pending`
 * for the next caller. Without this a single budget refusal, or a missing
 * provider key, would strand a language pair with no cards forever: this
 * table has no append-only fallback the way `translation_runs` does, so the
 * one row that exists is the only chance this pair ever gets unless it can be
 * reopened.
 */
import { relations, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { check, index, integer, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { sources } from './dictionary';

export const QUIZ_SCAFFOLD_RUN_STATUSES = ['pending', 'ok', 'failed', 'budget'] as const;
export type QuizScaffoldRunStatus = (typeof QUIZ_SCAFFOLD_RUN_STATUSES)[number];

export const quizScaffoldCards = pgTable(
  'quiz_scaffold_cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fromLanguageCode: text('from_language_code').notNull(),
    toLanguageCode: text('to_language_code').notNull(),
    lemma: text('lemma').notNull(),
    /** Lowercased, unaccented form of `lemma`. Same normaliser the dictionary uses, so the unique index means what it looks like it means. */
    lemmaNormalized: text('lemma_normalized').notNull(),
    translation: text('translation').notNull(),
    pos: text('pos'),
    /** A short usage note, mirroring `translations.note` (M196). Optional: a scaffold word is not always worth disambiguating. */
    note: text('note'),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // ONE ROW PER WORD PER PAIR, ENFORCED, NOT JUST INTENDED. `writeScaffoldCards`
    // (`app/models/quiz.server.ts`) upserts on exactly these three columns with
    // `onConflictDoNothing()`; that only ever suppresses a duplicate if this is a
    // real unique index rather than a plain one, which a plain `index()` is not.
    uniqueIndex('quiz_scaffold_cards_pair_lemma_idx').on(table.fromLanguageCode, table.toLanguageCode, table.lemmaNormalized),
    // THE ONLY READ SHAPE: a deck being assembled for one pair, newest first
    // is irrelevant since every card is equally "the scaffold", so no
    // ordering column is indexed.
    index('quiz_scaffold_cards_pair_idx').on(table.fromLanguageCode, table.toLanguageCode),
  ],
);

export type InsertQuizScaffoldCard = InferInsertModel<typeof quizScaffoldCards>;
export type SelectQuizScaffoldCard = InferSelectModel<typeof quizScaffoldCards>;

export const quizScaffoldCardsRelations = relations(quizScaffoldCards, ({ one }) => ({
  source: one(sources, { fields: [quizScaffoldCards.sourceId], references: [sources.id] }),
}));

export const quizScaffoldRuns = pgTable(
  'quiz_scaffold_runs',
  {
    fromLanguageCode: text('from_language_code').notNull(),
    toLanguageCode: text('to_language_code').notNull(),
    status: text('status').notNull().default('pending'),
    /** How many cards this backfill asked the model for. Informational; the actual count written can be fewer. */
    requestedCount: integer('requested_count').notNull(),
    written: integer('written'),
    error: text('error'),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.fromLanguageCode, table.toLanguageCode] }),
    check('quiz_scaffold_runs_status_check', sql`${table.status} IN ('pending', 'ok', 'failed', 'budget')`),
  ],
);

export type InsertQuizScaffoldRun = InferInsertModel<typeof quizScaffoldRuns>;
export type SelectQuizScaffoldRun = InferSelectModel<typeof quizScaffoldRuns>;
