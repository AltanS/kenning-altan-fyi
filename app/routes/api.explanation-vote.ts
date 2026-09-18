import { z } from 'zod';

import { jsonError } from '#app/lib/api-auth.server';
import { createComponentLogger } from '#app/lib/logger';
import { requireVoterAccount } from '#app/lib/votes/account-gate.server';
import {
  castExplanationVote,
  readExplanationRow,
  tallyExplanationVotes,
} from '#app/models/explanation-votes.server';
import type { VoteValue } from '#app/models/votes.server';
import { getRawDb } from '#drizzle/db';

/**
 * `POST /api/explanation-vote`, where a reader's judgement of one written
 * answer is recorded.
 *
 * AN ACTION ONLY, AND IT ALWAYS ANSWERS JSON.
 *   There is no loader: nothing here is readable, and a GET against this path
 *   should 405 rather than serve a shape somebody starts depending on. Every
 *   outcome is a JSON body with a `state` discriminant, never a redirect,
 *   because the caller is a fetcher inside an already-rendered answer.
 *
 * A VOTE IS RECORDED AND IT RANKS: no answer is re-run or hidden because of its
 * score. The public list at `/browse/explanations` orders by net score once the
 * two sides are `VOTE_MARGIN_THRESHOLD` apart and falls through to recency
 * below that, the same margin M196 gave the translation ranking. Beyond the
 * order, the rows are the signal, and the operator's list at `/super/llm` is
 * the whole of what is built on top of them. A future milestone that adds a
 * consequence here adds the guards with it.
 *
 * THIS ROUTE TAKES AN EXPLANATION ID FROM THE CLIENT, AND THAT IS CORRECT.
 *   M200's authorship mutations must never accept one, because granting or
 *   withdrawing a byline is an OWNER-RESTRICTED act and an id from a browser
 *   would let any reader name somebody else's row. Voting is not that: any
 *   signed-in reader may judge any answer they are looking at, so there is no
 *   ownership to check and nothing for a pasted id to escalate. What stands in
 *   its place is `readExplanationRow`, which confirms the id names an ANSWERED
 *   ledger row before anything is written. A reader of spec 01's rule should
 *   stop here rather than read this file as a violation of it.
 *
 * THE GOVERNANCE RULE GOVERNS THIS FILE.
 *   A vote row records an explanation id and an account id and NOTHING ELSE, and
 *   this route is the one place that holds an account id and a free-text
 *   question in the same process. The question is never logged here, at any
 *   level, and the line below carries a row id and an outcome only. A debug line
 *   pairing a reader with what they asked is a search log, whatever it is called.
 *
 * NO ENGLISH PROSE REACHES THE BROWSER FROM HERE. The refusal body carries a
 * locale key and the client resolves it. Writing the sentence here would put one
 * untranslated string in the middle of a translated page, and no gate catches
 * that.
 */

const log = createComponentLogger('ExplanationVote');

/**
 * The form body, decoded at the boundary.
 *
 * `value` arrives as the STRING `'1'` or `'-1'`, because a form encodes
 * everything as text. The enum pins the two acceptable spellings and the
 * transform turns them into the numeric literals the model layer takes, so no
 * numeric parsing and no range check is needed further in.
 */
const explanationVoteSubmissionSchema = z.object({
  explanationId: z.uuid(),
  value: z.enum(['1', '-1']).transform((raw): VoteValue => (raw === '1' ? 1 : -1)),
});

/** Every way this route can answer, as one union the client switches on. */
export type ExplanationVoteOutcome =
  | { state: 'unauthenticated'; messageKey: string }
  | { state: 'invalid' }
  | { state: 'recorded'; myVote: VoteValue; up: number; down: number };

/**
 * The one field this action reads.
 *
 * SPELLED OUT RATHER THAN TAKEN FROM `Route.ActionArgs`. Nothing here looks at a
 * dynamic param, at the matched pattern or at the middleware context, and a
 * structural parameter is what lets a test call this function with a bare
 * request instead of assembling five fields a vote never reads.
 */
export interface ExplanationVoteActionArgs {
  request: Request;
}

export async function action({ request }: ExplanationVoteActionArgs): Promise<Response> {
  if (request.method !== 'POST') throw jsonError(405, 'method not allowed');

  // The gate first, before the body is read. A signed-out visitor gets the same
  // answer whatever they posted, so there is nothing to learn by posting a
  // well-formed body versus a broken one.
  const accountId = await requireVoterAccount(request);
  if (accountId === null) {
    return Response.json({ state: 'unauthenticated', messageKey: 'explanationVote.signIn' }, { status: 401 });
  }

  const form = await request.formData();
  const parsed = explanationVoteSubmissionSchema.safeParse({
    explanationId: form.get('explanationId'),
    value: form.get('value'),
  });
  if (!parsed.success) return Response.json({ state: 'invalid' }, { status: 400 });

  const db = getRawDb();

  // The row is read BEFORE the vote is cast, and only an ANSWERED one passes.
  // The foreign key would accept a run that is still going or that failed, and a
  // vote on one of those would judge prose nobody has read.
  const explanationId = await readExplanationRow(db, parsed.data.explanationId);
  if (explanationId === null) return Response.json({ state: 'invalid' }, { status: 400 });

  await castExplanationVote(db, { explanationId, accountId, value: parsed.data.value });

  // The tally is read back rather than computed from the previous figures. The
  // client already guesses optimistically; this is the number that corrects the
  // guess, and it has to include the votes of everybody else who clicked while
  // this reader was reading.
  const tally = await tallyExplanationVotes(db, explanationId);

  log.info('Explanation vote recorded', { explanationId });
  const body = {
    state: 'recorded',
    myVote: parsed.data.value,
    up: tally.up,
    down: tally.down,
  } satisfies ExplanationVoteOutcome;
  return Response.json(body);
}
