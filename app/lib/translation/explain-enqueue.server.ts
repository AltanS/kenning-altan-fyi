/**
 * Putting one question on the explain queue, and opening the row that reports
 * what happens to it.
 *
 * THE PAYLOAD IS THE PRIVACY BOUNDARY. THIS IS THE MOST IMPORTANT THING HERE.
 *   A queued job carries a folded question, two language codes and a row id, and
 *   NOTHING about who asked for it. The shape itself is written in
 *   `#app/lib/translation/explain-job-payload`, which states the rule in full
 *   and carries no server import, so the unit tier can hold it to that rule with
 *   no database in front of it.
 *   THE `userId` BELOW DOES NOT WEAKEN THAT RULE. It lives on
 *   `ExplainEnqueueRequest`, the caller's request object, which never leaves
 *   this process: it is read once, inside the transaction, to write the
 *   authorship row, and it is never on the job payload pg-boss carries to the
 *   worker. `explainJobPayloadSchema.parse` below is built field by field and is
 *   not handed the request, so the boundary is enforced rather than remembered.
 *
 * THE ROW IS WRITTEN BEFORE THE ENQUEUE, IN THE SAME REQUEST.
 *   The pane resolves what to show from the LATEST row for a key. A job queued
 *   with no row behind it therefore leaves the reader on "nothing can happen"
 *   while a model is already answering, and the next load enqueues again. So the
 *   row comes first, `pending`, and its id travels in the payload.
 *
 * A PAGE MUST NEVER 500 BECAUSE THE QUEUE IS DOWN. Every failure mode here is a
 * return value, not a throw: a duplicate is `deduped`, an uninitialised
 * orchestrator is `unavailable`.
 *
 * IT HAS ITS OWN QUEUE, UNLIKE THE PHRASE JOB. `EXPLAIN_QUEUE` carries the
 * `stately` policy that makes a singleton key bite at all, set beside the other
 * two in `initializeWorkflows`. The reason it is not the `translation` queue is
 * written out on the constant: an explain call is the slowest this app makes,
 * and sharing the word job's two workers would hold a reader's single-word
 * translation behind somebody else's explanation.
 */

import type { WorkflowOrchestrator } from '@sprqvntrs/workflows';
import { WorkflowError } from '@sprqvntrs/workflows';

import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import { createComponentLogger } from '#app/lib/logger';
import {
  explainJobPayloadSchema,
  explainSingletonKey,
  type ExplainJobPayload,
} from '#app/lib/translation/explain-job-payload';
import { getActiveModel } from '#app/models/app-settings.server';
import { insertExplanationAuthorship } from '#app/models/explanation-authorship.server';
import { deletePendingExplanation, insertPendingExplanation } from '#app/models/explanations.server';
import { getUserProfile } from '#app/models/user-profiles.server';
import { WORKFLOW_TYPES } from '#app/workflows/types';

const log = createComponentLogger('ExplainEnqueue');

export {
  explainJobPayloadSchema,
  explainSingletonKey,
  type ExplainJobPayload,
} from '#app/lib/translation/explain-job-payload';

/**
 * What an enqueue did.
 *
 * `deduped` is a SUCCESS: the work is already queued or running, which is
 * exactly what the singleton key exists to arrange. The row id is carried back
 * on `queued` only, because that is the only case in which a row was left behind
 * for the caller to poll; a deduped caller polls by key and finds the row the
 * first caller opened.
 */
export type ExplainEnqueueResult =
  | { outcome: 'queued'; runId: string }
  | { outcome: 'deduped'; runId: null }
  | { outcome: 'unavailable'; runId: null };

/** What a caller supplies. The row id is minted here, so it is not the caller's to pass. */
export interface ExplainEnqueueRequest {
  from: ExplainJobPayload['from'];
  to: ExplainJobPayload['to'];
  /** As typed, trimmed. It is what the model is shown and what the row stores. */
  question: string;
  /** The folded form, which is the cache key and half the singleton key. */
  questionNormalized: string;
  promptVersion: number;
  /**
   * Who is asking. Required, because the two call sites both resolve a signed-in
   * reader before they get here and there is no path that reaches this function
   * signed out. It is written to `explanation_authorship` and NOWHERE else, and
   * in particular never to the job payload. See the header.
   */
  userId: number;
}

/**
 * Open a row and queue one explain job, at most once per key.
 *
 * @param db The database handle, so the row is written on the caller's
 *   connection rather than through a second import of the pool.
 * @param request The question, the two languages, the prompt version and the
 *   reader asking. The row id is minted inside.
 * @returns which of the three things happened, and the row id when one was
 *   queued. It does not throw for a duplicate or for a missing orchestrator.
 */
export async function enqueueExplain(db: DictionaryDb, request: ExplainEnqueueRequest): Promise<ExplainEnqueueResult> {
  const orchestrator = await readOrchestrator();
  // CHECKED BEFORE THE ROW IS WRITTEN. An orchestrator that is not up means
  // nothing will ever run, so opening a `pending` row first would leave a reader
  // watching a spinner for a job that was never queued.
  if (orchestrator === null) return { outcome: 'unavailable', runId: null };

  // READ PER REQUEST, NEVER MODULE-CACHED. Switching the model is an operator
  // action taken while the server is running, and the row has to name the
  // selection as it stood when the reader asked.
  const active = await getActiveModel();
  // ONE TRANSACTION, AND IT CLOSES BEFORE THE JOB IS SENT. The ledger row and
  // the row naming its author are committed together, so a crash between them
  // rolls back both and there is no window in which an explanation exists with
  // no author. It has to happen HERE rather than in the route that renders the
  // answer: past this function `orchestrator.start()` has already sent the job
  // on pg-boss's own connection, outside any transaction a caller could open,
  // and a rollback after that point would leave a queued job pointing at a row
  // that no longer exists.
  const runId = await db.transaction(async (tx) => {
    const id = await insertPendingExplanation(tx, {
      from: request.from,
      to: request.to,
      question: request.question,
      questionNormalized: request.questionNormalized,
      promptVersion: request.promptVersion,
      provider: active.provider,
      model: active.model,
    });
    // THE INITIAL VISIBILITY IS THE READER'S OWN STANDING PREFERENCE, read in
    // the same transaction and never taken from the request that arrived over
    // HTTP. `getUserProfile` answers the all-defaults shape for a reader with no
    // row, so a reader who has never opened `/settings` starts out public.
    const profile = await getUserProfile(tx, request.userId);
    await insertExplanationAuthorship(tx, {
      explanationId: id,
      userId: request.userId,
      listed: !profile.hideNewExplanationsByDefault,
    });
    return id;
  });

  // Parsed again here even though the caller has a typed value, because this is
  // where the privacy rule is enforced and a compile-time type does not enforce
  // it against a value that arrived over HTTP. The question as typed is not part
  // of the payload, so it is not passed in.
  const parsed = explainJobPayloadSchema.parse({
    from: request.from,
    to: request.to,
    questionNormalized: request.questionNormalized,
    promptVersion: request.promptVersion,
    runId,
  });
  const singletonKey = explainSingletonKey(parsed);

  try {
    await orchestrator.start({ type: WORKFLOW_TYPES.EXPLAIN_TERMS, context: parsed, singletonKey });
    return { outcome: 'queued', runId };
  } catch (cause) {
    // pg-boss returns null from `send` when a job with this singleton key is
    // already queued or active, and @sprqvntrs/workflows 0.2.5 turns that null
    // into a WorkflowError with code QUEUE_ERROR. That is the dedupe working, so
    // it is caught here rather than propagated. The match is on `code` rather
    // than on the message text, which is prose and may be reworded.
    //
    // THE ROW THIS JUST WROTE IS REMOVED, NOT MARKED FAILED. The pane reads the
    // LATEST row for a key. A `failed` row left here would be newer than the row
    // of the job that is actually running, so the reader would be told the
    // explanation failed while it was in fact on its way.
    if (cause instanceof WorkflowError && cause.code === 'QUEUE_ERROR') {
      await deletePendingExplanation(db, runId);
      log.debug('An explain job is already queued for this key', { singletonKey });
      return { outcome: 'deduped', runId: null };
    }
    // Any other rejection leaves no job either, so the row must not survive as a
    // spinner. The throw still propagates: this is not an expected state.
    await deletePendingExplanation(db, runId);
    throw cause;
  }
}

/**
 * The orchestrator, or null when it was never initialised.
 *
 * A deployment can serve pages with no worker behind it, in dev and during a
 * restart, and that is an ordinary state rather than an error.
 *
 * WHY THE IMPORT IS DYNAMIC, AND IT IS NOT ABOUT SPEED. A static import here is
 * an EDGE IN THE MODULE GRAPH, and the bundler follows it: route -> this file ->
 * workflows.server -> registerAllWorkflows -> every template -> every operation
 * handler -> the prompt modules, which read their markdown from disk. That chain
 * puts a file read on the boot path of the WEB server, which needs none of it to
 * queue one job. Deferring the import to the moment a job is actually queued
 * cuts the edge, and the `catch` covers the import as well as the call.
 */
async function readOrchestrator(): Promise<WorkflowOrchestrator | null> {
  try {
    const { getOrchestrator } = await import('#app/services/workflows.server');
    return getOrchestrator();
  } catch (cause) {
    log.warn('An explain job was not queued: the workflow orchestrator is not initialised', {
      reason: cause instanceof Error ? cause.message : String(cause),
    });
    return null;
  }
}
