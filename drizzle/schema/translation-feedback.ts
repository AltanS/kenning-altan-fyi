import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { pgTable, text, timestamp, uuid, integer, index, check, primaryKey } from 'drizzle-orm/pg-core';
import { REJECTION_REASONS } from '#app/lib/translation/rejection';
import { users } from './users';
import { headwords, languages } from './dictionary';
import { translationRuns } from './translation-runs';

// =============================================================================
// Rejecting a generated answer: the fact, the signal, and the spend guard
// =============================================================================
// A reader reads a translation this installation had a model write, and says it
// is off. That single press produces TWO rows in two tables, and the split
// between them is the whole design. `translation_rejections` knows WHO, and
// `translation_rejection_signals` knows WHAT. Nothing joins them.
//
// All three tables describe the shared dictionary and the runs that wrote it,
// so every one of them is reached through `getRawDb()` and no filter narrows
// them to a reader.
// =============================================================================

// =============================================================================
// The fact: one reader rejected one run
// =============================================================================
// THIS TABLE CARRIES THE SAME GOVERNANCE AS `explanation_votes`, AND THE REASON
// IS THE ROW IT POINTS AT, NOT THE FEATURE IT SERVES.
//   `translation_votes` points at a `translations` edge, and the header of
//   `drizzle/schema/votes.ts` argues that an edge is a shared-zone object: it
//   asserts that one sense renders another, it was written by a source, and it
//   exists whether or not anybody ever searched for it. A `translation_runs`
//   row is NOT that. It exists only BECAUSE SOMEBODY SEARCHED: the run was
//   opened by one reader's query, and its `headword_id` and its direction are
//   on it. So a row here is closer to an `explanation_votes` row than to a
//   `translation_votes` one, and it inherits that table's rule rather than this
//   feature's neighbours':
//
//     no admin export of the account column, no "everything this account
//     rejected" query path, no API route and no CLI command reading it per
//     account, EVER.
//
//   An operator triaging bad answers reads the signals table, which names no
//   reader at all, so the triage screen never needs this table and must not
//   learn to read it.
//
// WHAT THIS TABLE MUST NEVER CARRY: no lemma, no headword, no query text and no
// language pair. Every one of those is one join away on the run row, and a join
// is a deliberate act somebody has to write. A COLUMN is not: adding one would
// put the word and the reader on the same row, and the product's claim would be
// lost with no bug and no other change, because the row would then say WHO
// looked up WHAT.
// =============================================================================

export const translationRejections = pgTable(
  'translation_rejections',
  {
    // `cascade` because a rejection of a run that no longer exists judges an
    // answer nobody can read. It is a statement about what a rejection MEANS,
    // not a prediction that runs get deleted.
    runId: uuid('run_id')
      .notNull()
      .references(() => translationRuns.id, { onDelete: 'cascade' }),
    // THE REAL USER, WITH A REAL FOREIGN KEY. The column is named `account_id`
    // to match the three vote tables, which have carried that name since before
    // M191 replaced the encrypted account model with a plain one; a row here
    // still means "one reader's judgement".
    //
    // `cascade` is also what makes account deletion a single DELETE that leaves
    // nothing behind, which is the self-serve erasure path.
    accountId: integer('account_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // THE COMPOSITE KEY IS THE RULE, AND IT IS WHAT MAKES A SECOND PRESS HARMLESS.
    // "One rejection per reader per run" is not enforced anywhere in the
    // application; it is this primary key. A second press hits the conflict and
    // REPLACES nothing, so it cannot be counted twice. Without the key one
    // annoyed reader would look like a crowd, and the signals beside it would
    // read as agreement between people who do not exist.
    primaryKey({ columns: [table.runId, table.accountId] }),

    // The primary key starts with `runId`, so it cannot serve a read that starts
    // from the account. The index exists for the cascade on account deletion,
    // which is the erasure path, and for NOTHING ELSE: it is not an invitation
    // to add a per-reader listing. See the governance note above.
    index('translation_rejections_account_idx').on(table.accountId),
  ],
);

export type InsertTranslationRejection = InferInsertModel<typeof translationRejections>;
export type SelectTranslationRejection = InferSelectModel<typeof translationRejections>;

// =============================================================================
// The signal: what was wrong with one run. NO ACCOUNT COLUMN, EVER.
// =============================================================================
// THIS IS THE ROW THE FINE-TUNING CORPUS READS, and the split from the table
// above is the whole point of having two tables rather than one with a `reason`
// column on it.
//
//   The fact table knows WHO rejected. This table knows WHAT was wrong. Nothing
//   joins them in an export, and nothing may: a corpus that carries the reason
//   codes is a corpus of judgements about answers, while the same corpus with
//   an account id on it is a record of what named people looked up and
//   disliked.
//
//   AN `account_id` COLUMN ADDED HERE WOULD COLLAPSE THE SPLIT WITH NO BUG AND
//   NO OTHER CHANGE, and that collapse is the exact thing the split exists to
//   prevent. `tests/unit/rejection-signals-carry-no-account.test.ts` is the
//   automated guard, so a reader who arrives at this header finds the check as
//   well as the rule.
//
// THE REASON IS A FIXED CODE AND NEVER FREE TEXT. Free text about a word,
// written by a named reader, is the search log this product says it does not
// keep, and a free-text box invites exactly that sentence. The four codes are
// declared in `app/lib/translation/rejection.ts`, a pure module the browser can
// also read, and the check constraint below is BUILT FROM THAT TUPLE so the
// database and the TypeScript union cannot drift apart. Adding a member means a
// migration: the constraint has to be dropped and rewritten before any row can
// carry the new code.
//
// APPENDED, NOT UPSERTED. One row per accepted rejection, so the table is a
// tally. The fact table's primary key is what stops one reader appending twice;
// see `recordRejection` in `app/models/translation-rejections.server.ts`, which
// writes the signal ONLY when the fact row was genuinely new.
// =============================================================================

/** `'missing', 'wrong', 'register', 'other'`, as SQL, from the one tuple that declares them. */
const REASON_CODES_SQL = REJECTION_REASONS.map((reason) => `'${reason}'`).join(', ');

export const translationRejectionSignals = pgTable(
  'translation_rejection_signals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // `cascade` for the same reason the fact row cascades: a complaint about a
    // run that no longer exists describes an answer nobody can read.
    runId: uuid('run_id')
      .notNull()
      .references(() => translationRuns.id, { onDelete: 'cascade' }),
    /** One of `REJECTION_REASONS`, pinned by the check constraint below. */
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check('translation_rejection_signals_reason_check', sql.raw(`reason in (${REASON_CODES_SQL})`)),

    // The one read this table serves: "how many complaints does this run have,
    // and about what". It starts from the run id, which is the only thing any
    // caller holds, and there is deliberately no second read shape.
    index('translation_rejection_signals_run_idx').on(table.runId),
  ],
);

export type InsertTranslationRejectionSignal = InferInsertModel<typeof translationRejectionSignals>;
export type SelectTranslationRejectionSignal = InferSelectModel<typeof translationRejectionSignals>;

// =============================================================================
// Re-translation cooldown
// =============================================================================
// THIS IS A SPEND GUARD, NOT BOOKKEEPING, and it is `reenrichment_log` for the
// translation side, down to its shape.
//
// A re-translation is a paid model call. Without a cooldown, a small group of
// readers can queue one for the same headword as often as they can press the
// button, and the bill is theirs to set rather than ours. One row per
// (headword, direction) records when that pair was last queued; the queueing
// path upserts the row and refuses a request that arrives inside the window.
//
// The grain is the headword AND the direction because that is what a re-run
// actually costs. The same word from German into English and from English into
// German are two separate model calls, so a cooldown keyed on the headword alone
// would let one direction's request silently block the other's.
//
// The window itself is `RETRANSLATION_COOLDOWN_HOURS`, beside the predicate
// that reads it, in `app/lib/translation/rejection.ts`.
// =============================================================================

export const retranslationLog = pgTable(
  'retranslation_log',
  {
    headwordId: uuid('headword_id')
      .notNull()
      .references(() => headwords.id),
    fromLanguageCode: text('from_language_code')
      .notNull()
      .references(() => languages.code),
    toLanguageCode: text('to_language_code')
      .notNull()
      .references(() => languages.code),
    /** Overwritten on every queued re-translation. The row is a cursor, not a history. */
    lastQueuedAt: timestamp('last_queued_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.headwordId, table.fromLanguageCode, table.toLanguageCode] })],
);

export type InsertRetranslationLogEntry = InferInsertModel<typeof retranslationLog>;
export type SelectRetranslationLogEntry = InferSelectModel<typeof retranslationLog>;
