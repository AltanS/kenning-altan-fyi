/**
 * The root route's `isOfflineFallback` flag.
 *
 * WHY THE FLAG EXISTS. When the server cannot be reached, the root
 * `clientLoader` answers from memory: its `userId` is either the last server
 * answer or the display-only signed-in hint. `_app.tsx` must not confirm the
 * hint against a value that came from the hint, and the sync ribbon must not
 * claim another account signed in on the strength of one. The flag is how they
 * tell a server answer from a fallback.
 *
 * WHAT IS PINNED: the server loader says `false`; both fallback branches say
 * `true`, the remembered one as a COPY so the stored live answer keeps saying
 * `false`; and a live answer is passed through untouched.
 *
 * HOW THE ROUTE LOADS HERE. `root.tsx` imports stylesheets, which bare Node
 * cannot load, so a loader hook turns them into empty modules
 * (`tests/support/stub-assets-hooks.mjs`). The three server-only reads
 * (display user, toast, cookie renewal) are replaced, because each reaches the
 * database or a secret at import.
 *
 * THE CASES RUN IN ORDER and share the module's remembered answer: the
 * first-run case must come before any live answer is served.
 */
import { register } from 'node:module';
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

register('../support/stub-assets-hooks.mjs', import.meta.url);

mock.module('#app/middleware/auth', {
  namedExports: { readUserForDisplay: () => Promise.resolve({ id: 6, email: 'reader@example.test', isSuperadmin: false }) },
});
mock.module('#app/utils/toast.server', {
  namedExports: { getToast: () => Promise.resolve({ toast: null, headers: new Headers() }) },
});
mock.module('#app/middleware/session-renewal', {
  namedExports: { sessionRenewalMiddleware: () => undefined },
});

const { clientLoader, loader } = await import('#app/root');

/** Installs a `localStorage` holding a signed-in hint for user 4. */
function installHint(): void {
  const stored = new Map<string, string>([['kenning-signed-in-hint', JSON.stringify({ userId: 4 })]]);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    },
  });
}

/** What the server loader answers for a page, with the redirect case set aside. */
type ServerAnswer = Exclude<Awaited<ReturnType<typeof loader>>, Response>;

/** A `serverLoader` that fails the way an unreachable network does. */
const unreachable = (): never => {
  throw new TypeError('Failed to fetch');
};

/** What the real server loader answers for a signed-in reader. */
async function serverAnswer(): Promise<ServerAnswer> {
  // SAFETY: the loader reads only `request` from its args.
  const answer = await loader({ request: new Request('https://kenning.altan.fyi/') } as never);
  if (answer instanceof Response) throw new Error('the server loader returned a redirect');
  return answer;
}

function runClientLoader(serverLoader: () => Promise<ServerAnswer>): ReturnType<typeof clientLoader> {
  // SAFETY: `clientLoader` reads only `serverLoader` from its args, so the other
  // fields of the framework's argument object are never touched. The real
  // `serverLoader` hands back the SERIALIZED answer; this test hands back the
  // loader's own, which differs only in how `headers` is typed.
  return clientLoader({ serverLoader } as never);
}

describe('the root loaders and isOfflineFallback', () => {
  it('first run offline, with nothing remembered: the fallback says true and carries the hint id', async () => {
    installHint();
    const data = await runClientLoader(unreachable);
    assert.equal(data.isOfflineFallback, true);
    assert.equal(data.userId, 4, 'the id comes from the hint, which is exactly why it must be flagged');
  });

  it('the server loader says false', async () => {
    const data = await serverAnswer();
    assert.equal(data.isOfflineFallback, false);
    assert.equal(data.userId, 6);
  });

  it('passes a live answer through untouched', async () => {
    const live = await serverAnswer();
    const served = await runClientLoader(() => Promise.resolve(live));
    assert.equal(served, live);
    assert.equal(served.isOfflineFallback, false);
  });

  it('after a live answer, an unreachable server returns a FLAGGED COPY of it', async () => {
    const remembered = await runClientLoader(unreachable);
    assert.equal(remembered.isOfflineFallback, true);
    assert.equal(remembered.userId, 6, 'it is the remembered answer, not the hint');
  });

  it('leaves the stored live answer saying false', async () => {
    const live = await serverAnswer();
    await runClientLoader(() => Promise.resolve(live));
    await runClientLoader(unreachable);
    assert.equal(live.isOfflineFallback, false);
  });
});
