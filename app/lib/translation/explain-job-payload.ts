/**
 * What a queued explain job is allowed to say.
 *
 * THIS SCHEMA IS THE PRIVACY BOUNDARY, AND IT IS THE MOST IMPORTANT THING IN
 * THIS FILE.
 *   A queued job carries a folded question, two language codes and the id of the
 *   row it reports into, and NOTHING about who asked for it. This product's
 *   claim is that looking something up does not build a record of the person who
 *   looked it up, and a queue row pairing a reader with a question would defeat
 *   that claim on its own, whatever the rest of the app does. It matters more
 *   here than on the phrase path, not less: a question is a more revealing thing
 *   to have typed than a sentence to translate.
 *
 *   `z.strictObject` is what makes the absence of an identity field ENFORCEABLE
 *   rather than a convention somebody remembers. An extra key is a parse error,
 *   so a future caller that helpfully threads a user id through gets a rejected
 *   enqueue at the boundary instead of a silently carried field in a JSONB
 *   column that nobody reads again until it matters.
 *
 *   `runId` is not an exception to that rule. It names an `explanations` row,
 *   which carries a question, two languages, a model and a status, and carries
 *   no reader either.
 *
 *   WHERE THE READER IS RECORDED, SO THIS FILE IS NOT READ AS MORE THAN IT
 *   SAYS. The job and the model that answers it still never learn who asked,
 *   and M200 did not change that. What M200 did change is the inference: a
 *   reader who follows the rule above to "therefore nothing about the asker is
 *   recorded anywhere" would now be wrong. A signed-in reader whose request
 *   OPENS a ledger row also gets a row in `explanation_authorship`, written by
 *   `enqueueExplain` in the same transaction as the ledger row and before any
 *   job is sent. That row exists by default, not by a decision the reader
 *   takes; the name shown beside a public question is the part they switch on.
 *   See `app/lib/translation/explain-enqueue.server.ts`,
 *   `app/models/explanation-authorship.server.ts` and
 *   `drizzle/schema/explanation-authorship.ts`.
 *
 * THE QUESTION AS TYPED IS NOT IN THE PAYLOAD, AND THAT IS NOT A PRIVACY POINT.
 *   The job reads it from its own row, which already holds it. Carrying it here
 *   too would mean the queue and the row could disagree about what was asked,
 *   and the row is the one a reader is served from.
 *
 * WHY THIS IS ITS OWN MODULE, RATHER THAN LIVING IN `explain-enqueue.server`
 *   The same two reasons `phrase-job-payload.ts` gives. `#app/workflows/types`
 *   needs this shape for the workflow's context and `explain-enqueue.server`
 *   needs `WORKFLOW_TYPES` from that module, so defining it on either side makes
 *   an evaluation cycle, and the loser of a cycle reads a still uninitialised
 *   binding and throws at module load. And `explain-enqueue.server` reaches the
 *   orchestrator, and through it the database pool, which connects at import,
 *   while the unit tier runs with no database.
 *
 * NO SERVER IMPORTS BELONG HERE.
 */

import { z } from 'zod';

import { SERVED_LANGUAGES } from '#app/lib/dictionary/detect-language';

/** The one shape a queued explain job may carry. See the file comment. */
export const explainJobPayloadSchema = z.strictObject({
  /** The language the words in the question belong to. */
  from: z.enum(SERVED_LANGUAGES),
  /** The language the explanation is written in. */
  to: z.enum(SERVED_LANGUAGES),
  /**
   * The folded question, which is the cache key:
   * `normalizeQuery(raw, from).normalized`.
   *
   * It is here because the singleton key is built from it, and two readers
   * asking the same thing with different capitals have to collide.
   */
  questionNormalized: z.string().min(1),
  promptVersion: z.number().int().positive(),
  /**
   * The `explanations` row this job reports into.
   *
   * WRITTEN BEFORE THE ENQUEUE, IN THE REQUEST THAT ASKED. The pane reads the
   * latest row for a key to decide what to show, so a job with no row behind it
   * would leave a reader looking at nothing while a model was already answering.
   * The job's every exit path writes a terminal status onto this id.
   */
  runId: z.string().min(1),
});

export type ExplainJobPayload = z.infer<typeof explainJobPayloadSchema>;

/**
 * The key two identical requests collide on.
 *
 * `runId` IS DELIBERATELY ABSENT, for the reason `phraseSingletonKey` gives: it
 * is fresh on every request by construction, so including it would make every
 * key unique and the dedupe could never fire once. The whole point is that a
 * second reader asking the same question rides the first reader's job.
 *
 * THE PREFIX IS KEPT EVEN THOUGH THIS QUEUE HOLDS ONE JOB TYPE. `explain-terms`
 * carries only this job today, so nothing can collide with it; the namespace
 * costs one word and is what keeps that true if a second job ever joins the
 * queue, which is exactly how the word and phrase keys came to need theirs.
 */
export function explainSingletonKey(payload: ExplainJobPayload): string {
  return `explain:${payload.from}:${payload.to}:${payload.promptVersion}:${payload.questionNormalized}`;
}
