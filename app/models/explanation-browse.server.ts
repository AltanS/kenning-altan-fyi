/**
 * What the public browse pages are allowed to show, and the single statement
 * that decides it (M200).
 *
 * THE DATABASE IS A PARAMETER, NEVER AN IMPORT. The rule every model beside this
 * one follows: `drizzle/db.ts` opens a pool at module load, and only the TYPE is
 * imported here, so importing this file opens nothing.
 *
 * ONE VISIBILITY PREDICATE, READ BY BOTH PAGES. `listPublicExplanations` and
 * `getPublicExplanation` are the same statement with a different filter on top,
 * and the count the list pages on is a window count over that same statement. A
 * row cannot therefore be on the list and 404 on its own page, or the reverse,
 * which is what two hand-kept predicates would eventually produce.
 *
 * THE PREDICATE, IN THREE STEPS AND IN THIS ORDER.
 *   1. `DISTINCT ON (from, to, question_normalized)` over the `ok` rows, newest
 *      first, so each question is represented by its LATEST answered row. The
 *      language filters, and the question the single-row read already knows, live
 *      inside this step because they are key columns and cannot change which row
 *      the step picks. Everything else is applied to the row it picked, so an
 *      older listed row can never surface behind a newer unlisted one.
 *   2. An INNER JOIN onto `explanation_authorship`, keeping `listed = true`.
 *      ABSENCE OF AN AUTHORSHIP ROW MEANS NOT LISTED. That is what the inner
 *      join expresses and it is not an accident of shape: an authorship row
 *      disappears when its author deletes their account or withdraws the
 *      question, and reading absence as "listed" would publish a question
 *      somebody had just hidden. It also keeps every row written before M200,
 *      which has no authorship row and no way to ask anyone, off these pages.
 *   3. `NOT EXISTS` on `explanation_moderation` for the row's cache key. The
 *      operator hides a QUESTION, so the test is on the key and it survives a
 *      newer answered row opening under it.
 *
 * NO PARAMETER NAMES A READER, AND THERE IS NO SLOT FOR ONE. The product rule is
 * "no per-user public listing, ever" and this file is where it is mechanically
 * true: neither exported function accepts a reader, the profile table is joined
 * for a name in the SELECT list and nowhere else, and the account column on the
 * vote rows is neither selected nor filtered on.
 * `tests/unit/explanation-listing-no-user-filter.test.ts` is the guard that
 * fails the build if any of that changes.
 *
 * THE BYLINE JOIN IS A LEFT JOIN, AND THAT IS LOAD BEARING. A reader who has
 * never opened `/settings` has no `user_profiles` row at all, and an inner join
 * would drop every explanation they ever asked for off the public pages.
 */

import { and, desc, eq, notExists, sql, type SQL } from 'drizzle-orm';

import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import type { Explanation } from '#app/lib/llm/explain-schema';
import { VOTE_MARGIN_THRESHOLD } from '#app/lib/translation/rank';
import { toAnswer } from '#app/models/explanations.server';
import {
  explanationAuthorship,
  explanationModeration,
  explanationVotes,
  explanations,
  userProfiles,
} from '#drizzle/schema';

/** The most rows one press of "show more" adds. The private ask list uses the same figure. */
export const PUBLIC_EXPLANATIONS_PAGE_SIZE = 20;

/** The ceiling one read may return, whatever the URL asks for. Ten presses of a button nobody presses ten times. */
export const PUBLIC_EXPLANATIONS_MAX_ROWS = 200;

/** How much of an answer a list row carries. The private list cuts at the same place. */
export const PUBLIC_PREVIEW_CHARS = 140;

/** What marks a preview as cut. It is one character, so it costs one character of the budget. */
const PREVIEW_ELLIPSIS = '…';

/** A cut that lands after these reads as a dangling clause, so the cut backs off them. */
const PREVIEW_TRAILING_BREAK = /[\s,;:]+$/;

/** The first half of a surrogate pair. A hard cut that ends on one would leave half a character. */
const PREVIEW_HIGH_SURROGATE = /[\uD800-\uDBFF]$/;

/**
 * The opening of an answer for a list row, never longer than `maxChars` in total.
 *
 * A TEXT THAT FITS COMES BACK UNCHANGED, with no ellipsis. A longer one is cut at
 * the last whitespace that leaves room for the ellipsis, so a row ends on a word
 * and not in the middle of one, then loses trailing whitespace and `,;:` and gains
 * a single ellipsis. A text with no usable whitespace in that window (a run of CJK
 * is the ordinary case) is cut hard instead, and a hard cut never keeps half of a
 * surrogate pair.
 */
export function truncatePreview(text: string, maxChars: number = PUBLIC_PREVIEW_CHARS): string {
  if (text.length <= maxChars) return text;

  const budget = maxChars - PREVIEW_ELLIPSIS.length;
  // One character past the budget, so a space that sits exactly on the cut counts as a boundary.
  const candidate = text.slice(0, budget + 1);
  const lastGap = candidate.search(/\s\S*$/);
  const atWord = lastGap === -1 ? '' : candidate.slice(0, lastGap).replace(PREVIEW_TRAILING_BREAK, '');
  if (atWord.length > 0) return `${atWord}${PREVIEW_ELLIPSIS}`;

  const hardCut = text.slice(0, budget).replace(PREVIEW_HIGH_SURROGATE, '').replace(PREVIEW_TRAILING_BREAK, '');
  return `${hardCut}${PREVIEW_ELLIPSIS}`;
}

/** One public explanation, as a list row draws it. */
export interface PublicExplanationRow {
  id: string;
  /** The language the words in the question belong to. */
  from: string;
  /** The language the answer is written in. */
  to: string;
  question: string;
  /** The opening of the answer, at most `PUBLIC_PREVIEW_CHARS` long. A longer answer is cut at a word and ends with an ellipsis. */
  preview: string;
  up: number;
  down: number;
  /** The name to write beside it, or null when there is none to write. */
  bylineName: string | null;
}

/** One public explanation, as its own page draws it. */
export interface PublicExplanation {
  id: string;
  from: string;
  to: string;
  question: string;
  /** The decoded document. A row whose stored answer no longer decodes is not served at all. */
  answer: Explanation;
  up: number;
  down: number;
}

/** One window of the public list, and how many rows the whole filter holds. */
export interface PublicExplanationPage {
  rows: PublicExplanationRow[];
  /**
   * Every visible row under the same filter, counted in the same statement.
   *
   * The window this call returned is `min(limit, total)` rows before any
   * undecodable ones are dropped, which is what a caller pages on: dropping a
   * row must not end the list early.
   */
  total: number;
}

/**
 * Which slice of the public list to read.
 *
 * The two language fields are the filter the page offers. `null` means "any",
 * which is also what an unreadable value in the query string reads as: the
 * filter arrives from a URL a person can type.
 */
export interface ListPublicExplanationsParams {
  from: LanguageCode | null;
  to: LanguageCode | null;
  /** Clamped to `PUBLIC_EXPLANATIONS_MAX_ROWS`, so a hand-edited query string cannot ask for everything. */
  limit: number;
  /** Where the window starts. The browse page grows its window from zero, so it passes 0. */
  offset: number;
}

/** Which row to read, by its own ledger id. */
export interface GetPublicExplanationParams {
  id: string;
}

/** The three columns a cache key is made of, in the order the DISTINCT ON walks them. */
const KEY_COLUMNS = [explanations.fromLanguageCode, explanations.toLanguageCode, explanations.questionNormalized];

/**
 * Which questions step 1 may consider, `null` meaning "every one of them".
 *
 * EVERY FIELD IS A KEY COLUMN, and that is what makes narrowing safe: the
 * DISTINCT ON groups by exactly these three, so a filter on any of them cannot
 * change which row the step picks for a group it keeps.
 */
interface KeyFilter {
  from: string | null;
  to: string | null;
  questionNormalized: string | null;
}

/**
 * The cache key one ledger row carries, read by primary key.
 *
 * WHY THE SINGLE-ROW READ STARTS HERE. Step 1 groups the whole answered ledger
 * and Postgres cannot push `id = $1` into a DISTINCT ON, so a detail page that
 * filtered afterwards scanned every answered row to serve one. The key read here
 * narrows step 1 to a single group instead, and the `latest.id = id` test after
 * it is unchanged, so a superseded row still refuses.
 */
async function readExplanationKey(db: DictionaryDb, id: string): Promise<KeyFilter | null> {
  const [row] = await db
    .select({
      from: explanations.fromLanguageCode,
      to: explanations.toLanguageCode,
      questionNormalized: explanations.questionNormalized,
    })
    .from(explanations)
    .where(eq(explanations.id, id))
    .limit(1);

  return row ?? null;
}

/**
 * Step 1: the latest answered row per question, already narrowed to the keys the
 * caller asked for.
 */
function latestAnsweredPerKey(db: DictionaryDb, key: KeyFilter) {
  return db.$with('latest_answered').as(
    db
      .selectDistinctOn(KEY_COLUMNS, {
        id: explanations.id,
        fromLanguageCode: explanations.fromLanguageCode,
        toLanguageCode: explanations.toLanguageCode,
        question: explanations.question,
        questionNormalized: explanations.questionNormalized,
        answer: explanations.answer,
        createdAt: explanations.createdAt,
      })
      .from(explanations)
      .where(
        and(
          eq(explanations.status, 'ok'),
          key.from === null ? undefined : eq(explanations.fromLanguageCode, key.from),
          key.to === null ? undefined : eq(explanations.toLanguageCode, key.to),
          key.questionNormalized === null
            ? undefined
            : eq(explanations.questionNormalized, key.questionNormalized),
        ),
      )
      .orderBy(...KEY_COLUMNS, desc(explanations.createdAt)),
  );
}

/** The common table expression step 1 produces, as the steps after it see it. */
type LatestAnswered = ReturnType<typeof latestAnsweredPerKey>;

/** Step 3: no operator has hidden the question this row answers. */
function noModerationForKey(db: DictionaryDb, latest: LatestAnswered): SQL {
  return notExists(
    db
      .select({ key: explanationModeration.questionNormalized })
      .from(explanationModeration)
      .where(
        and(
          eq(explanationModeration.fromLanguageCode, latest.fromLanguageCode),
          eq(explanationModeration.toLanguageCode, latest.toLanguageCode),
          eq(explanationModeration.questionNormalized, latest.questionNormalized),
        ),
      ),
  );
}

/**
 * Steps 2 and 3 over step 1, selected the one way both pages read it.
 *
 * @param db The database handle.
 * @param latest The step-1 expression.
 * @param extra One more condition, for the caller that wants a single row.
 */
function visibleExplanations(db: DictionaryDb, latest: LatestAnswered, extra?: SQL) {
  const tally = db
    .select({
      explanationId: explanationVotes.explanationId,
      up: sql<number>`count(*) filter (where ${explanationVotes.value} = 1)`.as('up'),
      down: sql<number>`count(*) filter (where ${explanationVotes.value} = -1)`.as('down'),
    })
    .from(explanationVotes)
    .groupBy(explanationVotes.explanationId)
    .as('explanation_tally');

  const net = sql`coalesce(${tally.up}, 0) - coalesce(${tally.down}, 0)`;

  return {
    // The margin-of-two rule, the same one the translation ranking applies, so
    // one drive-by vote cannot reorder a list everybody reads. Below the margin
    // the score is nothing and the row falls through to recency.
    decisiveScore: sql`case when abs(${net}) >= ${VOTE_MARGIN_THRESHOLD} then ${net} else 0 end`,
    query: db
      .with(latest)
      .select({
        id: latest.id,
        from: latest.fromLanguageCode,
        to: latest.toLanguageCode,
        question: latest.question,
        answer: latest.answer,
        up: sql<number>`coalesce(${tally.up}, 0)`.mapWith(Number),
        down: sql<number>`coalesce(${tally.down}, 0)`.mapWith(Number),
        bylineName: sql<
          string | null
        >`case when ${explanationAuthorship.showName} and ${userProfiles.publicName} is not null then ${userProfiles.publicName} end`,
        // Counted over the filtered set and before the window, so one statement
        // answers both "which rows" and "how many in total".
        total: sql<number>`count(*) over ()`.mapWith(Number),
      })
      .from(latest)
      .innerJoin(explanationAuthorship, eq(explanationAuthorship.explanationId, latest.id))
      .leftJoin(userProfiles, eq(userProfiles.userId, explanationAuthorship.userId))
      .leftJoin(tally, eq(tally.explanationId, latest.id))
      .where(and(eq(explanationAuthorship.listed, true), noModerationForKey(db, latest), extra)),
  };
}

/**
 * One window of the public list.
 *
 * @param db The database handle.
 * @param params The language filter and the window.
 * @returns the rows that decoded, and how many the filter holds in total.
 */
export async function listPublicExplanations(
  db: DictionaryDb,
  { from, to, limit, offset }: ListPublicExplanationsParams,
): Promise<PublicExplanationPage> {
  const latest = latestAnsweredPerKey(db, { from, to, questionNormalized: null });
  const visible = visibleExplanations(db, latest);

  const selected = await visible.query
    .orderBy(desc(visible.decisiveScore), desc(latest.createdAt))
    .limit(Math.min(Math.max(limit, 1), PUBLIC_EXPLANATIONS_MAX_ROWS))
    .offset(Math.max(offset, 0));

  const rows = selected.flatMap((row) => {
    // A row whose stored document no longer decodes is not an answer, by the
    // same rule the private pages apply. It is dropped rather than drawn empty.
    const answer = toAnswer(row.answer, row.id);
    if (answer === null) return [];
    return [
      {
        id: row.id,
        from: row.from,
        to: row.to,
        question: row.question,
        preview: truncatePreview(answer.answer),
        up: row.up,
        down: row.down,
        bylineName: row.bylineName,
      },
    ];
  });

  return { rows, total: selected[0]?.total ?? 0 };
}

/**
 * One public explanation, or null when this installation will not serve it.
 *
 * NULL COVERS SIX DIFFERENT REFUSALS, and the page answers all six identically.
 * An id nothing carries, a row that never answered, a row whose question an
 * operator hid, a row its author un-listed, a row with no authorship claim at
 * all, and a row that is no longer the latest answered one for its question.
 * Telling them apart would be a way to learn that a question exists and has been
 * taken down, which is the fact the take-down was about.
 *
 * @param db The database handle.
 * @param params The ledger row id, straight off the path.
 */
export async function getPublicExplanation(
  db: DictionaryDb,
  { id }: GetPublicExplanationParams,
): Promise<PublicExplanation | null> {
  const key = await readExplanationKey(db, id);
  if (key === null) return null;

  const latest = latestAnsweredPerKey(db, key);
  const visible = visibleExplanations(db, latest, eq(latest.id, id));

  const [row] = await visible.query.limit(1);
  if (row === undefined) return null;

  const answer = toAnswer(row.answer, row.id);
  if (answer === null) return null;

  return { id: row.id, from: row.from, to: row.to, question: row.question, answer, up: row.up, down: row.down };
}
