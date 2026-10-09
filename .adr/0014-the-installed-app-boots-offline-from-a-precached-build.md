# 0014: The installed app boots offline from a precached build, and search falls back to the device dictionary

- **Status:** Accepted
- **Date:** 2026-10-09
- **Deciders:** operator (the goal), implementing agents (the design, reviewed by an Opus pass and a counsel pass)

## Context

The installed app never got past its splash screen in airplane mode, and the
device dictionary (ADR-0013) could not be used offline. A browser harness
(`scripts/offline-check/`) measured the causes on the old code:

- `networkFirst` waited for the network with no limit, so a hung connection left
  a navigation pending for good.
- The install-time precache ran signed out, gated pages redirected and were
  dropped, and no JavaScript chunk was cached. The `/offline` page painted and
  never hydrated.
- Every URL with a query string, including the real search URL, skipped the
  worker. Client navigation to a route never visited failed on the lazy route
  manifest request.
- A search is a server loader, so the device dictionary lookup, which runs in
  the browser, only ran after a server page had rendered.

## Decision

1. **Precache the build, not pages.** `scripts/build-precache.ts` lists every
   hashed file after `react-router build` and stamps `sw.js`. Install is all or
   nothing. Only `/offline` HTML is ever cached. `routeDiscovery` is `initial`,
   so the route manifest is a hashed file in that list.
2. **Navigations never hang.** A navigation waits 4 s (1.5 s while the network
   is known to be down), then the worker redirects to `/offline?next=<path>`.
   The offline page checks the server with a short probe and not
   `navigator.onLine`, which stays true on a dead network. Reachable means a
   full page load. Unreachable means a client navigation.
3. **Route data is never cached.** It gets a timeout, and a failure is a
   `TypeError` the client loaders read as offline. This keeps the rule that a
   cached answer would look live.
4. **Search has a client loader.** `translate.tsx` wraps its server loader. On an
   unreachable server it returns routing facts only, never a dictionary hit. The
   search screen's existing device lookup shows the hit. Nothing offline is
   written to history, favourites, sync or any request, and nothing asks the
   AI. Phrases say they need a connection.
5. **No auto-revalidation on `online`.** It would replay an offline search to the
   server.
6. **A display-only signed-in hint** (`{ userId }` in localStorage) lets the
   navigation render offline. It gates nothing and is cleared on sign-out and
   on a 401.

## Alternatives Considered

- **Cache page HTML (stale-while-revalidate).** Embedded loader data (toast,
  email, recent searches) would be replayed as live data.
- **Serve the cached offline page at the original URL and rewrite the URL with
  an inline script.** It depends on running before hydration. The redirect is
  simpler to reason about.
- **Host the offline search inside `/offline`.** Smaller, but it duplicates the
  search screen and leaves `/?q=` broken offline.
- **Ship the served corpus (CC0 and CC-BY rows) as an offline pack.** Much more
  work. Offline search is the reader's own device dictionary only.

## Consequences

- The first install downloads about 2 MB. A later install downloads only the
  files it does not hold, and keeps one older generation for open tabs.
- A device with no imported dictionary can open the app offline and use lists,
  favourites and the quiz, but a search shows only "import a dictionary".
- `public/sw.js` is no longer unit-testable as a whole. Text tests guard its
  rules, and `scripts/offline-check/run.sh` is the acceptance test.
- A bad worker can strand installed apps. `docs/sw-kill.js` is the rollback.
- Open: the installed iOS app keeps its own storage, so the dictionary must be
  imported inside the installed app. The settings Offline row says so.

## References

- `docs/offline.md`, `scripts/offline-check/README.md`.
- ADR-0013 (the device dictionary stays on the device).
