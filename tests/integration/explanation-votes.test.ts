/**
 * A vote on one written explanation, driven through the real route.
 *
 * WHAT THIS FILE HOLDS IN PLACE
 *   `POST /api/explanation-vote` is where a reader says an answer is or is not
 *   accurate. Nothing automatic hangs off that vote this milestone, so the value
 *   of the row is entirely in its being CORRECT, and four things can make it
 *   wrong in ways nothing else notices.
 *
 *   1. ONE VOTE PER READER PER EXPLANATION. The composite primary key on
 *      (explanationId, accountId) is the whole rule, and `castExplanationVote`
 *      upserts on it. A plain insert would append a second row, the tally would
 *      count one person twice, and a single reader could push a score as far as
 *      they liked by clicking again.
 *   2. AN ANONYMOUS VOTE IS REFUSED, LOUDLY. A 401 with no row written, rather
 *      than a quiet 200 that drops the vote: a reader who is silently ignored
 *      clicks again, and a vote path that accepts anonymous writes has no
 *      "one vote per reader" rule left at all.
 *   3. AN UNANSWERED ROW COLLECTS NOTHING. `explanations` is append-only and
 *      holds `pending`, `failed` and `budget` rows the foreign key would accept
 *      happily. There is nothing to be accurate about until an answer exists, so
 *      `readExplanationRow` matches `status = 'ok'` and the route answers
 *      `invalid`. A test that only ever posted answered ids would never see it.
 *   4. THE CHECK CONSTRAINT IS THE LAST LINE. The route's own enum can only send
 *      `-1` or `1`, so the database is asserted directly here: a future caller
 *      that skips the route must still be refused.
 *
 * THE OPERATOR'S LIST NAMES THE QUESTION AND NEVER THE VOTER, and that is
 * asserted on the view's own KEYS rather than on one row's values. Checking that
 * some particular row carries no account id would pass the day somebody adds the
 * column and forgets to populate it for this fixture.
 *
 * NO PROVIDER AND NO QUEUE ARE INVOLVED. A vote is recorded and nothing else
 * (M194 decision 8), so there is no job to watch and no money to spend. Every
 * assertion is a row.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE
 *   `DB_HOST` and the other `DB_*` variables, nothing else. Every case gates on
 *   `DB_HOST` alone, which `tests/unit/integration-tests-self-skip.test.ts`
 *   enforces.
 *
 * ISOLATION
 *   Every row this file votes on is created by this file: three `explanations`
 *   rows and two users, all under ids that exist nowhere else, all deleted in
 *   `after()` in foreign-key-safe order. No existing row is read, written or
 *   reused.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import { getRawDb, pool, poolInitialized } from '../../drizzle/db';
import { explanationVotes, explanations, users } from '../../drizzle/schema';
import { action } from '../../app/routes/api.explanation-vote';
import { listDownVotedExplanations, readVoteForAccount } from '../../app/models/explanation-votes.server';
import { sessionStorage } from '../../app/services/session.server';

const DB_HOST = process.env.DB_HOST;

const db = getRawDb();

/** Every ledger row this file creates, under ids that exist nowhere else. */
const ANSWERED_ID = randomUUID();
const QUIET_ANSWERED_ID = randomUUID();
const PENDING_ID = randomUUID();

/** The direction the fixture is written for. Both codes are served. */
const FROM = 'de';
const TO = 'en';

/** The question the voted row answers, so the operator's list can be matched on it. */
const VOTED_QUESTION = `zz-voted-question-${randomUUID().slice(0, 8)}`;

/**
 * The two signed-in readers whose votes drive the route.
 *
 * REAL ROWS, NOT ARBITRARY IDS. `explanation_votes.accountId` carries a foreign
 * key to `users`, so a vote by a user that does not exist is refused by
 * Postgres. Their ids are whatever `serial` hands out.
 */
let voterAccountId = 0;
let secondVoterAccountId = 0;

/**
 * The response body, decoded rather than trusted.
 *
 * The route answers three shapes behind one `state` discriminant, and a test
 * that read `body.state` off an untyped value would keep passing if the field
 * were renamed.
 */
const voteResponseSchema = z.object({
  state: z.string(),
  up: z.number().optional(),
  down: z.number().optional(),
  myVote: z.number().optional(),
  messageKey: z.string().optional(),
});

/** A `Cookie` header holding a real signed session for one user id. */
async function signedCookieFor(accountId: number): Promise<string> {
  const session = await sessionStorage.getSession();
  session.set('user', { id: accountId, issuedAt: new Date().toISOString() });
  const setCookie = await sessionStorage.commitSession(session);
  return setCookie.split(';')[0] ?? '';
}

/** One throwaway user, so a vote has something to point its foreign key at. */
async function seedAccount(): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      email: `zz-explanation-voter-${randomUUID()}@example.invalid`,
      // A fixed non-secret string of the right shape. This file never
      // authenticates; it only needs a row the foreign key can resolve.
      passwordHash: '$2b$10$abcdefghijklmnopqrstuvwxyz012345678901234567890123456789',
      emailVerifiedAt: new Date(),
    })
    .returning({ id: users.id });
  if (!row) throw new Error('failed to seed the fixture user');
  return row.id;
}

/** Post one vote to the route, exactly as the buttons under an answer do. */
async function postVote(params: { explanationId: string; value: string; cookie: string | null }): Promise<Response> {
  const body = new FormData();
  body.set('explanationId', params.explanationId);
  body.set('value', params.value);

  const headers = new Headers();
  if (params.cookie !== null) headers.set('cookie', params.cookie);

  const request = new Request('https://kenning.altan.fyi/api/explanation-vote', {
    method: 'POST',
    headers,
    body,
  });

  return action({ request });
}

/** The decoded JSON body of a route response. */
async function readBody(response: Response): Promise<z.infer<typeof voteResponseSchema>> {
  return voteResponseSchema.parse(await response.json());
}

/** How many votes exist for one explanation. */
async function countVotes(explanationId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(explanationVotes)
    .where(eq(explanationVotes.explanationId, explanationId));
  return rows[0]?.count ?? 0;
}

before(async () => {
  if (!DB_HOST) return;
  await poolInitialized;

  await db.insert(explanations).values([
    {
      id: ANSWERED_ID,
      fromLanguageCode: FROM,
      toLanguageCode: TO,
      question: VOTED_QUESTION,
      questionNormalized: VOTED_QUESTION,
      status: 'ok',
      answer: { answer: 'a fixture answer', terms: [], contrasts: [], pitfalls: [], related: [], references: [] },
      provider: 'test-fixture',
      model: 'test-model',
      promptVersion: 1,
    },
    // A second answered row nobody votes on, so "this reader's own vote" can be
    // shown to be per explanation rather than per reader.
    {
      id: QUIET_ANSWERED_ID,
      fromLanguageCode: FROM,
      toLanguageCode: TO,
      question: `zz-quiet-question-${QUIET_ANSWERED_ID}`,
      questionNormalized: `zz-quiet-question-${QUIET_ANSWERED_ID}`,
      status: 'ok',
      answer: { answer: 'a quiet fixture answer', terms: [], contrasts: [], pitfalls: [], related: [], references: [] },
      provider: 'test-fixture',
      model: 'test-model',
      promptVersion: 1,
    },
    // A run that has not finished. The foreign key would accept a vote on it.
    {
      id: PENDING_ID,
      fromLanguageCode: FROM,
      toLanguageCode: TO,
      question: `zz-pending-question-${PENDING_ID}`,
      questionNormalized: `zz-pending-question-${PENDING_ID}`,
      status: 'pending',
      provider: 'test-fixture',
      model: 'test-model',
      promptVersion: 1,
    },
  ]);

  voterAccountId = await seedAccount();
  secondVoterAccountId = await seedAccount();
});

after(async () => {
  if (!DB_HOST) {
    await pool.end();
    return;
  }

  // Foreign-key-safe order, innermost first. Every predicate names a row this
  // file created and nothing else.
  await db
    .delete(explanationVotes)
    .where(inArray(explanationVotes.explanationId, [ANSWERED_ID, QUIET_ANSWERED_ID, PENDING_ID]));
  await db.delete(explanations).where(inArray(explanations.id, [ANSWERED_ID, QUIET_ANSWERED_ID, PENDING_ID]));
  // Last, and after the votes: the vote foreign key cascades, but deleting the
  // accounts first would silently take rows this file wanted to assert on.
  for (const accountId of [voterAccountId, secondVoterAccountId]) {
    if (accountId !== 0) await db.delete(users).where(eq(users.id, accountId));
  }

  await pool.end();
});

describe('explanation votes: casting one', () => {
  it(
    'replaces the earlier vote of one reader instead of adding a second row',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const cookie = await signedCookieFor(voterAccountId);

      const first = await readBody(await postVote({ explanationId: ANSWERED_ID, value: '1', cookie }));
      assert.equal(first.state, 'recorded');
      assert.equal(first.up, 1);
      assert.equal(first.down, 0);

      const [firstRow] = await db
        .select({ value: explanationVotes.value, updatedAt: explanationVotes.updatedAt })
        .from(explanationVotes)
        .where(eq(explanationVotes.explanationId, ANSWERED_ID));
      assert.ok(firstRow !== undefined, 'the first vote wrote no row');
      assert.equal(firstRow.value, 1);

      // A gap the clock can resolve, so "the timestamp moved" is a real
      // observation rather than a coin toss on millisecond boundaries.
      await new Promise((resolve) => setTimeout(resolve, 5));

      const second = await readBody(await postVote({ explanationId: ANSWERED_ID, value: '-1', cookie }));

      assert.equal(
        await countVotes(ANSWERED_ID),
        1,
        'the second vote added a row instead of replacing the first, so one reader is counted twice and can ' +
          'push a score as far as they like by clicking again',
      );
      assert.equal(second.up, 0, 'the tally did not follow the changed vote');
      assert.equal(second.down, 1);
      assert.equal(second.myVote, -1);

      const [secondRow] = await db
        .select({
          value: explanationVotes.value,
          updatedAt: explanationVotes.updatedAt,
          accountId: explanationVotes.accountId,
        })
        .from(explanationVotes)
        .where(eq(explanationVotes.explanationId, ANSWERED_ID));
      assert.ok(secondRow !== undefined);
      assert.equal(secondRow.value, -1, 'the second vote did not win, so a reader cannot change their mind');
      assert.ok(
        secondRow.updatedAt.getTime() > firstRow.updatedAt.getTime(),
        "updatedAt is frozen at the first vote. Drizzle's $onUpdate hook does not fire inside a conflict " +
          'clause, so the column has to be set explicitly there, and a stale timestamp misreports when a tally ' +
          'last changed.',
      );
      // The account id is the signed-in reader's own, and it is the ONLY thing
      // on the row besides the explanation: no question, no language pair.
      assert.equal(secondRow.accountId, voterAccountId);
    },
  );

  it(
    'counts a second reader as a second vote on the same explanation',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const cookie = await signedCookieFor(secondVoterAccountId);
      const body = await readBody(await postVote({ explanationId: ANSWERED_ID, value: '-1', cookie }));

      assert.equal(body.down, 2, 'the vote of the second reader was not counted');
      assert.equal(await countVotes(ANSWERED_ID), 2);
    },
  );

  it(
    'refuses an anonymous vote with 401 and writes nothing',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const votesBefore = await countVotes(QUIET_ANSWERED_ID);

      const response = await postVote({ explanationId: QUIET_ANSWERED_ID, value: '-1', cookie: null });
      const body = await readBody(response);

      assert.equal(
        response.status,
        401,
        `an anonymous vote answered ${response.status}. A silent 200 would drop the vote while telling the ` +
          'reader it counted, and the reader then clicks again.',
      );
      assert.equal(body.state, 'unauthenticated');
      assert.equal(body.messageKey, 'explanationVote.signIn');
      assert.equal(
        await countVotes(QUIET_ANSWERED_ID),
        votesBefore,
        'an anonymous vote wrote a row, so votes exist that belong to nobody and the one-vote-per-reader key ' +
          'means nothing',
      );
    },
  );

  it(
    'answers 400 for an id that names no explanation, and writes nothing',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const cookie = await signedCookieFor(voterAccountId);
      const strangerId = randomUUID();

      const response = await postVote({ explanationId: strangerId, value: '1', cookie });

      assert.equal(
        response.status,
        400,
        'a stale id from an old open tab reached the insert. The foreign key would refuse it as a database ' +
          'error deep in the action, which is a 500 for what is really a bad request.',
      );
      assert.equal((await readBody(response)).state, 'invalid');
      assert.equal(await countVotes(strangerId), 0);
    },
  );

  it(
    'refuses a vote on a run that has not produced an answer yet',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const cookie = await signedCookieFor(voterAccountId);

      const response = await postVote({ explanationId: PENDING_ID, value: '-1', cookie });

      assert.equal(
        response.status,
        400,
        'a pending run accepted a vote. The foreign key resolves happily, so only the status predicate in ' +
          'readExplanationRow stands between a reader and a judgement of prose that does not exist yet.',
      );
      assert.equal((await readBody(response)).state, 'invalid');
      assert.equal(await countVotes(PENDING_ID), 0);
    },
  );

  it(
    'is refused by the database itself for a value that is neither -1 nor 1',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      await assert.rejects(
        db.insert(explanationVotes).values({
          explanationId: QUIET_ANSWERED_ID,
          accountId: voterAccountId,
          // SAFETY: the column is typed `-1 | 1` nowhere; it is a smallint, and
          // this case exists to prove the CHECK constraint refuses the value a
          // caller bypassing the route could otherwise write.
          value: 7,
        }),
        /explanation_votes_value_check/,
        'the check constraint is missing, so a caller that skips the route can write any number it likes and ' +
          'the tally becomes arithmetic over made-up values',
      );
      assert.equal(await countVotes(QUIET_ANSWERED_ID), 0);
    },
  );
});

describe('explanation votes: what the next read shows', () => {
  it(
    "carries this reader's own vote back, and marks nothing for a reader who did not vote",
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const mine = await readVoteForAccount(db, { explanationId: ANSWERED_ID, accountId: voterAccountId });
      assert.equal(
        mine,
        -1,
        "the reader's own vote is missing after a reload, so the buttons come back unpressed and the reader " +
          'votes again',
      );

      const elsewhere = await readVoteForAccount(db, {
        explanationId: QUIET_ANSWERED_ID,
        accountId: voterAccountId,
      });
      assert.equal(
        elsewhere,
        null,
        'a vote on one explanation marked another as voted, so the vote is per reader rather than per answer',
      );
    },
  );

  it(
    "shows the down-voted question on the operator's list, with its pair and no voter",
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const listed = await listDownVotedExplanations(db, 100);
      const row = listed.find((candidate) => candidate.explanationId === ANSWERED_ID);

      assert.ok(
        row !== undefined,
        "a down-voted explanation is missing from the operator's list, which is the only place this milestone " +
          'makes the signal readable at all',
      );
      assert.equal(row.question, VOTED_QUESTION);
      assert.equal(row.from, FROM);
      assert.equal(row.to, TO);
      assert.equal(row.down, 2);
      assert.equal(row.up, 0);

      // THE KEYS, NOT THE VALUES. A row whose account column happened to be
      // empty for this fixture would pass a value check the day somebody adds
      // the column; an exact key set fails the moment one appears.
      assert.deepEqual(
        Object.keys(row).toSorted(),
        ['down', 'explanationId', 'from', 'lastVotedAt', 'question', 'to', 'up'],
        "the operator's list grew a column. It must never carry an account id, a voter name or anything joined " +
          'from the authorship or profile tables: triaging a bad answer must not also say who asked for it.',
      );
    },
  );
});
