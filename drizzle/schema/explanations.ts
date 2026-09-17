import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { pgTable, text, integer, jsonb, numeric, timestamp, uuid, index, check } from 'drizzle-orm/pg-core';
import type { JsonValue } from '#app/lib/json';
import { languages } from './dictionary';

// =============================================================================
// Explanations (the run record AND the cache for one typed question)
// =============================================================================
// One row per attempt to have a model answer one free-text question about words
// in one language, written in another. The row is opened `pending` by the
// request that queued the job and updated once, to `ok`, `failed` or `budget`,
// by the job that finishes it. On `ok` it also carries the answer, so the row is
// what a later reader is served: there is nowhere else for an explanation to
// live.
//
// It is the third table of this shape, after `translation_runs` and
// `phrase_translations`, and it is deliberately a sibling of the second rather
// than a column on it. The reasons below are the ones that differ.
//
// 1. WHY THIS IS NOT DICTIONARY DATA, AND MUST NEVER BECOME IT
//   The dictionary tables describe WORDS under a natural key of
//   `(language_code, lemma, pos)`, and an edge joins two senses. An answer to
//   "when do I use Feierabend" is none of those things: it is prose about
//   several words at once, keyed by the QUESTION rather than by any one of them.
//   Writing it into `senses` or `translations` would put a row outside the key
//   every importer shares, and then the corpus counts, the lemma search, the
//   attribution page and the retraction path would all be answering about a
//   paragraph while reporting about the dictionary. The feature ends here, in
//   its own table, and the job that fills it in writes to nothing else.
//
// 2. WHY THE ANSWER IS `jsonb` AND NOT A COLUMN PER PART
//   The answer has five parts and two of them are nested lists, so a column per
//   part would be five columns and two child tables for a document nothing ever
//   queries INSIDE. Every read of this table is "the latest row for this
//   question", and the answer is then handed whole to the card. The document's
//   shape is pinned by `explanationSchema`, which the job parses through before
//   the write, so the column holds a validated shape rather than whatever a
//   model happened to say.
//
//   A ROUND TRIP THROUGH `jsonb` REORDERS OBJECT KEYS. Nothing here depends on
//   key order, and nothing may: a test comparing the stored document to a
//   literal must compare a key-sorted encoding, never the bytes.
//
// 3. WHAT A ROW SAYS ABOUT A READER, WHICH IS NOTHING
//   It records the QUESTION and never the person. There is no account id, no
//   session id, no device id and no address, and no log line in the explain path
//   pairs one with the other either. That is the same line `phrase_translations`
//   holds, and it matters more here, not less: a question is a more revealing
//   thing to have typed than a word. The question itself IS kept, because the
//   second reader asking the same thing is served this row rather than a second
//   paid call.
//
// APPEND ONLY, AND DELIBERATELY NO UNIQUE KEY ON THE CACHE TRIPLE
//   A run is a record of one moment: a reader retrying after a failure, a later
//   prompt version and a different model are each a NEW fact. A unique key on
//   `(from, to, question_normalized)` would force the second one to overwrite
//   the first and destroy the record of what the first attempt did. Anything
//   asking "where does this question stand" reads the LATEST row, which is what
//   the index below serves; the cache read asks the same index for the latest
//   `ok` row.
//
// This table describes no reader, so it is reached through `getRawDb()` and no
// filter narrows it to one.
// =============================================================================

export const explanations = pgTable(
  'explanations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The language the WORDS in the question belong to. */
    fromLanguageCode: text('from_language_code')
      .notNull()
      .references(() => languages.code),
    /** The language the explanation is WRITTEN IN. It is not a translation target. */
    toLanguageCode: text('to_language_code')
      .notNull()
      .references(() => languages.code),
    /** The question as the reader typed it, whitespace-trimmed and nothing else. It is what the model is shown. */
    question: text('question').notNull(),
    /**
     * The cache key: `normalizeQuery(question, from).normalized`.
     *
     * THE SAME FOLD THE WORD AND PHRASE PATHS USE, and it is the right one here
     * for the same reason: it lower-cases, collapses runs of whitespace and
     * strips the punctuation at the ends, so "What is the difference between
     * kennen and wissen?" and "what is the difference between kennen and wissen"
     * are one cache entry and the second reader pays nothing. It removes nothing
     * from the middle of the text, so no word of the question is lost.
     *
     * IT IS STORED RATHER THAN COMPUTED ON READ, because the read is an index
     * lookup on three columns and a function call in the WHERE clause would make
     * it a scan.
     */
    questionNormalized: text('question_normalized').notNull(),
    /** `pending`, `ok`, `failed` or `budget`, pinned by the check constraint below. */
    status: text('status').notNull().default('pending'),
    /**
     * The parsed `Explanation` document. Only ever set on an `ok` row.
     *
     * VALIDATED BEFORE IT IS WRITTEN. The job hands `explanationSchema` to
     * `registry.complete`, so a malformed answer rejects the call and ends the
     * run `failed` rather than landing a shape the card cannot draw.
     */
    // `$type<JsonValue>()` rather than the bare column, whose select type is
    // `unknown`. `unknown` forces every reader to either assert a shape onto it
    // or take an unparsed parameter, and the lint gate refuses both. `JsonValue`
    // is what a jsonb column genuinely holds, so the model's decode step takes a
    // named domain type and needs no assertion.
    answer: jsonb('answer').$type<JsonValue>(),
    // Plain text with no narrowing and no check constraint, for the reason
    // `translation_runs.provider` gives: the catalog is a live list, and a row
    // written through a provider that is later removed from it must stay
    // readable.
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    promptVersion: integer('prompt_version').notNull(),
    /** Nullable: the pricing table does not cover every model, so a cost is sometimes unknown rather than zero. */
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }),
    latencyMs: integer('latency_ms'),
    /** The failure text. Only ever set on a `failed` or `budget` row. */
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    /** When the job wrote its terminal status. Null while the row is still `pending`. */
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    check('explanations_status_check', sql`status in ('pending', 'ok', 'failed', 'budget')`),

    // The pane's one read: the latest row for one direction and one folded
    // question. It starts from the three columns the input card and the language
    // bar supply, and it ends in `created_at desc` so the newest row is the first
    // one the index yields. The cache read adds a status test on top of the same
    // three columns.
    index('explanations_latest_idx').on(
      table.fromLanguageCode,
      table.toLanguageCode,
      table.questionNormalized,
      table.createdAt.desc(),
    ),
  ],
);

export type InsertExplanation = InferInsertModel<typeof explanations>;
export type SelectExplanation = InferSelectModel<typeof explanations>;

// No relations are declared, for the reason `phrase-translations.ts` gives: two
// relations from one table to `languages` need a `relationName` on BOTH sides,
// with the matching `many()` side living in `dictionary.ts`, which does not know
// this table exists. A half-declared pair reads as valid and fails when a query
// uses it, so the direction columns are read as plain text instead.
