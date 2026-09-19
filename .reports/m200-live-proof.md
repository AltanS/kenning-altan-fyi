# M200 live proof on production, 2026-09-19

Target: `https://kenning.altan.fyi` (container `translate-prod`) and its stage twin (container `translate`), both on `sprqvntrs-eu` (100.64.0.1). Code shipped: `git push` of `d4f7848..04577e3`, ten commits, at 10:04:55 (Europe/Berlin). The real pre-push gate passed inside that push (lint, typecheck, unit tests, production build, "all gates passed"), and the whole local integration tier passed just before it (234 pass, 0 fail, 2 skipped).

## The build and the swap

- Before the push: `systemctl is-active bay-build@translate.service` on infra (100.64.0.5) read `inactive`, so no build was in flight to swallow the push.
- The build ran from about 10:05 to 10:10:40 (`activating`, then `inactive`).
- `translate` (stage) started at 2026-09-19T08:10:37Z. `translate-prod` started at 2026-09-19T08:10:47Z. Both had run for about nine hours on the old image before that, so ONE push swapped BOTH.
- Both containers: `RestartCount=0`, `ExitCode=0`, `OOMKilled=false`. No exit 137 loop.
- Readiness was read from the app, not from `docker ps`: the production log shows "Workflow worker is running and listening for jobs" at 08:11:07Z and the server line on port 3000 at 08:11:11Z; `https://kenning.altan.fyi/healthcheck` returned 200.
- Before the push `https://kenning.altan.fyi/browse/explanations` returned 404. After the swap it returns 200.

## The database, before and after

The BEFORE capture was taken at 2026-09-19T07:09:49Z, before the push. The AFTER capture was taken after the swap. Both come from `docker exec postgres psql -U app -d translate_prod`.

COLUMNS-BEFORE (15): id,from_language_code,to_language_code,question,question_normalized,status,answer,provider,model,prompt_version,cost_usd,latency_ms,error,created_at,finished_at
COLUMNS-AFTER (15): id,from_language_code,to_language_code,question,question_normalized,status,answer,provider,model,prompt_version,cost_usd,latency_ms,error,created_at,finished_at

The two lists are identical, so `explanations` gained no column and stays readerless. The check for reader-identifying columns (`account_id`, `user_id`, `session_id`, `address`, `email`) is covered by the spec command and reads 0.

```
                          before                                    after
migrations applied        27                                        30
indexes on explanations   explanations_latest_idx, explanations_pkey  explanations_latest_idx, explanations_pkey, explanations_public_listing_idx
new tables                all four absent                           all four present
rows: explanations,users,user_profiles   1,1,0                      1,1,0
explanation_authorship rows              (no table)                 0
```

The new partial index reads: `CREATE INDEX explanations_public_listing_idx ON public.explanations USING btree (from_language_code, created_at DESC NULLS LAST) WHERE (status = 'ok'::text)`.

The four new tables are `explanation_authorship`, `explanation_votes`, `explanation_moderation` and `explanation_reports`. No row was moved or rewritten: the one legacy `explanations` row has no authorship row, so it is not public.

## Public pages on production, signed out, before any probe

- `/browse/explanations` returns 200 with the CC0 licence line, the machine-answer warning, both language filters, the empty state ("Nothing here yet."), and the sign-up and sign-in doors.
- `curl -s https://kenning.altan.fyi/browse/explanations | grep -ci 'name="robots"'` prints 0. The detail route prints 0 as well. No `X-Robots-Tag` header is sent. (`/robots.txt` returns 404 and did before this milestone.)
- `/browse/explanations/00000000-0000-4000-8000-000000000000` returns 404, and `/browse/explanations/not-a-uuid` returns 404.

## The production probe run

Approved by the operator as Gate 2 on 2026-09-19. Two temporary accounts, `probe-m200-a@example.com` (reader A, public name `M200ProbeA`) and `probe-m200-b@example.com` (reader B), signed up through `/sign-up` on `https://kenning.altan.fyi` and marked verified with one `UPDATE` on `translate_prod`. Two labelled questions, `What does the word probe mean in a test? (m200 probe q1)` and `... (m200 probe q2)`, both asked with the UI default pair, English to German. That is two paid model calls. The run was driven in a headless browser, one session per identity, with SQL for the evidence. Times are Europe/Berlin.

Steps (numbered as in the local walk; the operator screen, steps 9 to 11, 13 and 16, are proved locally and by the integration tier, and step 13 was also proved above by `curl`):

1. PASS: A saved the public name `M200ProbeA`; it held after a reload; `hide_new_explanations_by_default` was `f`.
2. PASS: A asked q1; it answered; one `ok` `explanations` row and one `explanation_authorship` row (`listed = t`, `show_name = f`), so the run was `queued`.
3. PASS: `/explanations/:id` showed both switches and the CC0 notice; the name switch held after a reload.
4. PASS: signed out, `/browse/explanations?from=en` listed q1 "asked by M200ProbeA"; the detail page repeated it; pressing the vote button showed the sign-in line.
5. PASS: B's vote moved the button state at 400 ms, before a 1.5 second delayed reply, and held after a reload; one `explanation_votes` row.
6. PASS: A switched the listing off; the row left the list and the detail URL returned 404 (browser and cookie-less `curl`).
7. PASS: A switched it back on; the detail URL returned 200 again.
8. PASS: B filed an inline report; toast "Report sent."; one `explanation_reports` row. Signed out shows "Sign in to report an explanation."; a hand-made signed-out POST returned `{success:false,error:"unauthenticated"}` and wrote no row.
12. PASS: A turned hide-by-default on; the `/explain` notice read the "start out hidden" phrasing; A asked q2; its authorship row had `listed = f`; the private page showed the listing switch off; its public URL returned 404; after A switched it on it was public; A turned the account preference back off.
14. PASS: A used Remove on q1 (dialog wording as designed); the authorship count for q1's key went to 0; the list omitted it and the URL returned 404; asking q1 again was a cache hit (still one `explanations` row for that key), the private page showed no switches, and q1 stayed off the public pages.
15. PASS: B asked q2, which A had asked and which was public: B got the stored answer, no switches, the retry-credit sentence, and `explanation_authorship` for q2's key still held exactly one row, A's.

Also checked on production:

- Sign-up, sign-in and every POST (settings switches, ask, vote, report, remove) worked behind the proxy. No CSRF or origin failure appeared.
- The hide, proved at the data layer as the spec requires (`/super` is fenced to the operator's tailnet and no production superadmin credential was used): with q1 public, one `explanation_moderation` row was inserted for its key; the signed-out list omitted q1 and the detail URL returned 404; the row was deleted (`DELETE 1`); both came back.
- Legal pages, signed out, English and German: the date lines read `Last updated: September 18, 2026` and `Zuletzt aktualisiert: 18. September 2026`, and the new privacy text is present.
- The ask-time notice showed the "public by default" phrasing for a reader with the default off and the "start out hidden" phrasing for a reader with it on.

Public exposure window: q1 was public from about 10:15:40 and q2 from about 10:20. Both left the public pages when the accounts were deleted at 10:21:39. That is about six minutes, with a short planned gap for q1 during the hide check.

One oddity, not caused by this milestone: at 10:18:50 the production log recorded `An explain run failed` with the reason `Response validation failed` for q2's run (`e453c49a-...`). The job retried and the same row finished `ok` at 10:19:05, 25 seconds in total. The container did not restart. This is the existing model-answer validation and retry path.

## Cleanup and the re-check

- The moderation row delete printed `DELETE 0` at cleanup (the test row was already gone). The account delete printed `DELETE 2`.
- Re-checked separately afterwards by the session lead (production, read only):

```
users with email like probe-m200%       0
users in total                          1   (the existing operator account)
user_profiles                           0
explanation_authorship                  0
explanation_votes                       0
explanation_reports                     0
explanation_moderation                  0
explanation_asks                        1   (the existing user's own Turkish question)
explanations                            3   (the legacy row plus the two shared probe answers)
reader-identifying columns on explanations   0
```

- The two probe answers stay in the shared cache, as designed: a row with no authorship row is never listed. Both detail URLs return 404 and the visible text of `/browse/explanations` holds no probe text.
- `https://kenning.altan.fyi/healthcheck` returned 200 after the cleanup.
- Rollback, if ever needed: revert the commit and push again. The four tables and every row stay.
