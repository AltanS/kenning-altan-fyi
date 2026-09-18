/**
 * The two public browse pages answer a request carrying no session cookie
 * (M200 spec 03).
 *
 * WHY THIS IS CHECKED THE WAY THE LEGAL PAGES ARE CHECKED
 *   Reachability is the whole point of this section. "Anyone, signed in or not,
 *   can browse explanations" is the milestone's own success criterion, and one
 *   wrong line of nesting in `app/routes.ts` puts these two files behind the
 *   account gate with nothing else going wrong: they would still render, still
 *   pass their own tests, and still be unreachable for the readers they exist
 *   for. So the check is structural first and behavioural second.
 *
 * FOUR LINKS, AND THE LAST ONE IS THE HONESTY CHECK
 *   Link one: each file sits under `routes/_public.tsx` and under no other
 *   layout, asserted by walking the real config rather than by reading it.
 *   Link two: nothing in that chain above the pages themselves could refuse an
 *   anonymous caller, and neither page exports a `middleware`.
 *   Link three: the legal pages get away with "exports no loader at all". These
 *   two have real loaders, so the equivalent has to be run rather than
 *   inspected: both loaders are driven with a cookie-less request and must
 *   answer, the detail one over a row seeded for the purpose.
 *   Link four: the three above would also pass on an instance whose account
 *   gate did nothing, so the gate is run against an anonymous request and must
 *   refuse it.
 *
 * ISOLATION. One user, one ledger row and one authorship row, all created here
 * under ids that exist nowhere else and all deleted in `after()`. Nothing else
 * is read, written or reused.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { RouterContextProvider, type MiddlewareFunction } from 'react-router';

import type { RouteConfigEntry } from '@react-router/dev/routes';

import routes from '../../app/routes';
import { closePool, getRawDb, poolInitialized } from '../../drizzle/db';
import { explanationAuthorship, explanations, users } from '../../drizzle/schema';
import { authMiddleware } from '../../app/middleware/auth';
import { SIGN_IN_PATH } from '../../app/lib/auth/paths';
import * as publicLayoutModule from '../../app/routes/_public';
import * as browseListModule from '../../app/routes/browse.explanations';
import * as browseDetailModule from '../../app/routes/browse.explanations.$id';

const DB_HOST = process.env.DB_HOST;

const db = getRawDb();

/** The layout the two pages are expected to sit under, and nothing else. */
const PUBLIC_LAYOUT_FILE = 'routes/_public.tsx';

const BROWSE_ROUTE_FILES = ['routes/browse.explanations.tsx', 'routes/browse.explanations.$id.tsx'];

/** The chain a request walks through, named the way `app/routes.ts` names it. */
const CHAIN_MODULES = [
  { file: PUBLIC_LAYOUT_FILE, module: publicLayoutModule },
  { file: 'routes/browse.explanations.tsx', module: browseListModule },
  { file: 'routes/browse.explanations.$id.tsx', module: browseDetailModule },
];

/** The one visible row this file seeds, so the detail loader has something to answer with. */
const LISTED_ID = randomUUID();
const QUESTION = `zz-public-surface-${randomUUID().slice(0, 8)}`;
const FROM = 'tr';
const TO = 'es';

let readerId = 0;

/**
 * The chain of layout files a route file sits inside, outermost first.
 *
 * It walks the REAL config that `app/routes.ts` exports, so there is no second
 * description of the routing tree here to fall out of step with the first.
 */
function ancestorsOf(entries: readonly RouteConfigEntry[], file: string): string[] | null {
  for (const entry of entries) {
    if (entry.file === file) return [];
    const inner = ancestorsOf(entry.children ?? [], file);
    if (inner !== null) return [entry.file, ...inner];
  }
  return null;
}

/** How a loader answered a caller with no cookie. A refusal is reported rather than thrown, so a failure names it. */
function describeRefusal(cause: unknown): string {
  if (cause instanceof Response) return `refused with ${cause.status}`;
  return `threw ${String(cause)}`;
}

/** The list loader, driven with no cookie. */
async function runListLoaderAnonymously(): Promise<string> {
  const request = new Request('https://kenning.altan.fyi/browse/explanations');
  try {
    const answer = await browseListModule.loader({
      request,
      url: new URL(request.url),
      params: {},
      pattern: '/browse/explanations',
      context: new RouterContextProvider(),
    });
    return answer.rows.length >= 0 ? 'answered' : 'empty answer';
  } catch (cause) {
    return describeRefusal(cause);
  }
}

/** The detail loader, driven with no cookie, over one row this file seeded. */
async function runDetailLoaderAnonymously(id: string): Promise<string> {
  const request = new Request(`https://kenning.altan.fyi/browse/explanations/${id}`);
  try {
    const answer = await browseDetailModule.loader({
      request,
      url: new URL(request.url),
      params: { id },
      pattern: '/browse/explanations/:id',
      context: new RouterContextProvider(),
    });
    return answer.explanation.id === id ? 'answered' : 'answered about another row';
  } catch (cause) {
    return describeRefusal(cause);
  }
}

/**
 * Runs the account gate over one cookie-less request, and reports what it did.
 *
 * Reaching `next` means the caller was admitted, which is the only positive
 * answer this function can observe: an admitted middleware returns nothing.
 */
async function runGateAnonymously(): Promise<'admitted' | Response> {
  const request = new Request('https://kenning.altan.fyi/history');
  const middleware: MiddlewareFunction = authMiddleware;
  try {
    await middleware(
      {
        request,
        url: new URL(request.url),
        params: {},
        pattern: '/history',
        context: new RouterContextProvider(),
      },
      async () => new Response(null),
    );
    return 'admitted';
  } catch (cause) {
    // A `redirect()` is a `Response`, and that is the only refusal this gate
    // has. Anything else is a real fault.
    if (cause instanceof Response) return cause;
    throw cause;
  }
}

before(async () => {
  if (!DB_HOST) return;
  await poolInitialized;

  const [reader] = await db
    .insert(users)
    .values({
      email: `zz-browse-surface-${randomUUID()}@example.invalid`,
      passwordHash: '$2b$10$abcdefghijklmnopqrstuvwxyz012345678901234567890123456789',
      emailVerifiedAt: new Date(),
    })
    .returning({ id: users.id });
  if (!reader) throw new Error('failed to seed the fixture reader');
  readerId = reader.id;

  await db.insert(explanations).values({
    id: LISTED_ID,
    fromLanguageCode: FROM,
    toLanguageCode: TO,
    question: QUESTION,
    questionNormalized: QUESTION,
    status: 'ok',
    answer: { answer: 'a fixture answer', terms: [], contrasts: [], pitfalls: [], related: [], references: [] },
    provider: 'test-fixture',
    model: 'test-model',
    promptVersion: 1,
  });
  await db.insert(explanationAuthorship).values({ explanationId: LISTED_ID, userId: readerId, listed: true });
});

after(async () => {
  if (DB_HOST) {
    // The authorship row cascades off the ledger row, so the ledger row is the
    // only delete needed for it.
    await db.delete(explanations).where(eq(explanations.id, LISTED_ID));
    if (readerId !== 0) await db.delete(users).where(eq(users.id, readerId));
  }

  await poolInitialized;
  await closePool();
});

describe('the public browse pages stay public', () => {
  it('keeps both under the public layout only', { skip: !DB_HOST ? 'DB_HOST not set' : false }, () => {
    for (const file of BROWSE_ROUTE_FILES) {
      const ancestors = ancestorsOf(routes, file);

      assert.ok(ancestors !== null, `${file} is not registered in app/routes.ts at all, so nothing serves it.`);
      assert.deepEqual(
        ancestors,
        [PUBLIC_LAYOUT_FILE],
        `${file} sits under ${ancestors?.join(' > ')} rather than under ${PUBLIC_LAYOUT_FILE} alone. Any layout ` +
          'in front of a public browse page can redirect, and a public section a stranger cannot open is not a ' +
          'public section.',
      );
    }
  });

  it('carries no middleware anywhere in that chain', { skip: !DB_HOST ? 'DB_HOST not set' : false }, () => {
    for (const { file, module } of CHAIN_MODULES) {
      assert.equal(
        'middleware' in module,
        false,
        `${file} now exports a middleware. These pages have no gate by design, so this is the moment to prove ` +
          'the new code still serves a request with no cookie: assert that here, then relax this case. Do not ' +
          'relax it first.',
      );
    }
  });

  it(
    'answers the list for a request carrying no session cookie',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const outcome = await runListLoaderAnonymously();

      assert.equal(
        outcome,
        'answered',
        `the list loader answered "${outcome}" for an anonymous caller. The legal pages get away with exporting ` +
          'no loader at all; these pages have one, so the equivalent claim has to be run rather than inspected.',
      );
    },
  );

  it(
    'answers one detail page for a request carrying no session cookie',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const outcome = await runDetailLoaderAnonymously(LISTED_ID);

      assert.equal(
        outcome,
        'answered',
        `the detail loader answered "${outcome}" for an anonymous caller over a listed, answered row. A public ` +
          'answer nobody without an account can open is not a public answer.',
      );
    },
  );

  it('is checked against a gate that is actually live', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    // WITHOUT THIS CASE THE FOUR ABOVE PROVE NOTHING. All four would pass on an
    // instance where the account gate had been deleted, which is a state this
    // milestone must not be confused with.
    const outcome = await runGateAnonymously();

    assert.ok(
      outcome instanceof Response,
      'the account gate admitted a request carrying no session, so it is not gating anything',
    );
    assert.equal(outcome.status, 302);
    assert.equal(new URL(outcome.headers.get('location') ?? '', 'https://kenning.altan.fyi').pathname, SIGN_IN_PATH);
  });
});
