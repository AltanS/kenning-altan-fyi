/**
 * What the explain pane says about a typed QUESTION, and whether asking a model
 * for an answer is the right move.
 *
 * THE SPLIT IS THE SAME ONE `phrase-panel.server.ts` MAKES, AND FOR THE SAME
 * REASON.
 *   `resolveExplainPanel` READS and never enqueues, so the polling route can
 *   call it every three seconds without queueing a fresh job on every poll.
 *   `resolveTriggeredExplainPanel` is the half that may start work, and the
 *   loader calls it once per question. Folding the two together is how a reader
 *   who waits a minute pays for twenty runs of one question.
 *
 * IT ANSWERS ITS OWN UNION, AND THAT IS THE ONE PLACE IT DIVERGES FROM THE
 * PHRASE PATH.
 *   The phrase resolver answers `TranslationPanel`, because a sentence and a
 *   word are rendered by one component and a reader must not be able to tell
 *   which branch answered them. An explanation is a different screen with a
 *   different card, so forcing its five-part document into a `TranslationRow`
 *   would mean packing a structured answer into a `lemma` string and unpacking
 *   it again in the card. The STATES are the same five, and `TranslationRefusal`
 *   is reused outright, so the pane's state machine and its refusal copy are
 *   shared rather than copied. Only the `ready` payload differs.
 *
 * THE CACHE IS READ FIRST AND WINS OUTRIGHT. A question with an answer is
 * `ready` even when a later attempt failed, because the reader is served the
 * answer and does not care that some retry went wrong afterwards.
 *
 * THE DATABASE IS A PARAMETER, NEVER AN IMPORT.
 */

import { isBudgetExhausted } from '#app/lib/abuse/budget.server';
import { checkTriggerRateLimit } from '#app/lib/abuse/rate-limit.server';
import { isServedLanguage, type LanguageCode } from '#app/lib/dictionary/detect-language';
import { normalizeQuery } from '#app/lib/dictionary/normalize';
import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import type { Explanation } from '#app/lib/llm/explain-schema';
import { enqueueExplain } from '#app/lib/translation/explain-enqueue.server';
import { EXPLAIN_MAX_QUESTION_CHARS, MAX_EXPLAIN_RUNS_PER_DAY } from '#app/lib/translation/limits';
import type { TranslationRefusal } from '#app/lib/translation/panel.server';
import {
  countExplainRunsToday,
  latestExplanation,
  latestExplanationAnswer,
} from '#app/models/explanations.server';
import { EXPLAIN_PROMPT_VERSION } from '#app/prompts/explain/version';

export type { TranslationRefusal } from '#app/lib/translation/panel.server';

/** An answer exists for this question. Nothing is queued and nothing is spent. */
export interface ExplainPanelReady {
  state: 'ready';
  answer: Explanation;
  /** The `explanations` row the reader is looking at. A report or a retraction would need it. */
  explanationId: string;
  /** Which model wrote it. The card discloses that a model did, and this says which. */
  model: string;
}

/** A run for this key is open. The pane polls until it is not. */
export interface ExplainPanelTranslating {
  state: 'translating';
  /**
   * The id of the `explanations` row THIS request caused to be queued.
   * `null` when this request only observed a run already open — a deduped
   * enqueue, or a row already `pending` from an earlier request, read here
   * without enqueueing anything.
   */
  queuedRunId: string | null;
}

/**
 * The latest run for this key ended badly.
 *
 * `canRetry` is a literal `true` rather than a boolean, for the reason
 * `TranslationPanelFailed` gives: there is no failed state this product offers
 * no retry for, and a boolean would invite a future caller to set it false and
 * leave a reader with a dead end.
 */
export interface ExplainPanelFailed {
  state: 'failed';
  canRetry: true;
  /** The developer-facing reason, for a log. It is never rendered: the pane shows one translated line. */
  error: string | null;
}

/** A guard refused. Nothing was queued, and nothing is coming today. */
export interface ExplainPanelBudget {
  state: 'budget';
  reason: TranslationRefusal;
}

/**
 * Nothing has happened for this question yet.
 *
 * IT IS AN INTERNAL ANSWER, NOT A PANE STATE, exactly as `TranslationPanelNone`
 * is. The resolver cannot decide what "no answer and no run" should look like,
 * because that depends on whether the caller is allowed to start work: the
 * loader turns it into `translating` or `budget`, and the read-only polling
 * route passes it through unchanged.
 */
export interface ExplainPanelNone {
  state: 'none';
}

/**
 * No question was asked at all.
 *
 * PRODUCED BY THE LOADER AND BY THE POLLING ROUTES, never by either resolver
 * here: both are given a question by construction. It is what the landing screen
 * renders, and what a poll whose query string cannot be read is answered with.
 */
export interface ExplainPanelNoEntry {
  state: 'no-entry';
}

/** Where one question stands. */
export type ExplainPanel =
  | ExplainPanelReady
  | ExplainPanelTranslating
  | ExplainPanelFailed
  | ExplainPanelBudget
  | ExplainPanelNone
  | ExplainPanelNoEntry;

/** Which question, in which direction. */
export interface ExplainPanelKey {
  /** The question as the reader typed it, trimmed. It is what a new run would answer. */
  question: string;
  /** The folded form, `normalizeQuery(question, from).normalized`, which is the cache key. */
  questionNormalized: string;
  /** The language the words in the question belong to. */
  from: LanguageCode;
  /** The language the explanation is written in. */
  to: LanguageCode;
}

/**
 * Read the cache and the ledger, and say where this question stands.
 *
 * IT NEVER ENQUEUES AND IT NEVER REFUSES. It holds no request, so it cannot ask
 * the rate limiter anything, and it starts nothing, so it has nothing to refuse.
 *
 * @param db The database handle.
 * @param key The question and the two languages.
 * @returns One of `ready`, `translating`, `failed`, `budget` or `none`.
 */
export async function resolveExplainPanel(db: DictionaryDb, key: ExplainPanelKey): Promise<ExplainPanel> {
  const answered = await latestExplanationAnswer(db, key);
  if (answered !== null && answered.answer !== null) {
    return { state: 'ready', answer: answered.answer, explanationId: answered.id, model: answered.model };
  }

  const row = await latestExplanation(db, key);
  if (row === null) return { state: 'none' };
  if (row.status === 'pending') return { state: 'translating', queuedRunId: null };
  if (row.status === 'failed') return { state: 'failed', canRetry: true, error: row.error };
  if (row.status === 'budget') return { state: 'budget', reason: 'budget' };
  // `ok` with no readable answer: the check above already returned for every
  // answer this version can show, so this is a row whose document is missing or
  // no longer decodes. It is treated as "nothing is coming", exactly like a
  // question nobody has ever asked, and the trigger half decides what to do
  // next.
  return { state: 'none' };
}

export interface ResolveTriggeredExplainPanelParams extends ExplainPanelKey {
  /** The screen's own request. The rate limiter reads its cookie and its address. */
  request: Request;
  /**
   * Whether the reader asked for this again after a failure.
   *
   * `false`, the page path: a failed question stays failed, so one provider
   * outage does not re-queue a job on every reload.
   * `true`, the retry button: the reader asked, so the failure is stepped over
   * and the guards decide.
   */
  retry?: boolean;
}

/**
 * Read, then start the work if starting it is the right move.
 *
 * THE FOUR GUARDS RUN IN THIS ORDER, AND THE ORDER IS THE POINT.
 *   The LENGTH CAP first, because it is free and certain: it needs no query, no
 *   clock and no shared counter, and a question over the cap can never be
 *   answered however much budget is left, so asking anything else about it would
 *   be work spent on a refusal that was already decided.
 *   The RATE LIMIT second. It is the per-caller guard, and it is what stands
 *   between one script and the whole day's allowance: a caller already over it
 *   must not be able to read the installation's counters by paying nothing for
 *   the answer.
 *   The PER-DAY EXPLAIN CAP third, and the BUDGET last, both installation-wide.
 *
 * AN ANSWERED OR RUNNING QUESTION IS NEVER COUNTED AND NEVER REFUSED. Neither
 * one would start work, so running them past the limiter would charge the honest
 * majority for requests that spend nothing.
 *
 * IT NEVER THROWS. A guard or a queue having an opinion must not turn a page
 * into a 500.
 *
 * @param db The database handle.
 * @param params The question, the two languages, the request, and whether this
 *   is a retry.
 * @returns The panel to render.
 */
export async function resolveTriggeredExplainPanel(
  db: DictionaryDb,
  params: ResolveTriggeredExplainPanelParams,
): Promise<ExplainPanel> {
  const { request, retry = false, question, questionNormalized, from, to } = params;
  const key: ExplainPanelKey = { question, questionNormalized, from, to };

  const resolved = await resolveExplainPanel(db, key);
  if (resolved.state === 'ready' || resolved.state === 'translating') return resolved;
  if (resolved.state === 'failed' && !retry) return resolved;

  const refusal = await refuseExplain(db, request, question);
  // A refusal WRITES NOTHING. No row is opened, so nothing newer than the
  // existing state exists, and a reader who comes back under a fresh allowance
  // reaches the same enqueue this one did not.
  if (refusal !== null) return { state: 'budget', reason: refusal };

  const outcome = await enqueueExplain(db, {
    from,
    to,
    question,
    questionNormalized,
    promptVersion: EXPLAIN_PROMPT_VERSION,
  });
  // A DEDUPED ENQUEUE IS STILL `translating`. The work is already queued or
  // running under this key, which is what the singleton key exists to arrange,
  // and the row the first caller opened is what the pane will poll. Only a
  // fresh `queued` outcome carries the id THIS request minted; a `deduped`
  // outcome observed someone else's run and reports no id of its own.
  if (outcome.outcome === 'unavailable') {
    return { state: 'failed', canRetry: true, error: 'the explain queue is not available' };
  }
  if (outcome.outcome === 'deduped') {
    return { state: 'translating', queuedRunId: null };
  }
  return { state: 'translating', queuedRunId: outcome.runId };
}

/**
 * Which guard turns this trigger away, or `null` when none does.
 *
 * The order is stated on `resolveTriggeredExplainPanel` and proved by
 * `tests/unit/explain-panel-gate.test.ts`, which reads the call log rather than
 * the returned reason: asserting only the reason would pass on an implementation
 * that asked every guard and picked a winner afterwards, which is a different
 * program.
 *
 * @param db The database handle, for the day's run count.
 * @param request The caller's own request.
 * @param question The question as typed, which is what the length cap measures.
 */
async function refuseExplain(db: DictionaryDb, request: Request, question: string): Promise<TranslationRefusal | null> {
  if (question.length > EXPLAIN_MAX_QUESTION_CHARS) return 'too-long';
  const verdict = await checkTriggerRateLimit(request);
  if (!verdict.allowed) return 'rate-limited';
  if ((await countExplainRunsToday(db)) >= MAX_EXPLAIN_RUNS_PER_DAY) return 'daily-cap';
  if (await isBudgetExhausted()) return 'budget';
  return null;
}

/**
 * The key one request is about, read out of its query string.
 *
 * IT IS HERE RATHER THAN IN EACH ROUTE so the page, the poll and the retry fold
 * the question the SAME way. Three copies of this would be three cache keys, and
 * the second one would miss every row the first one wrote while looking exactly
 * right.
 *
 * @param url The request's URL. `q` is the question, `from` and `to` the two
 *   languages.
 * @returns The key, or null when the question is empty or a language is not
 *   served. Null is not an error: an empty box is the landing screen and a stale
 *   poll is an ordinary thing, and both are answered with the same panel.
 */
export function explainKeyFromRequest(url: URL): ExplainPanelKey | null {
  const raw = url.searchParams.get('q')?.trim() ?? '';
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (raw === '' || !isServedLanguage(from) || !isServedLanguage(to)) return null;

  const normalized = normalizeQuery(raw, from).normalized;
  if (normalized === '') return null;
  return { question: raw, questionNormalized: normalized, from, to };
}
