/**
 * The room job: one model writes a topic room, two blind reviewers judge it, and
 * code keeps what both accepted.
 *
 * AT MOST ONE PAID RUN PER ATTEMPT. The job first claims its attempt, which
 * matches a `pending` row of that attempt that no job has taken. A redelivered
 * job, a job superseded by a retry and a job whose room was deleted all find
 * nothing and call nothing.
 *
 * EVERY EXIT PATH WRITES A TERMINAL STATUS, onto its own attempt only. A run
 * that ended without one would leave a reader watching a progress screen until
 * the stale threshold.
 *
 * AN ATTEMPT THAT NEVER REACHED THE PROVIDER GIVES ITS BUILD BACK to the
 * reader's daily count.
 *
 * IT FAILS CLOSED. A reviewer that gives no usable answer in all its attempts
 * fails the run. Nothing unreviewed is ever stored.
 *
 * NO LOG LINE PAIRS A READER WITH A TOPIC. The lines here carry the room id, the
 * attempt and counts.
 */

import type { OperationHandler } from '@sprqvntrs/workflows';
import { z } from 'zod';

import { recordRejection } from '#app/lib/abuse/rate-limit.server';
import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import { PAIR_LANGUAGES } from '#app/lib/dictionary/language-pair';
import { registry, type ActiveModel } from '#app/lib/llm/registry.server';
import { createComponentLogger } from '#app/lib/logger';
import type { RoomContent } from '#app/lib/rooms/content';
import { decideRoom, identifyDraft } from '#app/lib/rooms/decide';
import type { RoomJobPayload } from '#app/lib/rooms/job-payload';
import { ROOM_GENERATE_TIMEOUT_MS, ROOM_REVIEW_ATTEMPTS, ROOM_REVIEW_TIMEOUT_MS } from '#app/lib/rooms/limits';
import { roomDraftSchema, roomReviewSchema, type RoomReview } from '#app/lib/rooms/llm-schema';
import { callUnderBudget, type PaidCall, type SpendTally } from '#app/lib/rooms/spend.server';
import { getActiveModel } from '#app/models/app-settings.server';
import {
  claimRoomRun,
  finishRoom,
  releaseRoomBuild,
  setRoomStage,
  type RoomOutcome,
  type RoomRecord,
} from '#app/models/rooms.server';
import {
  renderRoomGeneratePrompt,
  renderRoomReviewPrompt,
  type RoomPromptParams,
  type RoomReviewerRole,
} from '#app/prompts/room';
import { buildRoomContextSchema } from '#app/workflows/types';
import { getRawDb } from '#drizzle/db';

const log = createComponentLogger('BuildRoom');

/**
 * How many output tokens each call is expected to cost, reasoning included. Both
 * are generous on purpose: an over-estimate is handed straight back by `settle`.
 */
const EXPECTED_WRITER_TOKENS = 10_000;
const EXPECTED_REVIEW_TOKENS = 6_000;

const BUDGET_MESSAGE = 'The daily budget for this installation is used up. Please try again tomorrow.';

/** What one run of the job did. */
export interface RoomRunSummary {
  outcome: 'written' | 'skipped' | 'budget' | 'failed';
  roomId: string;
  providerCalls: number;
  /** Why the run ended the way it did, when that is not obvious from the outcome. */
  reason: string | null;
}

/** How the build itself ended, before anything is written. `superseded` writes nothing. */
type RoomEnding = RoomOutcomeWithoutCost | { status: 'superseded' };

type RoomOutcomeWithoutCost =
  | Omit<Extract<RoomOutcome, { status: 'ok' }>, 'costUsd'>
  | Omit<Extract<RoomOutcome, { status: 'failed' | 'budget' }>, 'costUsd'>;

function failed(error: string): RoomOutcomeWithoutCost {
  return { status: 'failed', error, checkedCount: null, removedCount: null };
}

function overBudget(): RoomOutcomeWithoutCost {
  return { status: 'budget', error: BUDGET_MESSAGE, checkedCount: null, removedCount: null };
}

const roomLanguageSchema = z.enum(PAIR_LANGUAGES);

/**
 * The prompt's inputs, read off the row.
 *
 * @throws when the row names a language this app does not serve.
 */
function promptParams(room: RoomRecord): RoomPromptParams {
  const termLanguage: LanguageCode = roomLanguageSchema.parse(room.termLanguage);
  const glossLanguage: LanguageCode = roomLanguageSchema.parse(room.glossLanguage);
  return { topic: room.topic, termLanguage, glossLanguage };
}

interface ReviewerParams {
  role: RoomReviewerRole;
  active: ActiveModel;
  params: RoomPromptParams;
  draft: RoomContent;
  tally: SpendTally;
}

/** One reviewer, asked up to {@link ROOM_REVIEW_ATTEMPTS} times. Each attempt is its own paid call. */
async function askReviewer({ role, active, params, draft, tally }: ReviewerParams): Promise<PaidCall<RoomReview>> {
  const prompt = renderRoomReviewPrompt({ ...params, role, draft });
  let lastError = 'no attempt was made';
  for (let attempt = 1; attempt <= ROOM_REVIEW_ATTEMPTS; attempt += 1) {
    const answer = await callUnderBudget({
      active,
      prompt,
      schema: roomReviewSchema,
      timeoutMs: ROOM_REVIEW_TIMEOUT_MS,
      expectedOutputTokens: EXPECTED_REVIEW_TOKENS,
      tally,
    });
    if (answer.kind !== 'errored') return answer;
    lastError = answer.error;
  }
  return { kind: 'errored', error: `The ${role} reviewer gave no usable answer: ${lastError}` };
}

/** Write, review, decide. A throw out of here is turned into `failed` by the caller. */
async function buildRoom(room: RoomRecord, tally: SpendTally): Promise<RoomEnding> {
  // Read per job: switching the model is an operator action on a running worker.
  const active = await getActiveModel();
  const configuration = registry.describeConfiguration(active);
  if (!configuration.configured) return failed(configuration.reason);

  const params = promptParams(room);
  const written = await callUnderBudget({
    active,
    prompt: renderRoomGeneratePrompt(params),
    schema: roomDraftSchema,
    timeoutMs: ROOM_GENERATE_TIMEOUT_MS,
    expectedOutputTokens: EXPECTED_WRITER_TOKENS,
    tally,
  });
  if (written.kind === 'budget') return overBudget();
  if (written.kind === 'errored') return failed(`The writer call failed: ${written.error}`);

  const draft = identifyDraft({ draft: written.output, termLanguage: params.termLanguage });
  // A room deleted or retried while the writer ran is not worth two more calls.
  const staged = await setRoomStage(getRawDb(), { roomId: room.id, attempt: room.attempt, stage: 'checking' });
  if (staged === null) return { status: 'superseded' };

  // Side by side and blind: neither sees the other's answer.
  const shared = { active, params, draft, tally };
  const [language, subject] = await Promise.all([
    askReviewer({ ...shared, role: 'language' }),
    askReviewer({ ...shared, role: 'subject' }),
  ]);
  if (language.kind === 'budget' || subject.kind === 'budget') return overBudget();
  if (language.kind === 'errored') return failed(language.error);
  if (subject.kind === 'errored') return failed(subject.error);

  const decision = decideRoom({ draft, languageReview: language.output, subjectReview: subject.output });
  if (decision.kind === 'too-few') {
    return {
      status: 'failed',
      error: `Too little survived the review: ${decision.keptTerms} terms and ${decision.keptSentences} sentences.`,
      checkedCount: decision.checkedCount,
      removedCount: decision.removedCount,
    };
  }
  return {
    status: 'ok',
    content: decision.content,
    checkedCount: decision.checkedCount,
    removedCount: decision.removedCount,
    provider: written.provider,
    model: written.model,
  };
}

/** The build, with every throw turned into a `failed` ending. */
async function buildRoomSafely(room: RoomRecord, tally: SpendTally): Promise<RoomEnding> {
  try {
    return await buildRoom(room, tally);
  } catch (cause) {
    log.error('A room build threw', { roomId: room.id, attempt: room.attempt });
    return failed(cause instanceof Error ? cause.message : String(cause));
  }
}

/**
 * Write the terminal status. A document the database refuses (a character `jsonb`
 * cannot hold, say) still has to end the attempt, so it is written as `failed`.
 */
async function writeOutcome(room: RoomRecord, outcome: RoomOutcome): Promise<{ written: boolean; outcome: RoomOutcome }> {
  const run = { roomId: room.id, attempt: room.attempt };
  try {
    const finished = await finishRoom(getRawDb(), { ...run, outcome });
    return { written: finished !== null, outcome };
  } catch (cause) {
    const fallback: RoomOutcome = {
      status: 'failed',
      error: `The result could not be stored: ${cause instanceof Error ? cause.message : String(cause)}`,
      costUsd: outcome.costUsd,
      checkedCount: null,
      removedCount: null,
    };
    const finished = await finishRoom(getRawDb(), { ...run, outcome: fallback });
    return { written: finished !== null, outcome: fallback };
  }
}

/**
 * The job body, callable without pg-boss so a test can drive it directly.
 *
 * @param payload The room and the attempt this job was queued for.
 * @returns what happened.
 * @throws only when the database cannot record the ending.
 */
export async function runBuildRoom(payload: RoomJobPayload): Promise<RoomRunSummary> {
  const db = getRawDb();
  const room = await claimRoomRun(db, payload);
  if (room === null) {
    log.info('A room job found nothing to do', { roomId: payload.roomId, attempt: payload.attempt });
    return { outcome: 'skipped', roomId: payload.roomId, providerCalls: 0, reason: 'The attempt is not open' };
  }

  const tally: SpendTally = { calls: 0, costUsd: 0 };
  const ending = await buildRoomSafely(room, tally);
  const superseded: RoomRunSummary = {
    outcome: 'skipped',
    roomId: room.id,
    providerCalls: tally.calls,
    reason: 'The attempt was superseded',
  };
  if (ending.status === 'superseded') return superseded;

  const { written, outcome } = await writeOutcome(room, { ...ending, costUsd: tally.costUsd });
  if (!written) return superseded;

  if (outcome.status === 'budget') await recordRejection('budget');
  if (outcome.status !== 'ok' && tally.calls === 0) {
    await releaseRoomBuild(db, { userId: room.userId, day: room.buildDay });
  }
  log.info('A room build ended', {
    roomId: room.id,
    attempt: room.attempt,
    status: outcome.status,
    providerCalls: tally.calls,
    costUsd: tally.costUsd,
    checkedCount: outcome.checkedCount,
    removedCount: outcome.removedCount,
  });

  if (outcome.status === 'ok') {
    return { outcome: 'written', roomId: room.id, providerCalls: tally.calls, reason: null };
  }
  return { outcome: outcome.status, roomId: room.id, providerCalls: tally.calls, reason: outcome.error };
}

/**
 * The pg-boss facing wrapper. Only a `failed` summary fails the operation: a
 * refused or superseded run did what it was asked to do, and failing it would
 * put the job back on the queue.
 */
export const buildRoomHandler: OperationHandler = async (ctx) => {
  const payload = buildRoomContextSchema.parse(ctx.initialContext);
  const summary = await runBuildRoom(payload);
  if (summary.outcome === 'failed') {
    return { status: 'failed', reason: summary.reason ?? 'The room build failed' };
  }
  return {
    status: 'completed',
    data: {
      outcome: summary.outcome,
      roomId: summary.roomId,
      providerCalls: summary.providerCalls,
      reason: summary.reason,
    },
  };
};
