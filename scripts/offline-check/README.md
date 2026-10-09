# Airplane-mode check for the Kenning PWA

An automated check that the installed app still works with no network. It runs
the PRODUCTION build (the service worker registers only there), drives a fresh
Chromium profile per scenario, and asserts that the page is interactive, not
only painted.

## Run it

```bash
scripts/offline-check/run.sh                 # prepare, build, run all seven scenarios
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
  service worker target. This also makes `navigator.onLine` false.
- The proxy resets every connection (`offline`), or accepts a request and never
  answers (`hang`, for scenario S6).

Every `goOffline()` runs a negative control: a fetch with a query string (which
the worker does not intercept) must fail, or the harness aborts.

A "cold open" closes the whole browser process and starts it again on the same
profile. The service worker registration, caches and IndexedDB survive on disk.
Session cookies do not, so the harness puts them back, as an installed app's
sign-in would persist.

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
- `cdp.mjs` the dependency-free CDP client. `proxy.mjs` the fault proxy.
- `app.mjs` starts and stops the production server. `bind-localhost.mjs` makes
  `server.ts` listen on 127.0.0.1 only (it calls `listen(port)` with no host).
- `seed-user.mjs` the test account.
