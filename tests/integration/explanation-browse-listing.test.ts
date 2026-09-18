/**
 * What the public list shows, and everything it must never show (M200 spec 03).
 *
 * WHAT THIS FILE HOLDS IN PLACE
 *   `listPublicExplanations` is the one statement that decides what a stranger
 *   can read, and six different ways of getting it wrong all look like a
 *   working list.
 *
 *   1. AN UN-LISTED ROW MUST NOT APPEAR. The asker's own switch is the whole of
 *      their control over this, and a predicate applied in the wrong place
 *      silently ignores it.
 *   2. A ROW WITH NO AUTHORSHIP CLAIM MUST NOT APPEAR. Absence is NOT listed:
 *      the claim goes when its author deletes their account or withdraws the
 *      question, and reading absence as "public" would republish something
 *      somebody just took down. It also keeps every row written before this
 *      milestone off these pages.
 *   3. AN OLDER LISTED ROW MUST NEVER SURFACE BEHIND A NEWER UN-LISTED ONE. The
 *      ledger is append only, so one question can carry several answered rows.
 *      If the visibility test ran before the latest-row pick rather than after
 *      it, un-listing would publish the previous answer instead of hiding the
 *      question.
 *   4. A HIDDEN QUESTION MUST NOT APPEAR, keyed on the question rather than on
 *      one row, so a newer answered row cannot walk around the hide.
 *   5. THE BYLINE IS TWO CONDITIONS, AND THE JOIN MUST BE A LEFT JOIN. A reader
 *      who never opened `/settings` has no profile row at all: an inner join
 *      would drop every explanation they ever asked for, which is a listing
 *      that silently shrinks rather than one that visibly breaks.
 *   6. THE MARGIN OF TWO IS THE SORT. One drive-by vote must not reorder a list
 *      everybody reads, and two agreeing readers must.
 *
 * IT ASSERTS MEMBERSHIP AND RELATIVE ORDER, NEVER A TOTAL. The local database
 * is shared, so every assertion is about the rows this file seeded: "mine are
 * present", "mine are absent", "mine are in this order". An absolute count here
 * would be red on somebody else's unrelated row.
 *
 * ISOLATION. Four users, a profile, the ledger rows, their authorship rows,
 * their votes and one moderation row, all created here and all deleted in
 * `after()`. The moderation table has no foreign key, so its row is deleted by
 * key explicitly rather than left to a cascade.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { RouterContextProvider } from 'react-router';

import type { LanguageCode } from '../../app/lib/dictionary/detect-language';

import { closePool, getRawDb, poolInitialized } from '../../drizzle/db';
import {
  explanationAuthorship,
  explanationModeration,
  explanationVotes,
  explanations,
  userProfiles,
  users,
} from '../../drizzle/schema';
import { loader as browseListLoader } from '../../app/routes/browse.explanations';
import { resolvePublicByline } from '../../app/models/explanation-authorship.server';
import { listPublicExplanations, PUBLIC_EXPLANATIONS_PAGE_SIZE } from '../../app/models/explanation-browse.server';

const DB_HOST = process.env.DB_HOST;

const db = getRawDb();

/** The pair the semantic cases live in. Both codes are served. */
const FROM = 'tr';
const TO = 'es';

/** A second pair, for the language filter and the paging window, so neither disturbs the cases above. */
const OTHER_FROM = 'es';
const OTHER_TO = 'tr';

/** Every question this file writes carries this, so a stray row is traceable to it. */
const RUN = randomUUID().slice(0, 8);

const NAMED_ID = randomUUID();
const NO_PROFILE_ID = randomUUID();
const NAME_OFF_ID = randomUUID();
const UNLISTED_ID = randomUUID();
const HIDDEN_ID = randomUUID();
const ORPHAN_ID = randomUUID();
const SUPERSEDED_OLD_ID = randomUUID();
const SUPERSEDED_NEW_ID = randomUUID();
const RECENT_ID = randomUUID();
const MARGIN_ONE_ID = randomUUID();
const MARGIN_TWO_ID = randomUUID();

/** The window fixture: one page plus one row, so "show more" has something to widen into. */
const WINDOW_IDS = Array.from({ length: PUBLIC_EXPLANATIONS_PAGE_SIZE + 1 }, () => randomUUID());

/** The key the superseded pair shares. Both rows answer this same question. */
const SUPERSEDED_QUESTION = `zz-superseded-${RUN}`;
const HIDDEN_QUESTION = `zz-hidden-${RUN}`;

/** A public name nothing else in the database carries. */
const PUBLIC_NAME = `zz Reader ${RUN}`;

let namedAuthorId = 0;
let bareAuthorId = 0;
let voterOneId = 0;
let voterTwoId = 0;

/** Clock values far enough apart that the ordering assertions are observations, not coin tosses. */
function at(minutes: number): Date {
  return new Date(Date.UTC(2031, 0, 1, 0, minutes, 0));
}

async function seedUser(label: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      email: `zz-browse-${label}-${randomUUID()}@example.invalid`,
      passwordHash: '$2b$10$abcdefghijklmnopqrstuvwxyz012345678901234567890123456789',
      emailVerifiedAt: new Date(),
    })
    .returning({ id: users.id });
  if (!row) throw new Error(`failed to seed the ${label} fixture user`);
  return row.id;
}

/** One answered ledger row, with a question nothing else carries. */
function answeredRow(id: string, question: string, createdAt: Date, from: string = FROM, to: string = TO) {
  return {
    id,
    fromLanguageCode: from,
    toLanguageCode: to,
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

/** The ids one call returned, in the order it returned them. */
async function listedIds(from: LanguageCode | null, to: LanguageCode | null): Promise<string[]> {
  const page = await listPublicExplanations(db, { from, to, limit: 200, offset: 0 });
  return page.rows.map((row) => row.id);
}

/** The list route's own loader, driven the way a browser drives it. */
async function loadListPage(search: string) {
  const request = new Request(`https://kenning.altan.fyi/browse/explanations${search}`);
  return browseListLoader({
    request,
    url: new URL(request.url),
    params: {},
    pattern: '/browse/explanations',
    context: new RouterContextProvider(),
  });
}

before(async () => {
  if (!DB_HOST) return;
  await poolInitialized;

  namedAuthorId = await seedUser('named');
  bareAuthorId = await seedUser('bare');
  voterOneId = await seedUser('voter-one');
  voterTwoId = await seedUser('voter-two');

  await db.insert(userProfiles).values({
    userId: namedAuthorId,
    publicName: PUBLIC_NAME,
    publicNameFolded: PUBLIC_NAME.toLowerCase(),
  });

  await db.insert(explanations).values([
    answeredRow(NAMED_ID, `zz-named-${RUN}`, at(10)),
    answeredRow(NO_PROFILE_ID, `zz-no-profile-${RUN}`, at(11)),
    answeredRow(NAME_OFF_ID, `zz-name-off-${RUN}`, at(12)),
    answeredRow(UNLISTED_ID, `zz-unlisted-${RUN}`, at(13)),
    answeredRow(HIDDEN_ID, HIDDEN_QUESTION, at(14)),
    answeredRow(ORPHAN_ID, `zz-orphan-${RUN}`, at(15)),
    // Two answered rows under ONE key: the older one is listed, the newer one
    // is not. Neither may appear.
    answeredRow(SUPERSEDED_OLD_ID, SUPERSEDED_QUESTION, at(16)),
    answeredRow(SUPERSEDED_NEW_ID, SUPERSEDED_QUESTION, at(17)),
    // The ordering trio. The most recent one carries no votes at all.
    answeredRow(MARGIN_TWO_ID, `zz-margin-two-${RUN}`, at(20)),
    answeredRow(MARGIN_ONE_ID, `zz-margin-one-${RUN}`, at(21)),
    answeredRow(RECENT_ID, `zz-recent-${RUN}`, at(22)),
    ...WINDOW_IDS.map((id, index) =>
      answeredRow(id, `zz-window-${RUN}-${index}`, at(30 + index), OTHER_FROM, OTHER_TO),
    ),
  ]);

  await db.insert(explanationAuthorship).values([
    { explanationId: NAMED_ID, userId: namedAuthorId, listed: true, showName: true },
    { explanationId: NO_PROFILE_ID, userId: bareAuthorId, listed: true, showName: true },
    { explanationId: NAME_OFF_ID, userId: namedAuthorId, listed: true, showName: false },
    { explanationId: UNLISTED_ID, userId: namedAuthorId, listed: false },
    { explanationId: HIDDEN_ID, userId: namedAuthorId, listed: true },
    // ORPHAN_ID deliberately gets none.
    { explanationId: SUPERSEDED_OLD_ID, userId: namedAuthorId, listed: true },
    { explanationId: SUPERSEDED_NEW_ID, userId: namedAuthorId, listed: false },
    { explanationId: MARGIN_TWO_ID, userId: bareAuthorId, listed: true },
    { explanationId: MARGIN_ONE_ID, userId: bareAuthorId, listed: true },
    { explanationId: RECENT_ID, userId: bareAuthorId, listed: true },
    ...WINDOW_IDS.map((id) => ({ explanationId: id, userId: bareAuthorId, listed: true })),
  ]);

  await db.insert(explanationVotes).values([
    { explanationId: MARGIN_ONE_ID, accountId: voterOneId, value: 1 },
    { explanationId: MARGIN_TWO_ID, accountId: voterOneId, value: 1 },
    { explanationId: MARGIN_TWO_ID, accountId: voterTwoId, value: 1 },
  ]);

  await db.insert(explanationModeration).values({
    fromLanguageCode: FROM,
    toLanguageCode: TO,
    questionNormalized: HIDDEN_QUESTION,
    hiddenByUserId: namedAuthorId,
    reason: 'a fixture hide',
  });
});

after(async () => {
  if (DB_HOST) {
    const everyId = [
      NAMED_ID,
      NO_PROFILE_ID,
      NAME_OFF_ID,
      UNLISTED_ID,
      HIDDEN_ID,
      ORPHAN_ID,
      SUPERSEDED_OLD_ID,
      SUPERSEDED_NEW_ID,
      RECENT_ID,
      MARGIN_ONE_ID,
      MARGIN_TWO_ID,
      ...WINDOW_IDS,
    ];
    // The moderation row has no foreign key onto anything, so it is deleted by
    // its own key. Everything else cascades off the ledger rows or the users.
    await db
      .delete(explanationModeration)
      .where(
        and(
          eq(explanationModeration.fromLanguageCode, FROM),
          eq(explanationModeration.toLanguageCode, TO),
          eq(explanationModeration.questionNormalized, HIDDEN_QUESTION),
        ),
      );
    await db.delete(explanations).where(inArray(explanations.id, everyId));
    const everyUserId = [namedAuthorId, bareAuthorId, voterOneId, voterTwoId].filter((id) => id !== 0);
    if (everyUserId.length > 0) await db.delete(users).where(inArray(users.id, everyUserId));
  }

  await poolInitialized;
  await closePool();
});

describe('the public listing: what it refuses to show', () => {
  it(
    'leaves out an un-listed row, a hidden question and a row with no authorship claim',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const ids = await listedIds(FROM, TO);

      assert.ok(ids.includes(NAMED_ID), 'the listed control row is missing, so this case proves nothing');
      assert.equal(
        ids.includes(UNLISTED_ID),
        false,
        "an un-listed row is on the public list. The asker's own switch is the whole of their control over this.",
      );
      assert.equal(
        ids.includes(HIDDEN_ID),
        false,
        'a question an operator hid is on the public list, so the moderation row is not being read at all',
      );
      assert.equal(
        ids.includes(ORPHAN_ID),
        false,
        'a row with no authorship claim is on the public list. Absence of a claim means NOT listed: reading it ' +
          'as public republishes a question whose author just deleted their account or withdrew it.',
      );
    },
  );

  it(
    'never surfaces an older listed row behind a newer un-listed one for the same question',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const ids = await listedIds(FROM, TO);

      assert.equal(
        ids.includes(SUPERSEDED_NEW_ID),
        false,
        'the newest answered row for this question is un-listed and it is on the list anyway',
      );
      assert.equal(
        ids.includes(SUPERSEDED_OLD_ID),
        false,
        'un-listing the newest answer published the previous one instead of hiding the question. The visibility ' +
          'test is running BEFORE the latest-row pick rather than after it.',
      );
    },
  );
});

describe('the public listing: the byline', () => {
  it(
    'still lists a row whose author has no profile row, with no byline',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const page = await listPublicExplanations(db, { from: 'tr', to: 'es', limit: 200, offset: 0 });
      const row = page.rows.find((candidate) => candidate.id === NO_PROFILE_ID);

      assert.ok(
        row !== undefined,
        'a listed explanation vanished because its author never opened /settings. The profile join has to be a ' +
          'LEFT join: a reader with no profile row still authored a public answer.',
      );
      assert.equal(row.bylineName, null);
    },
  );

  it(
    'writes a name only when the author turned it on AND still holds one',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const page = await listPublicExplanations(db, { from: 'tr', to: 'es', limit: 200, offset: 0 });
      const named = page.rows.find((candidate) => candidate.id === NAMED_ID);
      const nameOff = page.rows.find((candidate) => candidate.id === NAME_OFF_ID);

      assert.ok(named !== undefined && nameOff !== undefined);
      assert.equal(named.bylineName, PUBLIC_NAME);
      assert.equal(
        nameOff.bylineName,
        null,
        'a name was written beside a row whose author left the byline switch off, so the per-item choice means ' +
          'nothing',
      );
    },
  );

  it(
    'agrees with resolvePublicByline on every row it returns',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const page = await listPublicExplanations(db, { from: 'tr', to: 'es', limit: 200, offset: 0 });
      const mine = page.rows.filter((row) => row.question.includes(RUN));
      assert.ok(mine.length >= 3, `only ${mine.length} seeded rows came back, so this comparison is nearly empty`);

      for (const row of mine) {
        const resolved = await resolvePublicByline(db, row.id);
        assert.equal(
          row.bylineName,
          resolved?.name ?? null,
          `the list and resolvePublicByline disagree about ${row.id}. Two readings of who may be named is one ` +
            'reading too many: the detail page uses the resolver and the list uses its own join.',
        );
      }
    },
  );
});

describe('the public listing: order and window', () => {
  it(
    'lets two agreeing readers outrank recency and one reader not',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const ids = await listedIds(FROM, TO);
      const expected: string[] = [MARGIN_TWO_ID, RECENT_ID, MARGIN_ONE_ID];
      const trio = ids.filter((id) => expected.includes(id));

      assert.deepEqual(
        trio,
        expected,
        'the margin-of-two rule is not the sort. A net score of two must lead, and a net score of one must count ' +
          'as nothing and fall back to recency, or one drive-by vote reorders a list everybody reads.',
      );
    },
  );

  it('filters by the language pair', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const ours = await listedIds(FROM, TO);
    const theirs = await listedIds(OTHER_FROM, OTHER_TO);

    assert.ok(ours.includes(NAMED_ID));
    assert.equal(ours.includes(WINDOW_IDS[0] ?? ''), false, 'the from/to filter let another pair through');
    assert.ok(theirs.includes(WINDOW_IDS[0] ?? ''));
    assert.equal(theirs.includes(NAMED_ID), false, 'the reversed pair returned rows from the forward one');
  });

  it('pages with limit and offset over one stable total', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const first = await listPublicExplanations(db, { from: 'es', to: 'tr', limit: 2, offset: 0 });
    const second = await listPublicExplanations(db, { from: 'es', to: 'tr', limit: 2, offset: 2 });

    assert.equal(first.rows.length, 2);
    assert.equal(second.rows.length, 2);
    assert.equal(first.total, second.total, 'the count moved between two windows of one filter');
    assert.ok(first.total >= WINDOW_IDS.length);
    const overlap = first.rows.filter((row) => second.rows.some((other) => other.id === row.id));
    assert.deepEqual(overlap, [], 'the offset did not move the window, so "show more" would repeat rows');
  });

  it(
    'grows the window rather than turning a page, and says so in the URL',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const page = await loadListPage('?from=es&to=tr&page=1');
      const wider = await loadListPage('?from=es&to=tr&page=2');

      assert.equal(page.rows.length, PUBLIC_EXPLANATIONS_PAGE_SIZE);
      assert.equal(page.nextPage, 2, 'more rows exist than one page holds and the list offered no way to reach them');
      assert.ok(
        wider.rows.length > page.rows.length,
        `"show more" returned ${wider.rows.length} rows where the first window held ${page.rows.length}. The ` +
          'second press has to WIDEN the window, not turn to a second page, or the URL stops describing what is ' +
          'on screen.',
      );
      assert.ok(
        wider.rows.some((row) => row.id === page.rows[0]?.id),
        'the wider window dropped the first row instead of keeping it',
      );
    },
  );
});
