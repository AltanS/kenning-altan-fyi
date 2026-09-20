/**
 * The fine-tuning corpus: what readers rejected, and what readers endorsed.
 *
 * NO ACCOUNT ID, NO SESSION, NO IP REACHES AN EXPORTED RECORD, AND NO QUERY IN
 * THIS MODULE MAY TOUCH `translation_rejections`.
 *   This file writes corpus data. `drizzle/schema/translation-feedback.ts`
 *   splits one press of the reject button into two rows on purpose: the FACT
 *   table knows who rejected, the SIGNAL table knows what was wrong, and
 *   nothing joins them. That split exists exactly so this module can be written
 *   without reading who anybody is. A join added here to get "how many DISTINCT
 *   readers rejected this" would collapse it: the export would then carry, in
 *   one artefact, which named accounts disliked which words, which is the
 *   search log this product says it does not keep. The count below is a count
 *   of SIGNAL rows, and `recordRejection` writes one signal per genuinely new
 *   fact row, so the number is the same number without the account column ever
 *   entering a statement.
 *
 *   The same rule covers the vote side. `translation_votes.accountId` is
 *   neither selected nor filtered on; the grouping removes it before anything
 *   leaves the statement, exactly as `listDownVotedTranslations` does.
 *
 * WHY THE TWO VERDICTS SIT IN ONE FILE. A fine-tuning corpus is a set of
 * judgements, and a file that carried only the complaints would train on
 * nothing but failure. `rejected` is one generated run readers marked as off,
 * with its stored answer verbatim; `endorsed` is one dictionary edge readers
 * agreed with. Both are needed, so both are records of one union and one call
 * returns them.
 *
 * THE ENDORSEMENT THRESHOLD IS IMPORTED, NEVER RE-STATED. `VOTE_MARGIN_THRESHOLD`
 * is declared in `app/lib/translation/rank.ts`, which is what decides the answer
 * a reader is shown first. A second literal here would let the export and the
 * on-screen ranking disagree about what "readers agree" means: a corpus could
 * then say a word is endorsed while the app still shows another word above it.
 *
 * THE DATABASE IS A PARAMETER, NEVER AN IMPORT, for the reason every model in
 * this repo gives: `drizzle/db.ts` opens a connection pool at module load.
 */

import { alias } from 'drizzle-orm/pg-core';
import { asc, desc, eq, sql } from 'drizzle-orm';

import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import type { JsonValue } from '#app/lib/json';
import { REJECTION_REASONS, type RejectionReason } from '#app/lib/translation/rejection';
import { VOTE_MARGIN_THRESHOLD } from '#app/lib/translation/rank';
import { writtenRowIdsSchema } from '#app/models/translation-runs.server';
import {
  headwords,
  senses,
  translationRejectionSignals,
  translationRuns,
  translationVotes,
  translations,
} from '#drizzle/schema';

/** Which half of the corpus to build. `all` is both, which is the ordinary case. */
export const EXPORT_VERDICTS = ['rejected', 'endorsed', 'all'] as const;

/** One of {@link EXPORT_VERDICTS}. */
export type ExportVerdict = (typeof EXPORT_VERDICTS)[number];

/**
 * How many complaints a run collected, per reason code.
 *
 * EVERY CODE IS PRESENT, INCLUDING THE ZEROS, so one JSONL line has the same
 * keys as the next and a consumer never has to tell "nobody said this" from
 * "this file is from before the code existed".
 */
export type RejectionReasonCounts = Record<RejectionReason, number>;

/** One generated run readers marked as off, with the answer it wrote. */
export interface RejectedTranslationRecord {
  verdict: 'rejected';
  runId: string;
  /** The word the run was about. */
  lemma: string;
  /** Its part of speech, when the source recorded one. */
  pos: string | null;
  from: string;
  to: string;
  provider: string;
  model: string;
  promptVersion: number;
  /** The run's stored answer, verbatim. This is the thing being judged. */
  output: JsonValue | null;
  /** How many complaints the run collected in total. */
  rejections: number;
  reasons: RejectionReasonCounts;
  /** ISO 8601, because a JSONL line is text and a `Date` is not. */
  createdAt: string;
}

/** The run that wrote one endorsed edge, when the edge was generated rather than imported. */
export interface EndorsedTranslationProvenance {
  model: string;
  promptVersion: number;
}

/** One dictionary edge readers agreed with, by at least `VOTE_MARGIN_THRESHOLD`. */
export interface EndorsedTranslationRecord {
  verdict: 'endorsed';
  translationId: string;
  /** The word that was looked up. */
  sourceLemma: string;
  /** The word it renders as. */
  targetLemma: string;
  from: string;
  to: string;
  up: number;
  down: number;
  /**
   * The run that wrote the edge, or `null` when no run claims it.
   *
   * `null` MEANS IMPORTED, NOT MISSING. An edge copied out of Wikidata, PanLex
   * or Tatoeba was never written by a model, so there is no model and no prompt
   * version to name. A consumer training on this file needs that difference:
   * an endorsed import says the corpus is right, an endorsed generation says a
   * particular prompt and model got it right.
   */
  run: EndorsedTranslationProvenance | null;
}

/** One line of the export. */
export type TranslationFeedbackRecord = RejectedTranslationRecord | EndorsedTranslationRecord;

/** What {@link buildTranslationFeedbackExport} is asked for. */
export interface TranslationFeedbackExportOptions {
  db: DictionaryDb;
  /** Defaults to `all`. */
  verdict?: ExportVerdict;
}

/**
 * A fresh tally with every reason at zero.
 *
 * THE COMPILER IS WHAT KEEPS THIS IN STEP WITH `REJECTION_REASONS`. The
 * `satisfies RejectionReasonCounts` clause makes a fifth code added to that
 * tuple stop this function compiling until the key is added. Building the object
 * from the tuple at runtime would have needed a type assertion and would have
 * failed silently instead.
 */
function zeroReasonCounts() {
  return { missing: 0, wrong: 0, register: 0, other: 0 } satisfies RejectionReasonCounts;
}

/**
 * The stored reason string, as the declared union.
 *
 * The check constraint on `translation_rejection_signals.reason` is built from
 * the same tuple, so an unknown code cannot be in the table. If one is, the
 * constraint was dropped and never rebuilt, and an export that quietly skipped
 * the row would hide that from whoever reads the corpus.
 */
function toRejectionReason(value: string): RejectionReason {
  const found = REJECTION_REASONS.find((reason) => reason === value);
  if (found === undefined) {
    throw new Error(`translation_rejection_signals holds an unknown reason code "${value}"`);
  }
  return found;
}

/**
 * Every run that collected at least one complaint, newest first.
 *
 * ONE STATEMENT, GROUPED BY RUN AND REASON, folded into records afterwards. The
 * alternative, one counted column per code, would have to name the four codes in
 * SQL and would drift from `REJECTION_REASONS` the day a fifth is added. Grouping
 * by the reason instead means the statement knows nothing about which codes
 * exist, and the tuple stays the only declaration.
 *
 * THE JOINS ARE THE SIGNAL TABLE, THE RUN AND THE DICTIONARY, AND NOTHING ELSE.
 * See this module's header: `translation_rejections` is out of reach on purpose.
 */
async function listRejected(db: DictionaryDb): Promise<RejectedTranslationRecord[]> {
  const rows = await db
    .select({
      runId: translationRuns.id,
      lemma: headwords.lemma,
      pos: headwords.pos,
      from: translationRuns.fromLanguageCode,
      to: translationRuns.toLanguageCode,
      provider: translationRuns.provider,
      model: translationRuns.model,
      promptVersion: translationRuns.promptVersion,
      output: translationRuns.output,
      createdAt: translationRuns.createdAt,
      reason: translationRejectionSignals.reason,
      signals: sql<number>`count(*)`.mapWith(Number),
    })
    .from(translationRejectionSignals)
    .innerJoin(translationRuns, eq(translationRuns.id, translationRejectionSignals.runId))
    .innerJoin(headwords, eq(headwords.id, translationRuns.headwordId))
    .groupBy(translationRuns.id, headwords.lemma, headwords.pos, translationRejectionSignals.reason)
    .orderBy(desc(translationRuns.createdAt), translationRuns.id, translationRejectionSignals.reason);

  const byRun = new Map<string, RejectedTranslationRecord>();
  for (const row of rows) {
    const existing = byRun.get(row.runId);
    const record =
      existing ??
      ({
        verdict: 'rejected',
        runId: row.runId,
        lemma: row.lemma,
        pos: row.pos,
        from: row.from,
        to: row.to,
        provider: row.provider,
        model: row.model,
        promptVersion: row.promptVersion,
        output: row.output,
        rejections: 0,
        reasons: zeroReasonCounts(),
        createdAt: row.createdAt.toISOString(),
      } satisfies RejectedTranslationRecord);

    record.reasons[toRejectionReason(row.reason)] = row.signals;
    record.rejections += row.signals;
    byRun.set(row.runId, record);
  }

  return [...byRun.values()];
}

/** The two counted expressions both vote reads below share. */
const UP_COUNT = sql<number>`count(*) filter (where ${translationVotes.value} = 1)`.mapWith(Number);
const DOWN_COUNT = sql<number>`count(*) filter (where ${translationVotes.value} = -1)`.mapWith(Number);

/** One endorsed edge before its writing run is looked up. */
interface EndorsedEdgeRow {
  translationId: string;
  sourceLemma: string;
  targetLemma: string;
  from: string;
  to: string;
  up: number;
  down: number;
}

/**
 * Every edge whose net score meets the margin, best first.
 *
 * THE MARGIN IS `VOTE_MARGIN_THRESHOLD`, IMPORTED. See this module's header: a
 * second literal would let this file and the on-screen ranking disagree.
 *
 * The grouping is what removes the account column from the answer. Every
 * selected expression is either grouped or aggregated, so no row that leaves
 * this statement can be traced back to one reader.
 */
async function listEndorsedEdges(db: DictionaryDb): Promise<EndorsedEdgeRow[]> {
  const fromSenses = alias(senses, 'from_senses');
  const fromHeadwords = alias(headwords, 'from_headwords');
  const toSenses = alias(senses, 'to_senses');
  const toHeadwords = alias(headwords, 'to_headwords');

  return db
    .select({
      translationId: translations.id,
      sourceLemma: fromHeadwords.lemma,
      targetLemma: toHeadwords.lemma,
      from: fromHeadwords.languageCode,
      to: toHeadwords.languageCode,
      up: UP_COUNT,
      down: DOWN_COUNT,
    })
    .from(translationVotes)
    .innerJoin(translations, eq(translations.id, translationVotes.translationId))
    .innerJoin(fromSenses, eq(fromSenses.id, translations.fromSenseId))
    .innerJoin(fromHeadwords, eq(fromHeadwords.id, fromSenses.headwordId))
    .innerJoin(toSenses, eq(toSenses.id, translations.toSenseId))
    .innerJoin(toHeadwords, eq(toHeadwords.id, toSenses.headwordId))
    .groupBy(
      translations.id,
      fromHeadwords.lemma,
      toHeadwords.lemma,
      fromHeadwords.languageCode,
      toHeadwords.languageCode,
    )
    .having(sql`${UP_COUNT} - ${DOWN_COUNT} >= ${VOTE_MARGIN_THRESHOLD}`)
    .orderBy(desc(sql`${UP_COUNT} - ${DOWN_COUNT}`), translations.id);
}

/**
 * Which run wrote each of these edges, where one did.
 *
 * THE JOIN IS THROUGH `translation_runs.written`, which lists the ids a run
 * INSERTED. That column is the only record of authorship a generated edge has:
 * the edge itself carries a source id shared by every generated row, so it can
 * say it was generated and cannot say by what. An edge no run claims was
 * imported, and the record says so with `null` rather than guessing.
 *
 * EARLIEST RUN WINS. `written` lists rows a run genuinely created, so at most
 * one run can claim an edge; ordering by `created_at` ascending makes the answer
 * deterministic anyway, rather than leaving it to the plan.
 *
 * @param db The database handle.
 * @param translationIds The endorsed edges to find writers for.
 * @returns A map from edge id to the run that wrote it. Absent means imported.
 */
async function readWritingRuns(
  db: DictionaryDb,
  translationIds: string[],
): Promise<Map<string, EndorsedTranslationProvenance>> {
  const writers = new Map<string, EndorsedTranslationProvenance>();
  if (translationIds.length === 0) return writers;

  const rows = await db
    .select({
      model: translationRuns.model,
      promptVersion: translationRuns.promptVersion,
      written: translationRuns.written,
    })
    .from(translationRuns)
    // The containment test is spelled out rather than written with a jsonb
    // operator, so the element list can be an ordinary `in` list. Drizzle
    // renders a JavaScript array in a `sql` template as a parenthesised
    // parameter list, `($1, $2)`, not as one array parameter: `= any(${ids})`
    // and `in (${ids})` both therefore produce a RECORD on the right and are
    // refused by Postgres. The braces go around nothing here on purpose.
    .where(
      sql`exists (
        select 1
        from jsonb_array_elements_text(coalesce(${translationRuns.written} -> 'translations', '[]'::jsonb)) as written_id
        where written_id in ${translationIds}
      )`,
    )
    .orderBy(asc(translationRuns.createdAt));

  for (const row of rows) {
    const parsed = writtenRowIdsSchema.safeParse(row.written);
    if (!parsed.success) continue;
    for (const id of parsed.data.translations) {
      if (writers.has(id)) continue;
      writers.set(id, { model: row.model, promptVersion: row.promptVersion });
    }
  }

  return writers;
}

/** The endorsed half of the corpus, with provenance attached. */
async function listEndorsed(db: DictionaryDb): Promise<EndorsedTranslationRecord[]> {
  const edges = await listEndorsedEdges(db);
  const writers = await readWritingRuns(
    db,
    edges.map((edge) => edge.translationId),
  );

  return edges.map((edge) => ({
    verdict: 'endorsed',
    translationId: edge.translationId,
    sourceLemma: edge.sourceLemma,
    targetLemma: edge.targetLemma,
    from: edge.from,
    to: edge.to,
    up: edge.up,
    down: edge.down,
    run: writers.get(edge.translationId) ?? null,
  }));
}

/**
 * The corpus, as records one `JSON.stringify` per line turns into JSONL.
 *
 * @param options The database handle, and which half to build.
 * @returns the rejected runs newest first, then the endorsed edges best first.
 *   The two halves are never interleaved: a consumer reading one verdict can
 *   stop at the first record of the other.
 */
export async function buildTranslationFeedbackExport(
  options: TranslationFeedbackExportOptions,
): Promise<TranslationFeedbackRecord[]> {
  const verdict = options.verdict ?? 'all';

  const [rejected, endorsed] = await Promise.all([
    verdict === 'endorsed' ? [] : listRejected(options.db),
    verdict === 'rejected' ? [] : listEndorsed(options.db),
  ]);

  return [...rejected, ...endorsed];
}
