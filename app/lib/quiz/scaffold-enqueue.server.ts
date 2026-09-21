/**
 * Requesting one language pair's starter vocabulary, at most once per
 * genuine attempt.
 *
 * THE DATABASE ROW IS THE GUARD, NOT PG-BOSS. `claimScaffoldRun` opens or
 * reopens `quiz_scaffold_runs`' one row for this pair; only the caller whose
 * write actually landed gets past the guard and enqueues a job. See
 * `app/workflows/templates/scaffold-vocab.ts` for why that is enough and a
 * `stately` pg-boss queue is not needed here.
 *
 * A PAGE MUST NEVER FAIL BECAUSE THE QUEUE IS DOWN, the same rule
 * `enqueueExplain` follows. An orchestrator that has not booted is checked,
 * and never claimed against, before anything is written; a `send` that
 * throws AFTER the claim releases it again rather than leaving it stuck. See
 * the function body for both. Either way this function itself never throws: a
 * reader's deck is served from whatever organic material and scaffold cards
 * already exist regardless.
 */
import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import { createComponentLogger } from '#app/lib/logger';
import { claimScaffoldRun, finishScaffoldRun } from '#app/models/quiz.server';
import { QUIZ_SCAFFOLD_TARGET_COUNT } from '#app/lib/llm/quiz-scaffold-schema';
import { quizScaffoldJobPayloadSchema } from '#app/lib/quiz/scaffold-job-payload';
import { WORKFLOW_TYPES } from '#app/workflows/types';

const log = createComponentLogger('QuizScaffoldEnqueue');

/**
 * Ask for this pair's starter vocabulary if nobody has yet.
 *
 * Fire-and-forget from the caller's point of view: it never throws, and the
 * cards it produces are not on this request's response either way. A reader
 * whose deck triggered a first-ever backfill sees today's deck built from
 * whatever else is on hand; the pool is simply bigger the next time anybody's
 * deck for this pair is assembled.
 */
export async function requestScaffoldIfNeeded(
  db: DictionaryDb,
  params: { from: LanguageCode; to: LanguageCode },
): Promise<void> {
  // CHECKED BEFORE THE ROW IS CLAIMED, for the same reason `enqueueExplain`
  // checks the orchestrator before it writes anything: claiming a row this
  // early, with no worker able to run the job, would mean waiting on
  // `orchestrator.start()`'s catch below to release it again for no reason,
  // on every single request while the orchestrator stays down.
  const orchestrator = await readOrchestrator();
  if (orchestrator === null) return;

  const claimed = await claimScaffoldRun(db, { from: params.from, to: params.to, requestedCount: QUIZ_SCAFFOLD_TARGET_COUNT });
  if (!claimed) return; // Already queued or already served (pending or ok); a failed or budget row would have been reclaimed instead.

  const payload = quizScaffoldJobPayloadSchema.parse({ from: params.from, to: params.to, count: QUIZ_SCAFFOLD_TARGET_COUNT });

  // A FAILED SEND RELEASES THE CLAIM IT JUST TOOK. `orchestrator.start()`
  // throwing here means no job is actually running behind the row
  // `claimScaffoldRun` opened a moment ago. Left `pending`, that row would be
  // a one-shot claim burned forever, because `quiz_scaffold_runs` is ONE
  // MUTABLE ROW per pair, not an append-only ledger like `translation_runs`:
  // there is no later request that opens a fresh row to supersede it. Marking
  // it `failed` instead puts it back into the set `claimScaffoldRun`'s
  // `setWhere` treats as reclaimable, so the next reader of this pair gets a
  // real second attempt rather than a permanently stuck pool.
  try {
    await orchestrator.start({ type: WORKFLOW_TYPES.SCAFFOLD_VOCAB, context: payload });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    log.warn('A quiz scaffold job was not queued, releasing the claim', { from: params.from, to: params.to, reason });
    await finishScaffoldRun(db, { from: params.from, to: params.to }, { status: 'failed', error: reason });
  }
}

/**
 * The orchestrator, or null when it was never initialised.
 *
 * A DYNAMIC IMPORT, for the same reason `explain-enqueue.server.ts` uses one:
 * a static import is an edge in the module graph that would put a workflow
 * boot dependency on every page that might one day ask for a quiz deck.
 */
async function readOrchestrator() {
  try {
    const { getOrchestrator } = await import('#app/services/workflows.server');
    return getOrchestrator();
  } catch (cause) {
    log.warn('A quiz scaffold job was not queued: the workflow orchestrator is not initialised', {
      reason: cause instanceof Error ? cause.message : String(cause),
    });
    return null;
  }
}
