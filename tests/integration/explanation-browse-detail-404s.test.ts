/**
 * Every reason the public detail page will not serve a row is the same 404
 * (M200 spec 03).
 *
 * WHY SAMENESS IS THE PROPERTY UNDER TEST, NOT MERELY THE STATUS
 *   Six different things can make `/browse/explanations/:id` refuse: an id
 *   nothing carries, an id that is not a UUID at all, a question an operator
 *   hid, a row its author un-listed, a row with no authorship claim, and a row
 *   that is no longer the latest answered one for its question. If any of them
 *   answered differently from the others, a stranger holding an id could tell
 *   "this never existed" apart from "this was taken down", which is exactly the
 *   fact a take-down is about. So the cases below compare the refusals to EACH
 *   OTHER, not only to the number 404.
 *
 *   The malformed case is also the one that would otherwise be a 500. The
 *   column is `uuid`, and Postgres answers a malformed value with an error
 *   rather than an empty result, so a typed URL would take the page down
 *   instead of 404ing.
 *
 * AND ONE ROW MUST STILL BE SERVED. Without the positive case every assertion
 * here would pass on a page that refuses everybody, which is the opposite of
 * what this section is for.
 *
 * ISOLATION. One author, five ledger rows, their authorship rows and one
 * moderation row, all created here and all deleted in `after()`. The moderation
 * row has no foreign key, so it is deleted by its own key.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { RouterContextProvider } from 'react-router';
import { z } from 'zod';

import { closePool, getRawDb, poolInitialized } from '../../drizzle/db';
import { explanationAuthorship, explanationModeration, explanations, users } from '../../drizzle/schema';
import { loader as browseDetailLoader } from '../../app/routes/browse.explanations.$id';

const DB_HOST = process.env.DB_HOST;

const db = getRawDb();

const FROM = 'tr';
const TO = 'es';

/** Every question this file writes carries this, so a stray row is traceable to it. */
const RUN = randomUUID().slice(0, 8);

const LISTED_ID = randomUUID();
const UNLISTED_ID = randomUUID();
const HIDDEN_ID = randomUUID();
const ORPHAN_ID = randomUUID();
const SUPERSEDED_OLD_ID = randomUUID();
const SUPERSEDED_NEW_ID = randomUUID();

/** An id nothing in the database carries. */
const STRANGER_ID = randomUUID();

/** Not a UUID at all, which is what a hand-typed address looks like. */
const MALFORMED_ID = `not-a-uuid-${RUN}`;

const HIDDEN_QUESTION = `zz-detail-hidden-${RUN}`;
const SUPERSEDED_QUESTION = `zz-detail-superseded-${RUN}`;

let authorId = 0;

/** Clock values far enough apart that "which is the latest row" is an observation. */
function at(minutes: number): Date {
  return new Date(Date.UTC(2031, 1, 1, 0, minutes, 0));
}

/** What a thrown refusal actually is, decoded rather than assumed. */
const refusalSchema = z.object({ init: z.object({ status: z.number() }), data: z.null() });

/**
 * One refusal as a comparable string, or `served` when the loader answered.
 *
 * The string carries the status AND the fact that the body is empty, so two
 * refusals that differed in either would compare unequal.
 */
async function openDetail(id: string): Promise<string> {
  const request = new Request(`https://kenning.altan.fyi/browse/explanations/${id}`);
  try {
    const answer = await browseDetailLoader({
      request,
      url: new URL(request.url),
      params: { id },
      pattern: '/browse/explanations/:id',
      context: new RouterContextProvider(),
    });
    return `served ${answer.explanation.id}`;
  } catch (cause) {
    if (cause instanceof Response) return `Response ${cause.status}`;
    const parsed = refusalSchema.safeParse(cause);
    if (parsed.success) return `refused ${parsed.data.init.status} with an empty body`;
    return `threw ${String(cause)}`;
  }
}

function answeredRow(id: string, question: string, createdAt: Date) {
  return {
    id,
    fromLanguageCode: FROM,
    toLanguageCode: TO,
    question,
    questionNormalized: question,
    status: 'ok',
    answer: {
      answer: `a fixture answer for ${question}`,
      terms: [],
      contrasts: [],
      pitfalls: [],
      related: [],
      references: [],
    },
    provider: 'test-fixture',
    model: 'test-model',
    promptVersion: 1,
    createdAt,
  };
}

before(async () => {
  if (!DB_HOST) return;
  await poolInitialized;

  const [author] = await db
    .insert(users)
    .values({
      email: `zz-detail-author-${randomUUID()}@example.invalid`,
      passwordHash: '$2b$10$abcdefghijklmnopqrstuvwxyz012345678901234567890123456789',
      emailVerifiedAt: new Date(),
    })
    .returning({ id: users.id });
  if (!author) throw new Error('failed to seed the fixture author');
  authorId = author.id;

  await db.insert(explanations).values([
    answeredRow(LISTED_ID, `zz-detail-listed-${RUN}`, at(10)),
    answeredRow(UNLISTED_ID, `zz-detail-unlisted-${RUN}`, at(11)),
    answeredRow(HIDDEN_ID, HIDDEN_QUESTION, at(12)),
    answeredRow(ORPHAN_ID, `zz-detail-orphan-${RUN}`, at(13)),
    // Both listed, both answered, one key. Only the newer one is servable.
    answeredRow(SUPERSEDED_OLD_ID, SUPERSEDED_QUESTION, at(14)),
    answeredRow(SUPERSEDED_NEW_ID, SUPERSEDED_QUESTION, at(15)),
  ]);

  await db.insert(explanationAuthorship).values([
    { explanationId: LISTED_ID, userId: authorId, listed: true },
    { explanationId: UNLISTED_ID, userId: authorId, listed: false },
    { explanationId: HIDDEN_ID, userId: authorId, listed: true },
    // ORPHAN_ID deliberately gets none.
    { explanationId: SUPERSEDED_OLD_ID, userId: authorId, listed: true },
    { explanationId: SUPERSEDED_NEW_ID, userId: authorId, listed: true },
  ]);

  await db.insert(explanationModeration).values({
    fromLanguageCode: FROM,
    toLanguageCode: TO,
    questionNormalized: HIDDEN_QUESTION,
    hiddenByUserId: authorId,
    reason: 'a fixture hide',
  });
});

after(async () => {
  if (DB_HOST) {
    await db
      .delete(explanationModeration)
      .where(
        and(
          eq(explanationModeration.fromLanguageCode, FROM),
          eq(explanationModeration.toLanguageCode, TO),
          eq(explanationModeration.questionNormalized, HIDDEN_QUESTION),
        ),
      );
    await db
      .delete(explanations)
      .where(
        inArray(explanations.id, [LISTED_ID, UNLISTED_ID, HIDDEN_ID, ORPHAN_ID, SUPERSEDED_OLD_ID, SUPERSEDED_NEW_ID]),
      );
    if (authorId !== 0) await db.delete(users).where(eq(users.id, authorId));
  }

  await poolInitialized;
  await closePool();
});

describe('the public detail page', () => {
  it('serves a listed, answered, unhidden row', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    assert.equal(
      await openDetail(LISTED_ID),
      `served ${LISTED_ID}`,
      'the positive case is missing, so every refusal below would pass on a page that refuses everybody',
    );
  });

  it(
    'serves the LATEST answered row for a question that has more than one',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      assert.equal(await openDetail(SUPERSEDED_NEW_ID), `served ${SUPERSEDED_NEW_ID}`);
    },
  );

  it(
    'refuses six different ways, and refuses them identically',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const refusals = {
        'an id nothing carries': await openDetail(STRANGER_ID),
        'an id that is not a UUID': await openDetail(MALFORMED_ID),
        'a question an operator hid': await openDetail(HIDDEN_ID),
        'a row its author un-listed': await openDetail(UNLISTED_ID),
        'a row with no authorship claim': await openDetail(ORPHAN_ID),
        'a row superseded by a newer answer': await openDetail(SUPERSEDED_OLD_ID),
      };

      for (const [reason, outcome] of Object.entries(refusals)) {
        assert.equal(
          outcome,
          'refused 404 with an empty body',
          `${reason} answered "${outcome}". A malformed id in particular must not become a 500: the column is ` +
            'uuid, so Postgres errors on it rather than answering nothing.',
        );
      }

      assert.equal(
        new Set(Object.values(refusals)).size,
        1,
        `the six refusals are not identical: ${JSON.stringify(refusals, null, 2)}\nA stranger holding an id could ` +
          'then tell "this never existed" apart from "this was taken down", which is the fact the take-down was ' +
          'about.',
      );
    },
  );
});
