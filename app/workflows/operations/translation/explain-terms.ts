/**
 * The explain job: have the active model answer one question about words, as a
 * structured document, and write it onto the row that asked for it.
 *
 * IT WRITES TO ITS OWN TABLE AND TO NOTHING ELSE, EVER.
 *   An explanation is prose about several words at once, keyed by the question
 *   rather than by any one word, so nothing it produces belongs in the
 *   dictionary: those tables are keyed on a dictionary form and a part of
 *   speech. This file therefore imports no dictionary table at all. The answer
 *   lands on `explanations`, which is both the record of the run and the cache a
 *   later reader is served from.
 *
 * THE BODY IS A PLAIN FUNCTION, AND THE HANDLER IS FIVE LINES OVER IT.
 *   `runExplainTerms` takes a payload and returns a summary. It knows nothing
 *   about pg-boss, so a test drives the real thing with a faked provider port
 *   and no queue at all.
 *
 * EVERY EXIT PATH WRITES A TERMINAL STATUS.
 *   The pane resolves what a reader sees from the LATEST row for the key, and
 *   that row is opened `pending` by the request that queued the job. A run that
 *   ends without writing a terminal status is therefore not "an explanation we
 *   did not get", it is a reader watching a spinner that will never stop, on
 *   every load, forever: nothing else in the system knows the job is gone. That
 *   is why the whole body sits inside one try/catch and the catch writes
 *   `failed`.
 *
 * NO LOG LINE HERE NAMES A READER, because there is nothing to name: the payload
 * carries a folded question, two languages and a row id, and the row carries no
 * identity either.
 */

import type { OperationHandler } from '@sprqvntrs/workflows';

import { reserve, settle } from '#app/lib/abuse/budget.server';
import { recordRejection } from '#app/lib/abuse/rate-limit.server';
import { estimateCostUsd, modelPrice } from '#app/lib/llm/catalog';
import { explanationSchema, type Explanation } from '#app/lib/llm/explain-schema';
import { registry, type ActiveModel } from '#app/lib/llm/registry.server';
import { createComponentLogger } from '#app/lib/logger';
import type { ExplainJobPayload } from '#app/lib/translation/explain-job-payload';
import { TRANSLATION_TIMEOUT_MS } from '#app/lib/translation/limits';
import { getActiveModel } from '#app/models/app-settings.server';
import { getExplanation, settleExplanation } from '#app/models/explanations.server';
import { renderExplainPrompt } from '#app/prompts/explain';
import { getRawDb } from '#drizzle/db';
import { explainTermsContextSchema } from '#app/workflows/types';

const log = createComponentLogger('ExplainTerms');

// -----------------------------------------------------------------------------
// The spend estimate
// -----------------------------------------------------------------------------
// The reservation has to be taken BEFORE the call, so it is taken against a
// figure nobody has measured yet. These constants are that figure, and each is
// deliberately generous rather than accurate: an over-estimate reserves too much
// and is handed straight back by `settle`, while an under-estimate lets a run
// past a cap it should have hit.
// -----------------------------------------------------------------------------

/** Roughly four characters per token, for the Latin-script languages this app serves. */
const CHARS_PER_TOKEN = 4;

/**
 * How many output tokens one answer is expected to cost.
 *
 * HIGHER THAN THE PHRASE JOB'S FIGURE, BY DESIGN. A phrase answer is one
 * sentence; this one is an answer, up to three terms with a meaning and two
 * examples each, a four row contrast table, three pitfalls and four related
 * words. The schema's own ceilings add up to a little over two thousand
 * characters, and this prices the whole ceiling rather than the typical answer:
 * a model that fills every field must be paid for out of a reservation that
 * already covered it, not discovered afterwards.
 */
const EXPECTED_OUTPUT_TOKENS = 1200;

/**
 * What to reserve for a model with no row in the price table.
 *
 * NEVER ZERO, AND THIS IS THE WHOLE REASON THE CONSTANT EXISTS. A zero estimate
 * adds nothing to the day's total, so a model the price table forgot would be
 * free forever: the cap would never be reached, no alert would ever fire, and
 * the guard would stop enforcing without once failing.
 */
const UNPRICED_MODEL_RESERVE_USD = 0.05;

/** What one call is expected to cost, in USD. See the constants above for why each figure is high. */
function estimateRunCostUsd(model: string, prompt: string): number {
  const price = modelPrice(model);
  if (price === null) return UNPRICED_MODEL_RESERVE_USD;
  return estimateCostUsd(price, Math.ceil(prompt.length / CHARS_PER_TOKEN), EXPECTED_OUTPUT_TOKENS);
}

/** What one run of the job did. */
export interface ExplainRunSummary {
  outcome: 'written' | 'skipped-not-configured' | 'skipped-no-row' | 'budget' | 'failed';
  /** The row this job reported into, when there was one to report into. */
  runId: string | null;
  providerCalls: number;
  /** Why the run ended the way it did, when that is not obvious from the outcome. */
  reason: string | null;
}

/** A summary for a run that produced nothing and called nothing. */
function emptySummary(
  outcome: ExplainRunSummary['outcome'],
  runId: string | null,
  reason: string | null,
): ExplainRunSummary {
  return { outcome, runId, providerCalls: 0, reason };
}

/**
 * The job body, callable without pg-boss so a test can drive it directly.
 *
 * @param payload The two languages, the folded question, the prompt version and
 *   the row to report into.
 * @returns what happened. It reports rather than throws: a run that could not be
 *   done is a summary with a reason, and a terminal row is written on every path
 *   out of here.
 */
export async function runExplainTerms(payload: ExplainJobPayload): Promise<ExplainRunSummary> {
  const db = getRawDb();

  const row = await getExplanation(db, payload.runId);
  if (row === null) {
    // Nothing to report into, so there is nothing a reader is waiting on either:
    // the pane reads this table, and this key has no row. The job completes
    // rather than failing, because a retry would find the row just as absent.
    log.warn('An explain job has no row to report into', { runId: payload.runId });
    return emptySummary('skipped-no-row', null, `No explanation row ${payload.runId}`);
  }

  // EVERYTHING BELOW IS INSIDE THE TRY. A throw anywhere, including a zod
  // failure inside the provider call, has to end as a `failed` row. The
  // alternative is a reader watching a spinner forever; see the file comment.
  try {
    return await attemptExplain(payload, row.question);
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    log.error('An explain run failed', { runId: payload.runId, reason: error });
    await settleExplanation(db, payload.runId, { status: 'failed', error });
    return emptySummary('failed', payload.runId, error);
  }
}

/**
 * The run proper. Every throw out of here is caught by `runExplainTerms`.
 *
 * @param payload The job's own payload.
 * @param question The question AS THE READER TYPED IT, read from the row. The
 *   folded form in the payload is the cache key and must never be the thing that
 *   is asked: it is lower case and stripped of the punctuation at its ends, so
 *   the question mark the reader typed would be gone.
 */
async function attemptExplain(payload: ExplainJobPayload, question: string): Promise<ExplainRunSummary> {
  const db = getRawDb();

  // READ PER JOB, NEVER AT MODULE LOAD. Switching the model is an operator
  // action taken while the worker is running, and that is the whole point of
  // keeping the selection in a settings row.
  const active = await getActiveModel();

  const configuration = registry.describeConfiguration(active);
  if (!configuration.configured) {
    // An app deployed with no provider key is a normal state, not a fault. It is
    // still a terminal row: a reader must not be left waiting for a call that
    // this installation cannot make.
    await settleExplanation(db, payload.runId, { status: 'failed', error: configuration.reason });
    log.info('An explain run was skipped: no provider key', { reason: configuration.reason });
    return emptySummary('skipped-not-configured', payload.runId, configuration.reason);
  }

  const prompt = renderExplainPrompt({ question, from: payload.from, to: payload.to });
  const estimateUsd = estimateRunCostUsd(active.model, prompt);

  // RESERVE BEFORE THE CALL, ALWAYS. The reverse order, call first and count
  // after, has a window in which every parallel run reads the same low total and
  // every one of them charges. See `app/lib/abuse/budget.server.ts`.
  const reservation = await reserve(estimateUsd);
  if (!reservation.ok) {
    const error = 'The daily budget for this installation is used up. Please try again tomorrow.';
    await settleExplanation(db, payload.runId, { status: 'budget', error });
    await recordRejection('budget');
    log.info('An explain run was refused by the daily budget', { estimateUsd });
    return emptySummary('budget', payload.runId, error);
  }

  const startedAt = Date.now();
  const answered = await callModel(active, prompt);
  const latencyMs = Date.now() - startedAt;

  // THE CALL RAN, SO THE RESERVATION BECOMES A SPEND. It is settled here, above
  // everything that can still throw, because a throw from here on is caught by
  // `runExplainTerms` and must not leave the day's reservation stuck.
  //
  // IT IS NEVER RELEASED, AND THAT IS DELIBERATE, for the reason the other two
  // jobs give: the schema is handed to `registry.complete`, so a model that
  // answered badly and a model that never answered both surface as one rejected
  // promise, and the first of the two burned the money. A null actual settles at
  // the estimate, never at zero, or exactly the models we cannot price would get
  // unlimited free retries.
  await settle({ estimateUsd, actualUsd: answered.costUsd ?? estimateUsd });

  await settleExplanation(db, payload.runId, {
    status: 'ok',
    answer: answered.explanation,
    costUsd: answered.costUsd,
    latencyMs,
  });

  return { outcome: 'written', runId: payload.runId, providerCalls: 1, reason: null };
}

/** What the model answered, plus what the call cost. */
interface ExplainModelAnswer {
  explanation: Explanation;
  costUsd: number | null;
}

/**
 * Ask the model, once.
 *
 * ONE ATTEMPT, AND NO RETRY LOOP. A reader is waiting, and a second ninety
 * second call would be spent on somebody who has already left. A failure ends
 * the run `failed`, and the pane offers a retry button, which is a new row and a
 * new decision.
 *
 * THE PARSE HAPPENS INSIDE `registry.complete`, which is handed the schema. A
 * malformed answer therefore rejects the promise, and the rejection is caught by
 * `runExplainTerms` and written as a `failed` row. That includes the contrast
 * table's alignment rule, which is a refinement on the schema rather than a
 * check anywhere here.
 *
 * NO `reasoningEffort` IS PASSED. The active model's own configured setting (an
 * operator setting, see registry.server.ts) applies instead: some endpoints,
 * such as google/gemini-3.8-flash, reject a request that disables reasoning
 * outright with a 400.
 */
async function callModel(active: ActiveModel, prompt: string): Promise<ExplainModelAnswer> {
  const answer = await registry.complete(active, {
    prompt,
    schema: explanationSchema,
    timeoutMs: TRANSLATION_TIMEOUT_MS,
  });
  return { explanation: answer.output, costUsd: answer.costUsd };
}

/**
 * The pg-boss facing wrapper: decode the context, run the body, report it.
 *
 * A `failed` summary fails the operation, so the workflow record says so and the
 * run is visible on the admin surface. Every other outcome is a completion,
 * including `budget`: a run refused by the cap did exactly what it was asked to
 * do, and failing it would put the job back on the queue to be refused again,
 * which is a retry loop built out of the guard that exists to stop one.
 */
export const explainTermsHandler: OperationHandler = async (ctx) => {
  const payload = explainTermsContextSchema.parse(ctx.initialContext);
  const summary = await runExplainTerms(payload);
  if (summary.outcome === 'failed') {
    return { status: 'failed', reason: summary.reason ?? 'The explanation failed' };
  }
  return {
    status: 'completed',
    data: {
      outcome: summary.outcome,
      runId: summary.runId,
      providerCalls: summary.providerCalls,
      reason: summary.reason,
    },
  };
};
