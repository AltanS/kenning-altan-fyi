# Airplane-mode check for the Kenning PWA

An automated check that the installed app still works with no network. It runs
the PRODUCTION build (the service worker registers only there), drives a fresh
Chromium profile per scenario, and asserts that the page is interactive, not
only painted.

## Run it

```bash
scripts/offline-check/run.sh                 # prepare, build, run all ten scenarios
scripts/offline-check/run.sh --only S1,S6    # a subset
SKIP_BUILD=1 scripts/offline-check/run.sh    # reuse the existing build/
```

Exit code 0 means every scenario passed, 1 means at least one failed, 2 means
the harness itself broke. A run takes about four minutes. Artifacts (screenshot,
JSON evidence, app log) land in `scripts/offline-check/out/<timestamp>/`, which
is git-ignored.

## What `run.sh` does

1. Creates the throwaway database `kenning_offline_check` on the shared dev
   Postgres (container `projects-postgres-1`, `localhost:5433`) if it is missing,
   then runs the Drizzle and data migrations against it. It refuses any database
   name that does not contain `offline_check`. `DB_PASSWORD` comes from the repo
   `.env`; nothing is written to a tracked file.
2. Seeds one email-verified account with `seed-user.mjs`: `offline-check@example.test`
   with a throwaway password. A direct insert is the cheapest way. The real
   sign-up needs a mailed link, and production mode refuses to use the console
   mail transport.
3. Runs `pnpm build` inside the `ts-dev` toolbox.
4. Runs `scripts/offline-check/run.mjs` on the host node. The driver has no
   dependencies. It runs on the host because Chromium started inside the toolbox
   finds no system fonts, so every screenshot would be text-free boxes.

`run.mjs` starts `server.ts` (ADR-0004: the custom server is the production
entry) in the toolbox with `NODE_ENV=production`, on `127.0.0.1:3777`, and a
fault-injection proxy on `127.0.0.1:3778`. The browser only ever talks to
`http://localhost:3778`. It stops both on exit, on Ctrl-C too, and fails at the
start if the port is taken, so it never tests a stale server.

Safety: the app gets dummy pigeon values and `disabled` LLM keys, and no worker
runs, so no mail is sent and no model call is paid for.

Override ports with `OFFLINE_CHECK_APP_PORT` and `OFFLINE_CHECK_PORT`. Override
the browser with `CHROME_PATH`.

## How "airplane mode" is applied

Two layers at once, so a green result cannot come from a leak:

- CDP `Network.emulateNetworkConditions(offline)` on every page AND every
  service worker target. In a tab that is already open this also makes `navigator.onLine` false; a cold-started tab gets a script for that (below).
- The proxy resets every connection (`offline`), or accepts a request and never
  answers (`hang`, for scenario S6).

Every `goOffline()` runs a negative control: a fetch with a query string (which
the worker does not intercept) must fail, or the harness aborts.

A "cold open" closes the whole browser process and starts it again on the same
profile. The service worker registration, caches and IndexedDB survive on disk.

## How cookies are handled on a cold open

The session cookie `_session` is set with `Max-Age` (400 days), so Chromium
writes it to the profile and it survives a restart on its own. A cold open
(`restart()` in `cdp.mjs`) takes two options:

- `restoreCookies` (default `true`): read every cookie from the browser before
  the close and put them back after the start, as an installed app's sign-in
  would be kept by the OS shell. This is what S1 to S9 use. The snapshot is
  taken with `Storage.getCookies` on the browser itself, because the tab is
  already closed at that moment.
- `restoreCookies: false`: the harness touches nothing. Only what Chromium
  persisted itself is there. S10 uses it, so it tests the real `Set-Cookie`
  behaviour and not the harness.
- `dropCookies: ['_session']`: the named cookies are removed after the start,
  both from the restored set and from what the profile persisted. S8 uses it
  for a cold open with no session at all.

`browser.deleteCookie(name)` removes a cookie from the live browser (S9).

A tab opened while the harness is offline gets a script that keeps
`navigator.onLine` false from its first line (`OFFLINE_SHIM` in `cdp.mjs`).
Chromium's own emulation fails the fetches but leaves `onLine` true in a tab
that was opened after the emulation was set, which is every cold start, and the
app branches on `onLine` (the paused-sync ribbon is online-only). Going back
online removes the script and fires the `online` event.

The proxy records every request with its path and the status the app answered
(`proxy.requests(sinceIndex, pathPrefix)`), so a scenario can count the calls to
`/api/v1/sync/blob` and see which were refused.

## Scenarios

| Id | What it does | Passes when |
|----|--------------|-------------|
| S1 | Fresh install: `/welcome`, sign in, worker active, nothing else visited, offline cold open of `/` | The search box is hydrated and typeable |
| S2 | Same, but `/` and `/lists` were opened online first | Same |
| S3 | A fake `de-en` device dictionary is imported, then offline cold open of `/?from=de&to=en&q=Haus` | The device hit "house" renders |
| S4 | Booted app goes offline, client-navigates to `/lists`, `/favourites`, `/quiz`, then creates a list | Each screen opens, no error boundary, the list appears |
| S5 | Booted app goes offline, client-navigates to `/history` and `/settings`, each never opened ("cold") and opened online before ("visited") | A calm "needs a connection" message, no crash |
| S6 | HANG: the proxy never answers, cold open of `/` | Interactive within 6 s |
| S7 | Offline then online again with no reload, search a word | The normal server result shows, no stuck offline notice |
| S8 | Signed in, a list "Plane list" made online, then offline cold open with the `_session` cookie dropped | `/` is interactive, the nav links are drawn, `/lists` shows "Plane list", `/favourites` and `/quiz` open with no error boundary, the signed-in hint is still there with no pause |
| S9 | Signed in, "Plane list" made, `_session` deleted in the live browser, then `focus` | Exactly one 401 on the sync blob, the paused ribbon links to `/sign-in?next=`, the hint says `expired`, three more `focus` events and a local edit send no sync request. Offline cold open (cookie still gone): shell and lists are there, no ribbon. Online: `/` lands on `/welcome` with the device-data-kept notice. After signing in again as the same account: the first request is a pull that returns 200 and nothing is refused (the follow-up cycles the app runs after applying the pull must stay bounded and settle), ribbon gone, pause cleared, both lists survive |
| S10 | Signed in, cold start with `restoreCookies: false` | `_session` has an expiry about 400 days out, survives the restart in the profile, and `/lists` opens online with no redirect to `/sign-in` |

"Interactive" means: the search box exists and React has attached to it
(`__reactProps$`), real typed text lands in it, and a real click opens the
account menu.

The fake dictionary is written straight into the `kenning-device-dictionary`
IndexedDB (stores `meta` and `entries`) and the `device-dict=de-en` cookie is
set, exactly as the settings card does after an import. It holds one word.

## Evidence on a FAIL

Console output lists the screenshot, the page URL, `navigator.serviceWorker.controller`,
every cache with its entry count, whether the cached `/` references assets that
no cache holds, failed requests and console errors. The full detail is in the
JSON file next to the screenshot, including every cache entry URL, the worker's
console and what the proxy refused or held.

## Files

- `run.sh` setup, build and launch. `run.mjs` scenarios and reporting.
- `cdp.mjs` the dependency-free CDP client. `proxy.mjs` the fault proxy and request log.
- `app.mjs` starts and stops the production server. `bind-localhost.mjs` makes
  `server.ts` listen on 127.0.0.1 only (it calls `listen(port)` with no host).
- `seed-user.mjs` the test account.
