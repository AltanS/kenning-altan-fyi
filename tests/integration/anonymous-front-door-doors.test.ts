/**
 * The front door a visitor with no account is shown, and what the index looks
 * like once they have one (M189, rewritten by M199).
 *
 * WHY THIS FILE EXISTS
 *   M184 made an account mandatory for every search and left the older rule in
 *   place that `/` must prompt nobody to sign up. The result passed every gate
 *   in the repo: the landing page answered 200, carried a real worked example,
 *   and gave a stranger no way in at all. A status assertion cannot see that,
 *   and neither can a typecheck, a lint or a build. So this file asserts the
 *   DOORS, in the rendered HTML, the way a reader meets them.
 *
 * THE DOORS MOVED IN M199, AND SO DID THIS FILE'S FIRST CASE. They used to sit
 * above the two-pane search surface on `/`, which meant a stranger was handed
 * the whole app shell, a sidebar offering lists, favourites and history, a
 * language bar, an input card and a mode switch, and could use none of it. The
 * front door is `/welcome` now, one card in the `_public` layout, and the
 * first case below renders that route. It asserts the two destinations and the
 * ABSENCE of the shell's controls, because the absence is the change: a test
 * that only asked "is the link in the HTML" passed throughout the defect this
 * milestone removes.
 *
 * ASSERTING THE `href` AND THE `<textarea` RATHER THAN THE LABELS IS
 * DELIBERATE. The copy is translated and will be rewritten, the destinations
 * and the box are the contract.
 *
 * THE SECOND CASE IS THE LIVENESS HALF. A first case that only checks what is
 * missing passes on a screen that renders nothing at all, and an index that
 * has lost its worked example would look exactly like a correct front door
 * from here. So the second case drives the real loader with a REAL session and
 * asserts the index still has the box, the example in its output pane, and
 * neither door.
 *
 * NO ROW IS CREATED, READ DESTRUCTIVELY, OR DELETED, beyond the fixture
 * account, which `dispose()` takes away by id.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE. `DB_HOST`, nothing else: the
 * signed-in case drives the real loader, which queries the dictionary for its
 * worked example.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { createInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { createRoutesStub, RouterContextProvider } from 'react-router';

import enCommon from '#app/locales/en/common.json';
import enWelcome from '#app/locales/en/welcome.json';
import { closePool, poolInitialized } from '../../drizzle/db';
import { APP_NAME } from '../../app/lib/app-name';
import TranslateRoute, { loader as translateLoader } from '../../app/routes/translate';
import WelcomeRoute from '../../app/routes/welcome';
import { createTestUserSession, type TestUserSession } from '../fixtures/user-session';

const DB_HOST = process.env.DB_HOST;

let session: TestUserSession | null = null;

/** The English catalogues in a bare i18next instance: no cookie detector, no singleton. */
function englishInstance() {
  const instance = createInstance();
  void instance.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { common: enCommon, welcome: enWelcome } },
    defaultNS: 'common',
    ns: ['common', 'welcome'],
    interpolation: { escapeValue: false },
  });
  return instance;
}

/**
 * One route component as a browser would receive it.
 *
 * THROUGH A ROUTER STUB, NOT A BARE `MemoryRouter`. The input pane reads
 * `useNavigation` to show its pending state, and that hook needs a DATA router:
 * a plain `MemoryRouter` throws. The stub carries no loader of its own, so the
 * render is synchronous and `renderToStaticMarkup` sees the finished tree.
 */
function render(path: string, element: () => ReturnType<typeof createElement>): string {
  const Stub = createRoutesStub([{ path, Component: element }]);
  return renderToStaticMarkup(
    createElement(I18nextProvider, { i18n: englishInstance() }, createElement(Stub, { initialEntries: [path] })),
  );
}

/** The home screen, for one loader answer. */
function renderIndex(loaderData: Awaited<ReturnType<typeof translateLoader>>): string {
  return render('/', () =>
    createElement(TranslateRoute, {
      loaderData,
      actionData: undefined,
      params: {},
      // SAFETY: the component destructures `loaderData` and reads nothing
      // else. `matches` is a tuple of the root and layout modules with
      // their own loader data, which this case would have to invent, and
      // inventing it would assert nothing about the order below.
      matches: [] as never,
    }),
  );
}

/**
 * The output pane's own markup, sliced out of the rendered document.
 *
 * The pane is the only `<section>` in this tree and it carries `aria-live`, so
 * the first one after that attribute closes it. Slicing rather than searching
 * the whole document is the point: it is what makes "the example is IN the
 * pane" a different claim from "the example is somewhere on the page".
 */
function outputPane(html: string): string {
  const start = html.indexOf('aria-live="polite"');
  assert.notEqual(start, -1, 'the rendered home page has no output pane at all, so no claim about it means anything');
  const end = html.indexOf('</section>', start);
  assert.notEqual(end, -1, 'the output pane never closed');
  return html.slice(start, end);
}

before(async () => {
  if (!DB_HOST) return;
  session = await createTestUserSession('front-door');
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

describe('the front door an anonymous visitor is shown', () => {
  it('is a card with two doors and none of the app shell', { skip: !DB_HOST ? 'DB_HOST not set' : false }, () => {
    const html = render('/welcome', () => createElement(WelcomeRoute));

    assert.ok(
      html.includes('href="/sign-up"'),
      'The front door offers a visitor no way to create an account. Every search needs one since M184, so ' +
        'this screen is then a wall: the reader is told what the product is and given no door.',
    );
    assert.ok(html.includes('href="/sign-in"'), 'The front door offers a returning reader no way to sign in.');

    // THE PRODUCT NAMES ITSELF. `APP_NAME` is the one definition of it, and a
    // copy in the translation catalogues would be a rename that reaches half
    // the app.
    assert.ok(html.includes(APP_NAME), 'The front door does not say what product it is the front door to.');
    assert.ok(html.includes(enWelcome.body), 'The front door does not say what this product does.');

    // THE ABSENCES ARE THE MILESTONE. Each of these was on screen for a
    // stranger before M199, and each one refused them when pressed.
    assert.doesNotMatch(
      html,
      /<textarea/,
      'The front door renders a search box. A visitor with no account cannot search, so the box is a control ' +
        'that refuses whoever presses it.',
    );
    assert.ok(
      !html.includes('href="/lists"') && !html.includes('href="/favourites"') && !html.includes('href="/history"'),
      'The front door renders the app shell navigation. Every one of those destinations redirects a visitor ' +
        'with no account straight back out, which is the defect this screen was written to remove.',
    );
    assert.ok(
      !html.includes('href="/explain"'),
      'The front door offers the explain mode, which is gated. It is a door onto a redirect.',
    );
  });

  it(
    'leaves the index to the reader who signed in, with its worked example and no doors',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      assert.ok(session !== null, 'the fixture account was not created, so this case would prove nothing');

      const request = new Request('https://kenning.altan.fyi/', { headers: { cookie: session.cookie } });
      const loaderData = await translateLoader({
        request,
        url: new URL(request.url),
        params: {},
        pattern: '/',
        context: new RouterContextProvider(),
      });

      // The landing branch, identified by what it returned rather than by what
      // it was asked. A redirect here would have thrown instead.
      assert.equal(loaderData.q, '', 'a request with no query did not take the landing branch');
      assert.equal(loaderData.signedIn, true, 'a request carrying a real session cookie was reported as signed out');

      const html = renderIndex(loaderData);

      assert.ok(
        !html.includes('href="/sign-up"'),
        'A reader who is signed in is still being invited to create an account.',
      );
      assert.ok(
        html.includes('<textarea'),
        'The signed-in home page lost the search box, which is the one thing it is for.',
      );
      assert.ok(
        outputPane(html).includes('href="/entry/'),
        'The signed-in home page lost the worked example from its output pane. It is a demonstration rather ' +
          'than a pitch, and it is all that is left on an empty screen once the doors and the pitch are gone.',
      );

      assert.ok(
        !html.includes(enCommon.landing.privacy),
        'A reader who is signed in is still being sold the privacy of a product they already hold.',
      );

      // AN h2, NOT AN h1, wherever the route renders a heading. The app shell's
      // header already renders the route title as this page's h1, and a browser
      // walk found two of them here once.
      assert.doesNotMatch(
        html,
        /<h1/,
        'The route rendered its own h1. The shell header already renders one for this page, so the document ' +
          'now has two, which is what the browser walk found.',
      );
    },
  );
});
