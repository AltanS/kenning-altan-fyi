# Offline shell (`public/sw.js`)

## How it works

- `pnpm build` runs `scripts/build-precache.ts` after `react-router build`. It
  writes `build/client/precache.json`, a list of every hashed file plus the
  icons, fonts and manifest. It also writes a stamp into `build/client/sw.js`.
- `routeDiscovery: { mode: 'initial' }` makes the route manifest a hashed file.
- On install the worker downloads every listed file, then the signed-out
  `/offline` page. Any failure fails the install and the old worker keeps
  serving. It also fails if `/offline` loads a file that is not on the list.
- A navigation waits four seconds for the network (1.5 s while the network is
  known to be down). On failure it redirects to `/offline?next=<path>`. The
  `/offline` page itself comes from the cache first, with no network wait.
- The offline page does not trust `navigator.onLine`. It asks `/api/build` with
  a 2.5 s limit. If the server answers, it does a full page load of `next`. If
  not, it navigates client-side, and each screen's own client loader decides
  what to show. A search then falls back to the device dictionary.
- A route data (`.data`) request waits 15 s, or 3 s for a minute after a
  failure. Its network error is what the client loaders read as "offline".
- Route data (`.data`) and `/api/*` are never cached. Only `/offline` is.
- `server.ts` serves `sw.js` and `precache.json` with `Cache-Control: no-cache`.

## When the session ends

An ended session pauses sync. It does not remove features or data.

- The signed-in hint (`kenning-signed-in-hint` in localStorage) is
  `{ userId, pause? }`. Only an explicit sign-out clears it.
- A 401 on a sync request records `pause: expired`, and a 412 records
  `pause: other-account`. Either one drops the sync session, and the app sends
  that request once, not again on every focus, `online` event or local edit.
- The offline shell stays complete: the sidebar, the tabs, lists, favourites and
  history all keep working from the device.
- While the pause is `expired` and the browser is online, a ribbon says
  "Sync is paused" and links to `/sign-in?next=`. Offline it says nothing.
- A root answer that names nobody is never read as an expired session, because
  the cached `/offline` page is signed out on purpose. The pause comes from the
  server refusing a request.
- The root `clientLoader` marks its fallback answers `isOfflineFallback: true`.
  They carry the hint's own id, so they never confirm the hint.

## Caches

| Name | Holds |
|------|-------|
| `static-v4` | Hashed build files. Old ones are pruned on activate. |
| `shell-<stamp>` | The `/offline` page, one per build. |
| `sw-meta` | The install record: stamp, time, count, last two lists. |

## Roll back

Swap in the kill worker and redeploy:

```bash
cp docs/sw-kill.js build/client/sw.js
```

Each device installs it, empties all caches and reloads once. It does not
unregister itself. The app registers `/sw.js` on every load, so an unregistered
worker would reinstall and reload forever. Ship the real worker to leave.

## Check it

`scripts/offline-check/run.sh` runs seven offline scenarios in Chromium.
`--only S1,S6` runs some. See its README.
