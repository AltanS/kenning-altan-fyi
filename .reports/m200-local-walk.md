# M200 local walk, 2026-09-19

Run against `http://127.0.0.1:3210` (loopback only), one quiet dev tree (web plus one worker, no file edits during the walk), headless Chromium through agent-browser, namespace `m200`, sessions `readerA`, `readerB`, `signedOut`, `operator`. Code under test: HEAD `13a7e7d`.

Questions used (both en to de, both really queued, two paid model calls):
- q1: `What does the word "kettle" mean in "the pot calling the kettle black"? (walk-m200-q1)`, `explanations.id` cd58be99-6451-4d24-919c-bffeacbbb08d
- q2: `What does the word "borrow" mean in "borrow trouble"? (walk-m200-q2)`, `explanations.id` b6d7b8f3-d442-4d7d-9d67-aafb3ba0715f

Accounts: reader A is the seeded `user@example.com` (id 489), the operator is the seeded `superadmin@example.com` (id 488), reader B is `walk-m200-b@example.com`, signed up through `/sign-up` and verified with one `UPDATE`.

## The seventeen steps

1. PASS: `/settings` for reader A shows the Public name field `WalkReaderA` and the switch "Hide new explanations by default" with `aria-checked="false"`; `user_profiles` row 489 reads `WalkReaderA | f`.
2. PASS: q1 asked through the real form on `/explain`; the answer rendered after about 10 seconds; the database holds one `ok` `explanations` row and one `explanation_authorship` row (user 489, `listed = t`, `show_name = f`), so the run was `queued`.
3. PASS: `/explanations/105` shows both switches ("Show this answer on the public pages" on, "Show my name on this answer" off) and the CC0 notice in its public phrasing; turning the name switch on gives `show_name = t` and it holds after a reload.
4. PASS: signed out, `/browse/explanations?from=en` lists q1 as "asked by WalkReaderA" with the read-only score "0 accurate, 0 not accurate"; the detail page repeats the byline, and clicking "This answer is accurate" shows "Sign in to vote on this answer" while the count stays 0 and 0 and the URL does not change.
5. PASS: reader B up-voted from the same public detail URL; with the vote request delayed by 1.5 seconds inside the page, the tally moved from "0 1" to "1 0" at 300 ms, before the server answered; after a reload it reads "1 0" with the up button pressed; `explanation_votes` holds one row, value 1, account 1769.
6. PASS: reader A switched "Show this answer on the public pages" off; the notice now reads "This question and its answer are hidden from the public pages."; `listed = f`; signed out, the list has no q1 row and the direct detail URL returns 404 (browser and `curl`).
7. PASS: switched back on; `listed = t`, it holds after a reload, and the detail URL returns 200 again.
8. PASS: reader B opened the inline "Report this explanation" block at the foot of the public detail page (a `<details>` block in the page, not a dialog), typed a short reason and pressed "Send report"; toast "Report sent."; one `explanation_reports` row. Signed out, the same place reads "Sign in to report an explanation." with no form; a hand-made signed-out POST returns the `unauthenticated` refusal and adds no row.
9. PASS: as the operator on the LOCAL server, `/super/explanations` lists q1 with Up 1, Down 0, Reports 1, newest reason "walk-m200 test report: checking the report path", state "Public"; "Hide" with a reason wrote one `explanation_moderation` row (`hidden_by_user_id` 488) and the state became "Hidden".
   - Layout defect D1 (function is fine): see "Findings that are not step failures".
10. PASS: signed out while hidden, the list has no q1 row and the direct detail URL returns 404; after "Show again" the moderation table is empty, the list shows q1 and the detail URL returns 200.
11. PASS: reader A cleared the public name in `/settings` (toast "Public name cleared."); `public_name` is null and the authorship row was not touched (`show_name` stayed `t`); the public list and the public detail no longer contain "asked by" or `WalkReaderA`, in the browser and in `curl`.
12. PASS: with "Hide new explanations by default" on (`aria-checked` true after a reload, stored `t`) the `/explain` notice reads the "start out hidden" phrasing; fresh q2 was asked; its authorship row has `listed = f`, `show_name = f`; `/explanations/107` shows the listing switch off with the hidden notice, and the public detail returned 404 until the switch was turned on (then `listed = t`, 200); the account preference was set back off (stored `f`).
13. PASS: `curl -s <page> | grep -ci 'name="robots"'` prints 0 for `/browse/explanations` and for a detail page (both 200, and neither sends an `X-Robots-Tag` header).
14. PASS: after setting the name again (`WalkReaderA`, byline back on q1), Remove on q1 showed the dialog "It leaves your list. Anything you made public with it comes off the public pages, and stays off. The answer itself stays in the shared record."; afterwards the authorship count for q1 is 0 (was 1), the list has no q1 row, the detail URL returns 404, the ask row is gone and the `explanations` row stays; asking q1 again returned the stored answer (still one `explanations` row), `/explanations/108` shows 0 switches, and q1 stays off the public pages (404, 0 authorship rows).
15. PASS: reader B asked q2, which reader A asked and which is public: B got the stored answer, `/explanations/109` shows 0 switches and the retry-credit sentence, and `explanation_authorship` for q2's key still has exactly one row (user 489).
16. PASS: signed in, `/explain` shows the "public by default" notice for a reader with the default off and the "start out hidden" notice for a reader with it on, each with the link "Change this in Settings" (clicking it lands on `/settings`); signed out, `/explain` answers 302 to `/sign-in?next=%2Fexplain` and that page carries neither notice.
17. PASS: `/legal/privacy` and `/legal/terms` rendered signed out in English and in German (cookie `translate-language=de`): every string added or rewritten since `0d41af0` (privacy s1Item6, s5Body4 to s5Body7, s8Body4, s12Body, s13Body2; terms s6Body2) appears verbatim in the rendered text in both languages, and the date lines read `Last updated: September 18, 2026` and `Zuletzt aktualisiert: 18. September 2026`; no em dash or en dash in any of the four rendered pages.

## Quoted copy (word for word, for the operator's judgement)

Byline on the browse list and the detail page (signed out):

> asked by WalkReaderA

CC0 notice on `/explanations/:id`, listed phrasing:

> This question and its answer are public. They are released under CC0: anyone may copy them, and no credit is needed. Switching this off later does not undo a copy someone already made.

CC0 notice, hidden phrasing:

> This question and its answer are hidden from the public pages.

Retry-credit sentence (reader B's cache-hit item, under the title):

> A public answer is credited to the person whose attempt produced it, not to everyone who asked the same question. If you retry a question that failed for someone else, your attempt can become the credited one.

Licence line on the browse list and at the foot of a detail page, with its link text:

> Questions and answers on these pages are released under CC0. Anyone may copy them, and no credit is needed. Read the CC0 text

Also on the browse list: "The answers are written by a machine. Treat them as drafts, not as checked references." and, for a stranger, "Create an account to ask your own questions and vote on answers." with the buttons "Create account" and "Sign in".

`/explain` notice, default off (listed):

> Questions you ask here are public by default, with their answers and without your name. Anyone may copy them, and hiding one later does not undo a copy. Change this in Settings

`/explain` notice, hide-by-default on:

> Questions you ask here start out hidden from the public pages. You can list one later from its page. Change this in Settings

Report form (inline, collapsed until opened) and its states:

> Report this explanation
> Tell us what is wrong with it. A person reads every report. Reporting does not hide anything by itself.
> What is wrong? (optional)
> Send report

Toast after sending: "Report sent." Signed out: "Sign in to report an explanation." Vote line signed out, after pressing a vote button: "Sign in to vote on this answer".

Switch labels and the name hint on `/explanations/:id`: "Show this answer on the public pages", "Show my name on this answer", and, for a reader with no public name, "You have not chosen a public name yet. Choose one in Settings".

## Layout check (screenshots in /tmp/m200-walk/, outside the repo, each opened)

- `explain-desktop.png`, `explain-390.png`, `explain-hidden-notice-desktop.png`: nothing broken; the notice wraps cleanly under the question box at both widths.
- `explanation-detail-desktop.png`, `explanation-detail-390.png` (private page with the two switches and the CC0 notice): nothing broken; the switch card fits at 390 px.
- `explanation-cachehit-b-desktop.png` (no switches, retry-credit sentence under the title): nothing broken.
- `browse-list-desktop.png`, `browse-list-390.png` (signed out): nothing broken; a stranger sees only the logo and the theme button, no sidebar, no dead links; the sign-up and sign-in doors sit in the page body.
- `browse-detail-desktop.png`, `browse-detail-desktop-bottom.png`, `browse-detail-390.png`, `browse-detail-390-bottom.png`, `browse-detail-after-vote-click.png`: nothing broken; no overflow at 390 px.
- `browse-detail-report-form-desktop.png`, `browse-detail-report-sent-desktop.png`: form fits, toast bottom right, nothing overlaps.
- `super-explanations-desktop.png`: BROKEN at desktop width, see D1.

## Findings that are not step failures

- D1 (operator screen, layout defect). At 1280 px wide `/super/explanations` scrolls sideways by 48 px (`document.documentElement.scrollWidth` 1328 against 1280), the header "Account" button is cut off, and the State and Action columns sit beyond the edge. Measured: at 1024 px the page is 1280 wide, at 768 px it is 1024 wide; at 390 px it fits. `/explain`, `/settings` and `/explanations` do not overflow at any of those widths. Cause, by measurement: the `<main>` grows to the min-content width of the page (the table is 1292 px; its `overflow-x-auto` wrapper does not lower that) instead of shrinking beside the sidebar. Suspect: the missing `min-w-0` on the flex item that holds `app/routes/super/explanations.tsx`'s content. The Hide and Show again buttons still work (I submitted their forms); a real operator needs a sideways scroll to reach them.
- O1 (low). The browse list preview is `answer.answer.slice(0, PUBLIC_PREVIEW_CHARS)` (`app/models/explanation-browse.server.ts:301`) with no ellipsis, so at desktop width a row can end mid-word ("weshalb der Vor"); at 390 px CSS clamps and shows an ellipsis.
- O2 (low). After "Send report" the reason text stays in the textarea and the block stays open; the toast is the only confirmation. A second press writes nothing new (one row per reader and item) but looks like a resend.
- O3 (low). The "Also look up" chips on the public detail page link to `/translate?q=...`, which sends a signed-out stranger to `/sign-in?next=...`.
- O4 (pre-existing, not M200). The `/explain` suggestion chip "How is actually used in a sentence?" reads as if a word is missing; it comes from `app/locales/en/common.json:480`, added in `241c747`.
- Normaliser note: `explanation_moderation.question_normalized` for q1 ended `(walk-m200-q1` (the closing parenthesis is stripped by the question normaliser); cleanup therefore matched on the `walk-m200` tag, not on the exact text.

## Environment

- Dev tree: one `pnpm dev` (web plus worker) started earlier the same day by the first walk agent, started with `NODE_OPTIONS="--require /tmp/loopback-listen.cjs"` (the preload forwards `listen(port)` calls to host `127.0.0.1`). It was reused, not restarted.
- Bind proof, at the start and again before the report:

```
LISTEN 0      511              127.0.0.1:24699      0.0.0.0:*
LISTEN 0      511              127.0.0.1:3210       0.0.0.0:*
```

- `curl http://127.0.0.1:3210/healthcheck` returned 200; the log holds the line "Workflow worker is running and listening for jobs".
- Browser: headless Chromium crashes on this host unless `FONTCONFIG_FILE=/tmp/fontconfig-static/fonts.conf` is set (same workaround as `.reports/m199-local-walk.md`); no application file was touched.
- agent-browser traps met: Radix switches, the account menu, the Remove menu item and the dialog buttons only reacted to the synthetic pointerdown, mousedown, pointerup, mouseup, click sequence at the element centre; forms were filled with the native value setter plus an `input` event and submitted with `requestSubmit()`. The optimistic vote was proved by delaying `window.fetch` for `explanation-vote` inside the page, because the local server answers in 3 ms.

## Cleanup (local dev database only)

Counts before and after (walk rows):

```
                              before   after
explanations tagged walk-m200      2       0   (cascades authorship, votes, reports)
explanation_authorship             1       0
explanation_votes                  1       0
explanation_reports                1       0
explanation_moderation             0       0
explanation_asks tagged            3       0
workflows tagged (completed)       2       0   (cascades workflow_operations)
users walk-m200-b@example.com      1       0
```

- Reader A ends as it began the day: public name cleared (null), "Hide new explanations by default" off. A scan of every text and JSON column in the public schema for the string `walk-m200` returns 0 rows.
- Dev tree stopped by exact process id, leaves first, with SIGTERM only (no SIGKILL needed): 1521885, 1521795, 1521793, 1521423, 1521421, 1521894, 1521808, 1521807, 1521414, 1521413, 1521134, 1521130, 1520735, 1519347 (the in-container tree), after which the host wrappers 1519147 (`podman exec`), 1519010 (`toolbox run`) and 1518994 (the shell that started it) had also exited. No `pkill` was used.
- Afterwards: `ss -ltn` shows nothing on ports 3210 and 24699; `pg_stat_activity` shows 0 `workflow-orchestrator` sessions; no process with the repo as its working directory is left from the walk; `/tmp/loopback-listen.cjs` and the temporary password file for reader B are deleted.
- The four agent-browser sessions (`readerA`, `readerB`, `signedOut`, `operator`) were closed; the `m200` daemon exited with its last session and its Chrome is gone. The daemons of the earlier namespaces (k4 and k199e, pids 1974185 and 4037676) were left running, untouched.
- Left behind on purpose: rows in the dev `sessions` table for the sign-ins of the two seeded accounts, and the screenshots under `/tmp/m200-walk/`.

## After the walk: fixes and re-measurement (2026-09-19)

D1, O1 and O2 were fixed the same day. O3 and O4 are left as follow-ups.

- D1 fixed. `min-w-0` on `SidebarInset` at its one call site in `app/components/app-wrapper.tsx`. Re-measured on a web-only dev tree bound to `127.0.0.1` (ports 3210 and 24699 both proven with `ss -ltn`), with one temporary reported and hidden row. `documentElement.scrollWidth` equals `clientWidth` at 1280, 1024, 768 and 390 px. The table now scrolls inside its own box (1288 px of content in a 910 px box at 1280 px). The screenshot `/tmp/m200-walk/super-explanations-fixed-desktop.png` was opened: the header "Account" button is fully visible.
- O1 fixed. `truncatePreview` in `app/models/explanation-browse.server.ts` cuts at a word and adds one ellipsis, inside the 140 character budget. New unit file `tests/unit/explanation-browse-preview.test.ts` (12 cases). On the public list a row now ends "...for factual knowledge, information, or…".
- O2 fixed. In a browser, reader A opened "Report this explanation", typed a reason and sent it: the block closed and the textarea was empty afterwards. A failed send does not reset it (the reset sits after the failure branch in the effect).
- O3 not fixed. The "Also look up" chips send a stranger to sign-in. It is a door, not a defect, and it is filed as a follow-up.
- O4 not fixed. It predates M200.
- Cleanup of this re-check (local dev database only): 2 report rows, 1 moderation row and 1 authorship row deleted, all counts back to 0. The dev server was stopped, both ports are free, the orchestrator session count is 0, the browser sessions are closed and the preload file is deleted.
