/**
 * A signed-out visitor at `/` is sent to the front door, and the worked example
 * is still real for the reader who is signed in (M184 spec 03, amended by
 * M199).
 *
 * WHAT THIS CASE USED TO SAY, AND WHY IT SAYS SOMETHING ELSE NOW
 *   Until M199 it held a door open: `/` had to answer a signed-out stranger
 *   with the landing pitch and a real worked example. That contract is gone.
 *   A stranger inside the app shell met a sidebar offering lists, favourites
 *   and history, a language bar, an input card and a mode switch, and could
 *   use none of them. The screen they are owed is `/welcome`, one card in the
 *   `_public` layout, so the landing branch of this loader is now a hop to it.
 *
 * IT IS STILL TWO CASES, AND THE SECOND ONE IS THE POINT.
 *   A redirect assertion on its own would pass just as happily on a loader
 *   that had lost the worked example, lost the dictionary, or thrown for
 *   everybody. So the second case runs the SAME URL with a real session and
 *   asserts the example is there: the right word, a gloss, and at least one
 *   translation. The redirect above is evidence of a front door only because
 *   the screen behind it is alive.
 *
 * NO ROW IS CREATED, READ DESTRUCTIVELY, OR DELETED, beyond the fixture
 * account, which `dispose()` takes away by id. `Haus` is the fixed landing
 * example and it is part of the seeded dictionary; if it is missing, that is a
 * broken import and this case is right to be red about it.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else: no API key
 * and no server on :3456. `tests/unit/integration-tests-self-skip.test.ts`
 * counts the guard against the case one for one.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RouterContextProvider } from 'react-router';

import { closePool, poolInitialized } from '../../drizzle/db';
import { WELCOME_PATH } from '../../app/lib/auth/paths';
import { LANDING_EXAMPLE } from '../../app/lib/dictionary/landing-example';
import { loader as translateLoader } from '../../app/routes/translate';
import { createTestUserSession, type TestUserSession } from '../fixtures/user-session';

const DB_HOST = process.env.DB_HOST;

let session: TestUserSession | null = null;

/**
 * The index route, with no query: a first-time stranger, or a returning reader.
 *
 * The extra members of the loader's argument are the ones the router supplies
 * and this route reads none of. They are passed so the call is the shape the
 * framework makes rather than a narrower one invented here.
 */
async function loadLanding(cookie: string | null) {
  const request = new Request('https://kenning.altan.fyi/', {
    headers: cookie === null ? {} : { cookie },
  });
  return translateLoader({
    request,
    url: new URL(request.url),
    params: {},
    pattern: '/',
    context: new RouterContextProvider(),
  });
}

before(async () => {
  if (!DB_HOST) return;
  session = await createTestUserSession('landing-page');
});

after(async () => {
  if (session !== null) await session.dispose();
  // THE POOL FINISHES OPENING BEFORE IT IS CLOSED. `drizzle/db.ts` kicks off
  // `ensureHostIndexes` behind `poolInitialized` at import time, and a short
  // test file can reach `closePool()` first, which turns a passing run into
  // "Cannot use a pool after calling end on the pool" reported as a failure.
  await poolInitialized;
  await closePool();
});

describe('the index page for a visitor with nothing typed', () => {
  it('sends a signed-out stranger to the front door', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const thrown = await loadLanding(null).then(
      () => null,
      (cause: unknown) => cause,
    );

    assert.ok(
      thrown instanceof Response,
      'GET / answered a signed-out visitor with data. That is the whole app shell around a screen on which ' +
        'every control refuses them: the sidebar, the language bar, the input card and the mode switch.',
    );
    assert.equal(thrown.status, 302);
    assert.equal(
      new URL(thrown.headers.get('location') ?? '', 'https://kenning.altan.fyi').pathname,
      WELCOME_PATH,
      'A stranger with nothing typed was sent somewhere other than the front door. `/sign-in` is the ' +
        'destination for a typed search, which a reader can come back to; an empty visit has nothing to come ' +
        'back to and belongs on the screen that says what this product is.',
    );
  });

  it(
    'answers a signed-in reader with a real worked example',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      assert.ok(session !== null, 'the fixture account was not created, so this case would prove nothing');

      const data = await loadLanding(session.cookie);

      // The landing branch, identified by what it returns rather than by what
      // it was asked: no query, no hits, no phrase, and no enrichment panel,
      // which together are the only shape that costs no provider call.
      assert.equal(data.q, '', 'a request with no query did not take the landing branch');
      assert.equal(data.panel, null, 'the empty index carried an enrichment panel, which would be spend');
      assert.deepEqual(data.hits, []);

      const example = data.example;
      assert.ok(
        example !== null,
        `The index has no worked example. The fixed example word is '${LANDING_EXAMPLE.word}' and the ` +
          'dictionary answered nothing for it, so either the import is broken or the landing query is. The ' +
          'page renders its copy without the card in that state, which is exactly the empty shell this case ' +
          'exists to catch. It is also what makes the redirect asserted above evidence of a front door rather ' +
          'than of a screen that has stopped working for everybody.',
      );

      assert.equal(example.word, LANDING_EXAMPLE.word);
      assert.equal(example.hit.lemma, LANDING_EXAMPLE.word, 'the example card is for a different word');
      assert.ok((example.hit.gloss ?? '').length > 0, 'the example card carries no gloss, so it explains nothing');
      assert.ok(
        example.hit.translations.length > 0,
        'the example card carries no translation, so it demonstrates nothing a translator wants',
      );
    },
  );
});
