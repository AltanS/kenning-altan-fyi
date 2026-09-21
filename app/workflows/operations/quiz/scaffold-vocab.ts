/**
 * The quiz scaffold job: ask the active model for a batch of starter
 * vocabulary for a language pair, and write what comes back into the shared
 * scaffold pool.
 *
 * ONE CALL, ONE WRITE, NO POLLING READER. Unlike `translate-headword.ts` this
 * job has no `runId` to report a pane's spinner against: `claimScaffoldRun`
 * (`app/models/quiz.server.ts`) already opened the one row this pair will
 * ever have before the job was queued, and nothing on screen reads that row's
 * status. A reader whose deck triggered this job sees today's deck built from
 * whatever the organic sources and the pool already hold; the NEXT reader of
 * this pair, whenever they arrive, finds the pool topped up.
 *
 * THE BUDGET GUARD IS THE SAME ONE EVERY OTHER LLM CALL IN THIS APP SHARES
 * (`app/lib/abuse/budget.server.ts`). Skipping it here because this job is
 * rare would let a rare job be the one path that silently bypasses the
 * installation's one daily spend cap.
 */
import { and, eq } from 'drizzle-orm';
import type { OperationHandler } from '@sprqvntrs/workflows';

import { reserve, settle } from '#app/lib/abuse/budget.server';
import { estimateCostUsd, modelPrice } from '#app/lib/llm/catalog';
import { registry, type ActiveModel } from '#app/lib/llm/registry.server';
import { quizScaffoldAnswerSchema, type QuizScaffoldCandidate } from '#app/lib/llm/quiz-scaffold-schema';
import { createComponentLogger } from '#app/lib/logger';
import { getActiveModel } from '#app/models/app-settings.server';
import { finishScaffoldRun, writeScaffoldCards } from '#app/models/quiz.server';
import { renderQuizScaffoldPrompt } from '#app/prompts/quiz-scaffold';
import { getRawDb } from '#drizzle/db';
import { quizScaffoldRuns } from '#drizzle/schema';
import { scaffoldVocabContextSchema } from '#app/workflows/types';

const log = createComponentLogger('ScaffoldVocab');

/** Roughly four characters per token, the same rough figure the translation job estimates with. */
const CHARS_PER_TOKEN = 4;

/** How many output tokens one card is expected to cost: a word, a translation, a pos label, and sometimes a short note. */
const EXPECTED_OUTPUT_TOKENS_PER_CARD = 40;

/** What to reserve for a model with no row in the price table. Never zero, see `translate-headword.ts`'s identical constant for why. */
const UNPRICED_MODEL_RESERVE_USD = 0.05;

function estimateRunCostUsd(model: string, prompt: string, count: number): number {
  const price = modelPrice(model);
  if (price === null) return UNPRICED_MODEL_RESERVE_USD;
  const promptTokens = Math.ceil(prompt.length / CHARS_PER_TOKEN);
  const completionTokens = count * EXPECTED_OUTPUT_TOKENS_PER_CARD;
  return estimateCostUsd(price, promptTokens, completionTokens);
}

/** What one run of the job did. */
export interface ScaffoldVocabRunSummary {
  outcome: 'written' | 'skipped-not-configured' | 'budget' | 'failed';
  written: number;
  reason: string | null;
}

async function callModel(
  active: ActiveModel,
  prompt: string,
): Promise<{ cards: QuizScaffoldCandidate[]; costUsd: number | null }> {
  const answer = await registry.complete(active, {
    prompt,
    schema: quizScaffoldAnswerSchema,
    // No reasoningEffort. The active model's own configured setting applies,
    // for the same reason `translate-headword.ts` leaves it unset: some
    // endpoints refuse a request that disables reasoning outright.
    timeoutMs: 90_000,
  });
  return { cards: answer.output.cards, costUsd: answer.costUsd };
}

/** The job body, callable without pg-boss so a test can drive it directly. */
export async function runScaffoldVocab(payload: {
  from: 'en' | 'de' | 'tr' | 'es';
  to: 'en' | 'de' | 'tr' | 'es';
  count: number;
}): Promise<ScaffoldVocabRunSummary> {
  const db = getRawDb();
  const key = { from: payload.from, to: payload.to };

  // A run row that no longer exists (or was never opened) means there is
  // nothing to report into. This should not happen: `claimScaffoldRun` opens
  // the row before the job is ever sent. It is guarded anyway, the same way
  // `runTranslateHeadword` guards a missing `runId`, because a job body must
  // never assume the row that justified queuing it is still there.
  const existing = await db
    .select({ status: quizScaffoldRuns.status })
    .from(quizScaffoldRuns)
    .where(and(eq(quizScaffoldRuns.fromLanguageCode, payload.from), eq(quizScaffoldRuns.toLanguageCode, payload.to)));
  const own = existing[0];
  if (own === undefined || own.status !== 'pending') {
    log.warn('Scaffold job has no pending run row', { from: payload.from, to: payload.to });
    return { outcome: 'failed', written: 0, reason: `No pending quiz_scaffold_runs row for ${payload.from}->${payload.to}` };
  }

  try {
    return await attemptScaffold(db, key, payload.count);
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    log.error('Scaffold run failed', { from: payload.from, to: payload.to, reason: error });
    await finishScaffoldRun(db, key, { status: 'failed', error });
    return { outcome: 'failed', written: 0, reason: error };
  }
}

async function attemptScaffold(
  db: ReturnType<typeof getRawDb>,
  key: { from: 'en' | 'de' | 'tr' | 'es'; to: 'en' | 'de' | 'tr' | 'es' },
  count: number,
): Promise<ScaffoldVocabRunSummary> {
  const active = await getActiveModel();
  const configuration = registry.describeConfiguration(active);
  if (!configuration.configured) {
    await finishScaffoldRun(db, key, { status: 'failed', error: configuration.reason });
    return { outcome: 'skipped-not-configured', written: 0, reason: configuration.reason };
  }

  const prompt = renderQuizScaffoldPrompt({ from: key.from, to: key.to, count });
  const estimateUsd = estimateRunCostUsd(active.model, prompt, count);

  const reservation = await reserve(estimateUsd);
  if (!reservation.ok) {
    const error = 'The daily budget for this installation is used up.';
    await finishScaffoldRun(db, key, { status: 'budget', error });
    return { outcome: 'budget', written: 0, reason: error };
  }

  const { cards, costUsd } = await callModel(active, prompt);
  // SETTLED, NEVER RELEASED, for the same reason `translate-headword.ts`
  // never releases: a model call that answered badly and one that never
  // answered are indistinguishable once `registry.complete` has rejected, and
  // the first of the two already spent money.
  await settle({ estimateUsd, actualUsd: costUsd ?? estimateUsd });

  const written = await writeScaffoldCards(db, { from: key.from, to: key.to, cards });
  await finishScaffoldRun(db, key, { status: 'ok', written, costUsd });

  return { outcome: 'written', written, reason: null };
}

/** The pg-boss facing wrapper: decode the context, run the body, report it. */
export const scaffoldVocabHandler: OperationHandler = async (ctx) => {
  const payload = scaffoldVocabContextSchema.parse(ctx.initialContext);
  const summary = await runScaffoldVocab(payload);
  if (summary.outcome === 'failed') {
    return { status: 'failed', reason: summary.reason ?? 'Scaffold generation failed' };
  }
  return { status: 'completed', data: { outcome: summary.outcome, written: summary.written, reason: summary.reason } };
};
