/**
 * The quiz scaffold: reading the shared pool of starter cards for a language
 * pair, and the one guarded write that requests more of them.
 *
 * THE DATABASE IS A PARAMETER, NEVER AN IMPORT, for the same reason every
 * other `.server.ts` model in this app follows: `getRawDb()` opens a
 * connection pool at module load, and this module is reached from a route
 * loader and from a workflow handler holding its own transaction.
 *
 * `claimScaffoldRun` IS THE WHOLE DEDUPE MECHANISM, and it needs no pg-boss
 * singleton policy to work. `quiz_scaffold_runs` carries a composite primary
 * key on `(from, to)`, so an `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE
 * status IN ('failed', 'budget')` can only ever land once per pair while that
 * pair is `pending` or `ok`: the caller whose write actually landed is the
 * one that enqueues the job, every other concurrent or later caller sees no
 * row change and enqueues nothing. A pair stuck on a terminal `failed` or
 * `budget` row is the one case that same statement reopens, so a routine
 * budget refusal, or a missing provider key, does not strand a language
 * pair's scaffold pool forever. This is deliberately simpler than the
 * translation and explain queues' `stately` pg-boss policy
 * (`app/services/workflows.server.ts`), which exist because THOSE jobs run
 * per headword, many times a day, under real concurrent load. This one runs
 * at most once per language pair per genuine attempt (four served languages
 * is at most twelve pairs), so a unique, reclaimable row is the correct
 * amount of machinery, and adding a fourth `stately` queue to the shared
 * orchestrator for a job this rare would be ceremony with no reader behind
 * it.
 */
import { and, eq, sql } from 'drizzle-orm';

import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import { normalizeForLanguage } from '#app/lib/dictionary/normalize';
import { GENERATED_SOURCE_SLUG } from '#app/lib/dictionary/generated-source';
import type { QuizScaffoldCandidate } from '#app/lib/llm/quiz-scaffold-schema';
import { createComponentLogger } from '#app/lib/logger';
import { quizScaffoldCards, quizScaffoldRuns, sources, type SelectQuizScaffoldCard } from '#drizzle/schema';

const log = createComponentLogger('quiz');

/** One card as the quiz deck reads it. */
export interface QuizScaffoldCardView {
  id: string;
  lemma: string;
  translation: string;
  note: string | null;
}

function toView(row: SelectQuizScaffoldCard): QuizScaffoldCardView {
  return { id: row.id, lemma: row.lemma, translation: row.translation, note: row.note };
}

/**
 * The scaffold pool for one language pair, oldest first.
 *
 * ORDER IS ARBITRARY BUT STABLE. Every card in the pool is equally "the
 * scaffold": there is no ranking signal like `rank.ts` reads for a dictionary
 * answer, so `created_at` is read only to make two calls in the same request
 * agree with each other, not because older is better.
 */
export async function listScaffoldCards(
  db: DictionaryDb,
  params: { from: LanguageCode; to: LanguageCode; limit: number },
): Promise<QuizScaffoldCardView[]> {
  const rows = await db
    .select()
    .from(quizScaffoldCards)
    .where(and(eq(quizScaffoldCards.fromLanguageCode, params.from), eq(quizScaffoldCards.toLanguageCode, params.to)))
    .orderBy(quizScaffoldCards.createdAt)
    .limit(params.limit);
  return rows.map(toView);
}

/**
 * Open the one-and-only scaffold run row for a pair, if none exists yet, OR
 * reopen it if the row that exists is a dead end.
 *
 * A ROW IN `failed` OR `budget` IS RECLAIMED, NOT LEFT AS A PERMANENT LOCK.
 * Both statuses mean the pair still has no cards, so refusing to ever try
 * again would turn one budget-tight day, or one moment with no provider key
 * configured, into a pair nobody can ever quiz on. `pending` and `ok` are the
 * two statuses this function must never touch: `pending` means a job is
 * already queued or running, and `ok` means the pair is already served.
 *
 * @returns true when THIS call opened or reopened the row and therefore owns
 *   enqueuing the job; false when a row already existed in `pending` or `ok`
 *   and the caller must not enqueue a second time.
 */
export async function claimScaffoldRun(
  db: DictionaryDb,
  params: { from: LanguageCode; to: LanguageCode; requestedCount: number },
): Promise<boolean> {
  const claimed = await db
    .insert(quizScaffoldRuns)
    .values({
      fromLanguageCode: params.from,
      toLanguageCode: params.to,
      status: 'pending',
      requestedCount: params.requestedCount,
    })
    .onConflictDoUpdate({
      target: [quizScaffoldRuns.fromLanguageCode, quizScaffoldRuns.toLanguageCode],
      // Every field a finished run wrote is cleared along with `status`, so a
      // reclaimed row reads exactly like a first-ever attempt rather than
      // carrying a stale error or cost figure from the run that failed.
      set: {
        status: 'pending',
        requestedCount: params.requestedCount,
        written: null,
        error: null,
        costUsd: null,
        createdAt: new Date(),
        finishedAt: null,
      },
      setWhere: sql`${quizScaffoldRuns.status} IN ('failed', 'budget')`,
    })
    .returning({ from: quizScaffoldRuns.fromLanguageCode });
  return claimed.length > 0;
}

/** How a scaffold run ends. Mirrors `translation-runs.server.ts`'s `FinishRunParams`, much smaller. */
export interface FinishScaffoldRunParams {
  status: 'ok' | 'failed' | 'budget';
  written?: number;
  error?: string;
  costUsd?: number | null;
}

/** Write a scaffold run's terminal status. The one update this table allows. */
export async function finishScaffoldRun(
  db: DictionaryDb,
  key: { from: LanguageCode; to: LanguageCode },
  params: FinishScaffoldRunParams,
): Promise<void> {
  await db
    .update(quizScaffoldRuns)
    .set({
      status: params.status,
      ...(params.written !== undefined && { written: params.written }),
      error: params.error ?? null,
      ...(params.costUsd !== undefined && { costUsd: params.costUsd === null ? null : params.costUsd.toFixed(6) }),
      finishedAt: new Date(),
    })
    .where(and(eq(quizScaffoldRuns.fromLanguageCode, key.from), eq(quizScaffoldRuns.toLanguageCode, key.to)));
}

/**
 * The generated source row's id. Same row `translate-headword.ts` attributes
 * to, found the same way: by slug, never by licence. See
 * `app/lib/dictionary/generated-source.ts`.
 */
async function readGeneratedSourceId(db: DictionaryDb): Promise<string> {
  const rows = await db.select({ id: sources.id }).from(sources).where(eq(sources.slug, GENERATED_SOURCE_SLUG));
  const row = rows[0];
  if (row === undefined) {
    throw new Error(
      `The generated source row '${GENERATED_SOURCE_SLUG}' is missing from 'sources'. Run \`pnpm cli data-migration run\`.`,
    );
  }
  return row.id;
}

/**
 * Write one model answer's cards into the shared pool.
 *
 * UPSERTED ON `(from, to, lemma_normalized)`, so a re-run (there should never
 * be one, given `claimScaffoldRun`, but a hand-run CLI backfill could ask
 * twice) grows the pool instead of duplicating a word already in it.
 *
 * @returns how many rows this call actually inserted. A conflict is not
 *   counted: the run row's `written` column is meant to answer "how many new
 *   cards did this run add", not "how many did the model name".
 */
export async function writeScaffoldCards(
  db: DictionaryDb,
  params: { from: LanguageCode; to: LanguageCode; cards: QuizScaffoldCandidate[] },
): Promise<number> {
  if (params.cards.length === 0) return 0;
  const sourceId = await readGeneratedSourceId(db);

  let written = 0;
  await db.transaction(async (tx) => {
    for (const card of params.cards) {
      const [row] = await tx
        .insert(quizScaffoldCards)
        .values({
          fromLanguageCode: params.from,
          toLanguageCode: params.to,
          lemma: card.lemma,
          lemmaNormalized: normalizeForLanguage(card.lemma, params.from),
          translation: card.translation,
          pos: card.pos ?? null,
          note: card.note ?? null,
          sourceId,
        })
        // TARGET STATED EXPLICITLY, matching the unique index the schema
        // comment describes (`quiz_scaffold_cards_pair_lemma_idx`), rather
        // than relying on Drizzle's default whole-row conflict behaviour.
        .onConflictDoNothing({
          target: [quizScaffoldCards.fromLanguageCode, quizScaffoldCards.toLanguageCode, quizScaffoldCards.lemmaNormalized],
        })
        .returning({ id: quizScaffoldCards.id, inserted: sql<boolean>`(xmax = 0)` });
      if (row?.inserted === true) written += 1;
    }
  });

  log.info('Wrote scaffold cards', { from: params.from, to: params.to, offered: params.cards.length, written });
  return written;
}

/** What deleting one pair's scaffold pool actually removed. */
export interface DeleteScaffoldPoolResult {
  cardsDeleted: number;
  runDeleted: boolean;
}

/**
 * Delete one language pair's entire scaffold pool: every card, and the run
 * row that guards it.
 *
 * THE OPERATOR ESCAPE HATCH FOR A SHARED, MODEL-WRITTEN POOL. There is no
 * per-card edit and no moderation queue here, deliberately: a bad or wrong
 * scaffold word is rare enough that "delete the pair and let it regenerate"
 * is the whole feature this needs (M203/04). The run row is deleted along
 * with the cards, not left behind: an `ok` row would otherwise make
 * `claimScaffoldRun` treat the pair as already served and refuse to ever
 * queue a fresh backfill for it.
 *
 * BOTH DELETES SHARE ONE TRANSACTION, so an operator never sees a pair with
 * its cards gone but its run row still claiming the pair is served, or the
 * reverse. Not guarded against: deleting a pair while a backfill for that
 * SAME pair is mid-flight. `writeScaffoldCards` and `finishScaffoldRun` do not
 * check that the run row they started against still exists, so a delete that
 * lands between a job's start and its finish can leave fresh cards with no
 * run row above them. Rare enough (this job fires at most once per pair,
 * ever) not to guard against for a first cut of an admin-only command.
 */
export async function deleteScaffoldPool(
  db: DictionaryDb,
  params: { from: LanguageCode; to: LanguageCode },
): Promise<DeleteScaffoldPoolResult> {
  return db.transaction(async (tx) => {
    const deletedCards = await tx
      .delete(quizScaffoldCards)
      .where(and(eq(quizScaffoldCards.fromLanguageCode, params.from), eq(quizScaffoldCards.toLanguageCode, params.to)))
      .returning({ id: quizScaffoldCards.id });
    const deletedRuns = await tx
      .delete(quizScaffoldRuns)
      .where(and(eq(quizScaffoldRuns.fromLanguageCode, params.from), eq(quizScaffoldRuns.toLanguageCode, params.to)))
      .returning({ from: quizScaffoldRuns.fromLanguageCode });
    return { cardsDeleted: deletedCards.length, runDeleted: deletedRuns.length > 0 };
  });
}
