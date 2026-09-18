/**
 * Reporting an answer, and taking a question off the public pages
 * (M200 spec 03).
 *
 * WHAT THIS FILE HOLDS IN PLACE
 *   1. REPORTING NEEDS AN ACCOUNT, and a refused report writes NOTHING. An
 *      anonymous report channel is a channel for mass-flagging an answer
 *      somebody dislikes at no cost, and a refusal that still wrote a row would
 *      be that channel with extra steps.
 *   2. A REPEAT REPORT REPLACES, it does not stack. The unique index on
 *      (explanation, reader) is the whole rule, so the operator's count counts
 *      people rather than clicks.
 *   3. A REPORT ON SOMETHING NOBODY CAN OPEN WRITES NOTHING. The visibility read
 *      runs last before the write, so a hidden or un-listed row cannot fill the
 *      queue with complaints about pages that are already gone.
 *   4. A HIDE IS KEYED ON THE QUESTION, AND THAT IS ONLY OBSERVABLE OVER TIME.
 *      The ledger is append only, so a newer answered row can open under a key
 *      that is already hidden. If the hide were per row, that new row would
 *      republish the question with nobody deciding it. The case below writes
 *      exactly that row and looks again.
 *   5. THE OPERATOR SCREEN IS GATED, and the gate is run rather than read: the
 *      superadmin middleware is put to an ordinary account and must refuse it.
 *      Without that, the structural assertion beside it would pass on an
 *      instance whose gate did nothing.
 *
 * ISOLATION. Three accounts, four ledger rows with their authorship rows, the
 * reports they collect and the moderation rows written here, all deleted in
 * `after()`. The moderation table has no foreign key, so its rows are deleted by
 * key.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { RouterContextProvider, type MiddlewareFunction } from 'react-router';

import type { RouteConfigEntry } from '@react-router/dev/routes';

import type { LanguageCode } from '../../app/lib/dictionary/detect-language';

import routes from '../../app/routes';
import { closePool, getRawDb, poolInitialized } from '../../drizzle/db';
import {
  explanationAuthorship,
  explanationModeration,
  explanationReports,
  explanations,
  users,
} from '../../drizzle/schema';
import { action as browseDetailAction } from '../../app/routes/browse.explanations.$id';
import { action as operatorAction, loader as operatorLoader } from '../../app/routes/super/explanations';
import { superadminMiddleware } from '../../app/middleware/auth';
import { userContext, type AuthenticatedUser } from '../../app/middleware/context';
import { listPublicExplanations } from '../../app/models/explanation-browse.server';
import { countExplanationReports } from '../../app/models/explanation-reports.server';
import { commitUserSession } from '../../app/services/session.server';

const DB_HOST = process.env.DB_HOST;

const db = getRawDb();

const FROM = 'tr';
const TO = 'es';

/** A second answer language for the same words. It makes a second cache key out of one question. */
const SECOND_TO = 'en';

/** Every question this file writes carries this, so a stray row is traceable to it. */
const RUN = randomUUID().slice(0, 8);

const REPORTED_ID = randomUUID();
const UNLISTED_ID = randomUUID();
const HIDEABLE_ID = randomUUID();
/** A SECOND answered row opened under the hidden question's key, after the hide. */
const HIDEABLE_RETRY_ID = randomUUID();

/** One question answered under TWO pairs. The hide names one key, so only one of them may come down. */
const PAIR_SPLIT_HIDDEN_ID = randomUUID();
const PAIR_SPLIT_VISIBLE_ID = randomUUID();

/** A row hidden with the reason box left empty, which the column must record as nothing at all. */
const EMPTY_REASON_ID = randomUUID();

const HIDEABLE_QUESTION = `zz-hideable-${RUN}`;
const PAIR_SPLIT_QUESTION = `zz-pair-split-${RUN}`;
const EMPTY_REASON_QUESTION = `zz-empty-reason-${RUN}`;

/** Every question this file hides. The moderation table has no foreign key, so `after()` deletes by these. */
const HIDDEN_QUESTIONS = [HIDEABLE_QUESTION, PAIR_SPLIT_QUESTION, EMPTY_REASON_QUESTION];

/** Every ledger row this file writes, including the one a test opens later. */
const EVERY_ID = [
  REPORTED_ID,
  UNLISTED_ID,
  HIDEABLE_ID,
  HIDEABLE_RETRY_ID,
  PAIR_SPLIT_HIDDEN_ID,
  PAIR_SPLIT_VISIBLE_ID,
  EMPTY_REASON_ID,
];

let authorId = 0;
let reporterId = 0;
let operator: AuthenticatedUser = { id: 0, email: '', isSuperadmin: true };
let ordinaryReader: AuthenticatedUser = { id: 0, email: '', isSuperadmin: false };
let reporterCookie = '';

function at(minutes: number): Date {
  return new Date(Date.UTC(2031, 2, 1, 0, minutes, 0));
}

async function seedUser(label: string, isSuperadmin: boolean): Promise<AuthenticatedUser> {
  const email = `zz-report-${label}-${randomUUID()}@example.invalid`;
  const [row] = await db
    .insert(users)
    .values({
      email,
      passwordHash: '$2b$10$abcdefghijklmnopqrstuvwxyz012345678901234567890123456789',
      emailVerifiedAt: new Date(),
      isSuperadmin,
    })
    .returning({ id: users.id });
  if (!row) throw new Error(`failed to seed the ${label} fixture account`);
  return { id: row.id, email, isSuperadmin };
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

/** One answered row under an explicit pair, for the case that needs the same question under two of them. */
function answeredRowForPair(params: { id: string; question: string; to: string; createdAt: Date }) {
  return { ...answeredRow(params.id, params.question, params.createdAt), toLanguageCode: params.to };
}

/** The chain of layout files a route file sits inside, outermost first. */
function ancestorsOf(entries: readonly RouteConfigEntry[], file: string): string[] | null {
  for (const entry of entries) {
    if (entry.file === file) return [];
    const inner = ancestorsOf(entry.children ?? [], file);
    if (inner !== null) return [entry.file, ...inner];
  }
  return null;
}

/** One report, posted the way the disclosure at the foot of the page posts it. */
async function postReport(params: { id: string; reason: string | null; cookie: string | null }) {
  const body = new FormData();
  if (params.reason !== null) body.set('reason', params.reason);

  const headers = new Headers();
  if (params.cookie !== null) headers.set('cookie', params.cookie);

  const request = new Request(`https://kenning.altan.fyi/browse/explanations/${params.id}`, {
    method: 'POST',
    headers,
    body,
  });

  return browseDetailAction({
    request,
    url: new URL(request.url),
    params: { id: params.id },
    pattern: '/browse/explanations/:id',
    context: new RouterContextProvider(),
  });
}

/** One operator submission, with the account the layout would have put in context. */
async function submitModeration(params: {
  explanationId: string;
  intent: string;
  caller: AuthenticatedUser;
  reason?: string;
}) {
  const body = new FormData();
  body.set('intent', params.intent);
  body.set('explanationId', params.explanationId);
  // A text input always submits, empty or not, so the empty case sends one too.
  if (params.reason !== undefined) body.set('reason', params.reason);

  const context = new RouterContextProvider();
  context.set(userContext, params.caller);

  const request = new Request('https://kenning.altan.fyi/super/explanations', { method: 'POST', body });
  return operatorAction({
    request,
    url: new URL(request.url),
    params: {},
    pattern: '/super/explanations',
    context,
  });
}

/** The superadmin gate, run over one account. */
async function runSuperGate(caller: AuthenticatedUser | null): Promise<'admitted' | Response> {
  const request = new Request('https://kenning.altan.fyi/super/explanations');
  const context = new RouterContextProvider();
  context.set(userContext, caller);
  const middleware: MiddlewareFunction = superadminMiddleware;

  try {
    await middleware(
      { request, url: new URL(request.url), params: {}, pattern: '/super/explanations', context },
      async () => new Response(null),
    );
    return 'admitted';
  } catch (cause) {
    if (cause instanceof Response) return cause;
    throw cause;
  }
}

/**
 * Whether one row is on the public list right now.
 *
 * THE PAIR IS NAMED RATHER THAN ASSUMED, because one of the cases below asks the
 * same question of two different pairs and the answers have to differ.
 */
async function isPubliclyListed(params: { id: string; from: LanguageCode; to: LanguageCode }): Promise<boolean> {
  const page = await listPublicExplanations(db, { from: params.from, to: params.to, limit: 200, offset: 0 });
  return page.rows.some((row) => row.id === params.id);
}

before(async () => {
  if (!DB_HOST) return;
  await poolInitialized;

  const author = await seedUser('author', false);
  const reporter = await seedUser('reporter', false);
  operator = await seedUser('operator', true);
  ordinaryReader = reporter;
  authorId = author.id;
  reporterId = reporter.id;

  const setCookie = await commitUserSession({
    request: new Request('https://kenning.altan.fyi/'),
    userId: reporterId,
  });
  reporterCookie = setCookie.split(';')[0] ?? '';

  await db
    .insert(explanations)
    .values([
      answeredRow(REPORTED_ID, `zz-reported-${RUN}`, at(10)),
      answeredRow(UNLISTED_ID, `zz-report-unlisted-${RUN}`, at(11)),
      answeredRow(HIDEABLE_ID, HIDEABLE_QUESTION, at(12)),
      answeredRow(EMPTY_REASON_ID, EMPTY_REASON_QUESTION, at(13)),
      // The same words, answered in two languages. Two cache keys, one question.
      answeredRow(PAIR_SPLIT_HIDDEN_ID, PAIR_SPLIT_QUESTION, at(14)),
      answeredRowForPair({ id: PAIR_SPLIT_VISIBLE_ID, question: PAIR_SPLIT_QUESTION, to: SECOND_TO, createdAt: at(15) }),
    ]);

  await db.insert(explanationAuthorship).values([
    { explanationId: REPORTED_ID, userId: authorId, listed: true },
    { explanationId: UNLISTED_ID, userId: authorId, listed: false },
    { explanationId: HIDEABLE_ID, userId: authorId, listed: true },
    { explanationId: EMPTY_REASON_ID, userId: authorId, listed: true },
    { explanationId: PAIR_SPLIT_HIDDEN_ID, userId: authorId, listed: true },
    { explanationId: PAIR_SPLIT_VISIBLE_ID, userId: authorId, listed: true },
  ]);
});

after(async () => {
  if (DB_HOST) {
    // Every question this file writes carries its own run tag, so deleting by
    // question covers every pair it was hidden under.
    await db
      .delete(explanationModeration)
      .where(inArray(explanationModeration.questionNormalized, HIDDEN_QUESTIONS));
    await db.delete(explanations).where(inArray(explanations.id, EVERY_ID));
    const everyUserId = [authorId, reporterId, operator.id].filter((id) => id !== 0);
    if (everyUserId.length > 0) await db.delete(users).where(inArray(users.id, everyUserId));
  }

  await poolInitialized;
  await closePool();
});

describe('reporting one public answer', () => {
  it(
    'records a signed-in report, and a repeat replaces it rather than stacking',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const first = await postReport({ id: REPORTED_ID, reason: 'the first reason', cookie: reporterCookie });
      assert.deepEqual(first, { success: true });
      assert.equal(await countExplanationReports(db, REPORTED_ID), 1);

      const second = await postReport({ id: REPORTED_ID, reason: 'the second reason', cookie: reporterCookie });
      assert.deepEqual(second, { success: true });

      assert.equal(
        await countExplanationReports(db, REPORTED_ID),
        1,
        'the second report added a row instead of replacing the first, so the queue counts clicks rather than ' +
          'people',
      );

      const [row] = await db
        .select({ reason: explanationReports.reason })
        .from(explanationReports)
        .where(eq(explanationReports.explanationId, REPORTED_ID));
      assert.equal(row?.reason, 'the second reason', 'the repeat did not replace the reason');
    },
  );

  it('stores an empty reason as nothing at all', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const answer = await postReport({ id: REPORTED_ID, reason: '   ', cookie: reporterCookie });
    assert.deepEqual(answer, { success: true });

    const [row] = await db
      .select({ reason: explanationReports.reason })
      .from(explanationReports)
      .where(eq(explanationReports.explanationId, REPORTED_ID));
    assert.equal(
      row?.reason,
      null,
      'a whitespace-only box was stored as a reason, so the operator reads an empty sentence as a statement',
    );
  });

  it('refuses an anonymous report and writes nothing', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const reportsBefore = await countExplanationReports(db, HIDEABLE_ID);

    const answer = await postReport({ id: HIDEABLE_ID, reason: 'anonymous', cookie: null });

    assert.deepEqual(
      answer,
      { success: false, error: 'unauthenticated' },
      'an anonymous report was accepted. An unauthenticated report channel is a channel for mass-flagging an ' +
        'answer somebody dislikes at no cost.',
    );
    assert.equal(await countExplanationReports(db, HIDEABLE_ID), reportsBefore, 'a refused report still wrote a row');
  });

  it(
    'refuses a report on a row nobody can open, and writes nothing',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const answer = await postReport({ id: UNLISTED_ID, reason: 'on a hidden row', cookie: reporterCookie });

      assert.deepEqual(
        answer,
        { success: false, error: 'not-found' },
        'an un-listed row accepted a report. The visibility read runs last before the write for exactly this ' +
          'reason.',
      );
      assert.equal(await countExplanationReports(db, UNLISTED_ID), 0);
    },
  );
});

describe('taking one question off the public pages', () => {
  it(
    'hides a question through the operator action and puts it back',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      assert.ok(await isPubliclyListed({ id: HIDEABLE_ID, from: FROM, to: TO }), 'the fixture row is not public to begin with');

      await submitModeration({ explanationId: HIDEABLE_ID, intent: 'hide', caller: operator });
      assert.equal(
        await isPubliclyListed({ id: HIDEABLE_ID, from: FROM, to: TO }),
        false,
        'the hide wrote a row and the listing kept showing the question anyway',
      );

      await submitModeration({ explanationId: HIDEABLE_ID, intent: 'unhide', caller: operator });
      assert.ok(
        await isPubliclyListed({ id: HIDEABLE_ID, from: FROM, to: TO }),
        'un-hiding left the question off the public pages, so no row means visible is not the rule the listing ' +
          'follows',
      );
    },
  );

  it(
    'keeps a hidden question hidden when a newer answered row opens under it',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      await submitModeration({ explanationId: HIDEABLE_ID, intent: 'hide', caller: operator });
      assert.equal(await isPubliclyListed({ id: HIDEABLE_ID, from: FROM, to: TO }), false);

      // A retry, a later prompt version or a repair: the ledger is append only,
      // so this is an ordinary thing to happen to a hidden question.
      await db.insert(explanations).values(answeredRow(HIDEABLE_RETRY_ID, HIDEABLE_QUESTION, at(40)));
      await db.insert(explanationAuthorship).values({
        explanationId: HIDEABLE_RETRY_ID,
        userId: authorId,
        listed: true,
      });

      assert.equal(
        await isPubliclyListed({ id: HIDEABLE_RETRY_ID, from: FROM, to: TO }),
        false,
        'a newer answered row republished a question an operator had hidden. The hide is keyed on the question ' +
          'precisely so a new row cannot walk around it.',
      );
    },
  );

  it(
    'leaves the same question listed under a second language pair',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      await submitModeration({ explanationId: PAIR_SPLIT_HIDDEN_ID, intent: 'hide', caller: operator });

      assert.equal(
        await isPubliclyListed({ id: PAIR_SPLIT_HIDDEN_ID, from: FROM, to: TO }),
        false,
        'the hide did not take at all, so the assertion below would prove nothing',
      );
      assert.ok(
        await isPubliclyListed({ id: PAIR_SPLIT_VISIBLE_ID, from: FROM, to: SECOND_TO }),
        'hiding one question took the SAME question down under a second language pair. A cache key is three ' +
          'columns, and the same words explained in another language are another answer the operator never read ' +
          'and never decided about.',
      );
    },
  );

  it(
    'records an empty hide reason as nothing at all',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      await submitModeration({ explanationId: EMPTY_REASON_ID, intent: 'hide', caller: operator, reason: '   ' });

      const [row] = await db
        .select({ reason: explanationModeration.reason })
        .from(explanationModeration)
        .where(
          and(
            eq(explanationModeration.fromLanguageCode, FROM),
            eq(explanationModeration.toLanguageCode, TO),
            eq(explanationModeration.questionNormalized, EMPTY_REASON_QUESTION),
          ),
        );

      assert.ok(row !== undefined, 'the hide wrote no moderation row, so the column below was never written');
      assert.equal(
        row.reason,
        null,
        'an empty reason box was stored as an empty sentence. The queue then cannot tell an operator who wrote ' +
          'nothing apart from one who wrote nothing down.',
      );
    },
  );

  it(
    'shows the hidden question and its report count on the operator queue',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const { entries } = await operatorLoader();
      const hidden = entries.find((entry) => entry.question === HIDEABLE_QUESTION);
      const reported = entries.find((entry) => entry.explanationId === REPORTED_ID);

      assert.ok(hidden !== undefined, 'a hidden question is missing from the queue that exists to un-hide it');
      assert.equal(hidden.hidden, true);
      assert.ok(reported !== undefined, 'a reported question is missing from the queue');
      assert.equal(reported.reportCount, 1);
      assert.deepEqual(
        Object.keys(reported).toSorted(),
        ['down', 'explanationId', 'from', 'hidden', 'lastReportReason', 'question', 'reportCount', 'to', 'up'],
        "the operator's queue grew a column. It must never carry a reporter, an author or a profile name: " +
          'triaging a complaint must not also say who complained or who asked.',
      );
    },
  );
});

describe('the operator screen is gated', () => {
  it('sits under the superadmin layout and nothing else', { skip: !DB_HOST ? 'DB_HOST not set' : false }, () => {
    const ancestors = ancestorsOf(routes, 'routes/super/explanations.tsx');

    assert.ok(ancestors !== null, 'routes/super/explanations.tsx is not registered in app/routes.ts at all');
    assert.deepEqual(
      ancestors,
      ['routes/_super.tsx'],
      `the moderation screen sits under ${ancestors?.join(' > ')}. Only \`_super\` carries the superadmin check.`,
    );
  });

  it('is checked against a gate that is actually live', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    assert.equal(
      await runSuperGate(operator),
      'admitted',
      'the superadmin gate refused a superadmin, so the case below would pass for the wrong reason',
    );

    const refusal = await runSuperGate(ordinaryReader);
    assert.ok(
      refusal instanceof Response,
      'an ordinary account reached the moderation screen. The hide control is the one place on this installation ' +
        'that can take a public page down.',
    );
    assert.equal(refusal.status, 404);

    const anonymous = await runSuperGate(null);
    assert.ok(anonymous instanceof Response);
    assert.equal(anonymous.status, 404);
  });
});
