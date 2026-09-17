/**
 * What a visitor with no account can reach, read off the routing tree itself
 * (M199).
 *
 * WHAT WENT WRONG, AND WHY A TEST HAS TO HOLD THE SHAPE
 *   A signed-out visitor at `/`, `/translate` or `/explain` was handed the
 *   whole app shell: a sidebar offering lists, favourites and history, a
 *   language bar, an input card and a mode switch. Every control refused them,
 *   and the only way to find that out was to press one. M199 moved those two
 *   aliases under `_app.gated` and gave the stranger a front door of their own
 *   at `/welcome`.
 *
 *   None of that is visible to a typecheck, a lint or a build. A route moved
 *   back out of the gated block is a two-word edit in `app/routes.ts` that
 *   nothing else notices, and the old shape is what a reader would draw from
 *   memory. So this file walks the REAL config the app exports, which is also
 *   why there is no second description of the tree here to fall out of step
 *   with the first.
 *
 * THE INDEX IS THE ASYMMETRY, AND IT IS THE INTERESTING CASE. `/` and
 * `/translate` are two route ids over ONE module, and only the alias is in the
 * gated block: a route sits in exactly one layout, and the index has to keep
 * the app shell for the reader who is signed in. So `/` is gated by the
 * request-keyed rule at the top of the loader they share, and the last case
 * below reads that rule out of the source. Without it, a later reader sees the
 * layout gate on the alias, concludes the loader rule is redundant, deletes it,
 * and reopens `/?q=` for everybody. That is exactly the hole M184 closed.
 *
 * NO ENVIRONMENT PRECONDITION. It imports `app/routes.ts`, which pulls in the
 * route CONFIG and no route module, so no database pool is opened.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { RouteConfigEntry } from '@react-router/dev/routes';

import routes from '../../app/routes';
import { WELCOME_PATH } from '../../app/lib/auth/paths';

const APP_LAYOUT = 'routes/_app.tsx';
const GATED_LAYOUT = 'routes/_app.gated.tsx';
const PUBLIC_LAYOUT = 'routes/_public.tsx';

const TRANSLATE_SOURCE = readFileSync(new URL('../../app/routes/translate.tsx', import.meta.url), 'utf8');

/**
 * The chain of layout files one route sits inside, outermost first.
 *
 * MATCHED ON THE PATH, NOT ON THE FILE. `routes/translate.tsx` is registered
 * twice, as the index and as the `/translate` alias, so a file match would
 * find whichever came first and quietly answer for the wrong one of the two
 * this file is here to tell apart.
 */
function ancestorsOfPath(entries: readonly RouteConfigEntry[], path: string): string[] | null {
  for (const entry of entries) {
    if (entry.path === path) return [];
    const inner = ancestorsOfPath(entry.children ?? [], path);
    if (inner !== null) return [entry.file, ...inner];
  }
  return null;
}

/** The same walk for the index route, which has no path of its own. */
function ancestorsOfIndex(entries: readonly RouteConfigEntry[]): string[] | null {
  for (const entry of entries) {
    if (entry.index === true) return [];
    const inner = ancestorsOfIndex(entry.children ?? []);
    if (inner !== null) return [entry.file, ...inner];
  }
  return null;
}

describe('the gated app surface', () => {
  for (const path of ['/translate', '/explain']) {
    it(`keeps ${path} under the gated layout`, () => {
      const ancestors = ancestorsOfPath(routes, path);

      assert.ok(ancestors !== null, `${path} is not registered in app/routes.ts at all, so nothing serves it.`);
      assert.deepEqual(
        ancestors,
        [APP_LAYOUT, GATED_LAYOUT],
        `${path} sits under ${ancestors?.join(' > ')} rather than under ${GATED_LAYOUT}. A visitor with no ` +
          'account then gets the whole app shell around a screen whose every control refuses them, which is the ' +
          'defect M199 removed. The screen they are owed is ' +
          `${WELCOME_PATH}.`,
      );
    });
  }

  it(`keeps ${WELCOME_PATH} in the public layout, with no gate in front of it`, () => {
    const ancestors = ancestorsOfPath(routes, WELCOME_PATH);

    assert.ok(ancestors !== null, `${WELCOME_PATH} is not registered in app/routes.ts, so the gates redirect into a 404.`);
    assert.deepEqual(
      ancestors,
      [PUBLIC_LAYOUT],
      `${WELCOME_PATH} sits under ${ancestors?.join(' > ')} rather than under ${PUBLIC_LAYOUT} alone. It is where ` +
        'every signed-out visitor is sent, so a gate in front of it is a redirect loop, and the app shell around ' +
        'it is the sidebar this screen exists to keep away from a stranger.',
    );
  });

  it('leaves the index outside the gated layout, where its own loader has to gate it', () => {
    const ancestors = ancestorsOfIndex(routes);

    assert.deepEqual(
      ancestors,
      [APP_LAYOUT],
      'The index moved under the gated layout. It cannot: the same module is served at `/translate` from inside ' +
        'that block, and a route sits in exactly one layout, so moving `/` there would take the app shell away ' +
        'from the signed-in reader it is for.',
    );
  });

  it('gates the index in the loader both ids share', () => {
    // A SOURCE READ, because there is no other tier that can make this claim
    // without a database. The rule is one line at the top of the loader, and
    // the layout gate on the alias is what makes it look deletable.
    assert.match(
      TRANSLATE_SOURCE,
      /WELCOME_PATH/,
      'app/routes/translate.tsx no longer redirects a signed-out visitor to the front door. The `/translate` ' +
        'alias is gated by `_app.gated`, but `/` is not and cannot be, so removing this rule serves the app ' +
        'shell to every stranger who opens the product at its real URL.',
    );
    assert.match(
      TRANSLATE_SOURCE,
      /throw redirect\(WELCOME_PATH\)/,
      'The front-door path is imported but never thrown from. A computed destination that nothing redirects to ' +
        'is the shape of a gate that was half removed.',
    );
    assert.match(
      TRANSLATE_SOURCE,
      /SIGN_IN_PATH\}\?next=/,
      'The `?next=` sign-in redirect is gone. A shared result link then loses the result: the reader signs in ' +
        'and lands on the home screen with nothing typed.',
    );
  });
});
