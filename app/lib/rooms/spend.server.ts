/**
 * One paid call of a room build: reserve, ask, settle.
 *
 * RESERVE BEFORE EVERY PROVIDER CALL AND SETTLE AFTER IT, whatever the call did.
 * See `app/lib/abuse/budget.server.ts`. A call that threw is settled at its
 * estimate, because a model that answered badly and one that never answered
 * surface the same way and the first of the two spent the money.
 *
 * THE JOB HOLDS ITS OWN DEADLINE. The provider SDK may retry a failure with a
 * backoff that runs far past the timeout it was handed, and the time bounds in
 * `limits.ts` only hold when no single call can outlive its share.
 *
 * NO `reasoningEffort` IS PASSED, for the reason the explain job gives: the
 * active model's own setting applies, and some endpoints refuse a request that
 * disables reasoning.
 */

import type { z } from 'zod';

import { reserve, settle } from '#app/lib/abuse/budget.server';
import { estimateCostUsd, modelPrice } from '#app/lib/llm/catalog';
import { registry, type ActiveModel } from '#app/lib/llm/registry.server';

import { ROOM_CALL_DEADLINE_MARGIN_MS } from './limits';

/** Roughly four characters per token, for the Latin-script languages this app serves. */
const CHARS_PER_TOKEN = 4;

/** What to reserve for a model with no row in the price table. Never zero: a free call never reaches the cap. */
const UNPRICED_MODEL_RESERVE_USD = 0.1;

/** What one attempt has spent so far. One tally per attempt, added to by every call. */
export interface SpendTally {
  /** Calls that reached the provider. */
  calls: number;
  /** USD. A call whose cost is unknown counts at its estimate. */
  costUsd: number;
}

export interface PaidCallParams<S extends z.ZodType> {
  active: ActiveModel;
  prompt: string;
  schema: S;
  timeoutMs: number;
  /** How many output tokens the answer is expected to cost, for the reservation. */
  expectedOutputTokens: number;
  tally: SpendTally;
}

/** How one call ended. `budget` means it was never made. */
export type PaidCall<TOut> =
  | { kind: 'answered'; output: TOut; provider: string; model: string }
  | { kind: 'budget' }
  | { kind: 'errored'; error: string };

/** What one call is expected to cost, in USD. */
export function estimateRoomCallCostUsd({
  model,
  prompt,
  expectedOutputTokens,
}: {
  model: string;
  prompt: string;
  expectedOutputTokens: number;
}): number {
  const price = modelPrice(model);
  if (price === null) return UNPRICED_MODEL_RESERVE_USD;
  return estimateCostUsd(price, Math.ceil(prompt.length / CHARS_PER_TOKEN), expectedOutputTokens);
}

/** The work, or a rejection once the deadline has passed. */
async function withDeadline<T>(work: Promise<T>, deadlineMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`No answer within ${deadlineMs}ms`)), deadlineMs);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Make one provider call under the daily budget.
 *
 * @returns how it ended. A provider failure is a value, so the caller owns the retry.
 * @throws when the budget itself cannot be read or written.
 */
export async function callUnderBudget<S extends z.ZodType>(params: PaidCallParams<S>): Promise<PaidCall<z.infer<S>>> {
  const { active, prompt, schema, timeoutMs, expectedOutputTokens, tally } = params;
  const estimateUsd = estimateRoomCallCostUsd({ model: active.model, prompt, expectedOutputTokens });
  // One instant for both halves, so a call that crosses midnight settles on the
  // day it was reserved on.
  const at = new Date();
  const reservation = await reserve(estimateUsd, at);
  if (!reservation.ok) return { kind: 'budget' };

  tally.calls += 1;
  let actualUsd = estimateUsd;
  try {
    const answer = await withDeadline(
      registry.complete(active, { prompt, schema, timeoutMs }),
      timeoutMs + ROOM_CALL_DEADLINE_MARGIN_MS,
    );
    actualUsd = answer.costUsd ?? estimateUsd;
    return { kind: 'answered', output: answer.output, provider: answer.provider, model: answer.model };
  } catch (cause) {
    return { kind: 'errored', error: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    tally.costUsd += actualUsd;
    await settle({ estimateUsd, actualUsd }, at);
  }
}
