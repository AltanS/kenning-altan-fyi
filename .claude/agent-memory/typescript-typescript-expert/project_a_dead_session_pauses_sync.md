---
name: a-dead-session-pauses-sync
description: Kenning's signed-in hint is { userId, pause? }; a 401 or 412 pauses sync through pauseSyncOnAuthFailure and clears nothing, and root.tsx flags its offline fallback answers
metadata:
  type: project
---

`app/lib/auth/signed-in-hint.ts` holds `{ userId, pause?: { reason: 'expired' | 'other-account', at } }`. `userId` is the account whose DATA the device holds. Only `sign-out.tsx`'s normal branch clears it; `tests/unit/signed-in-hint-writers.test.ts` pins every writer by scanning imports.

**Why:** the scheduler called `runSyncCycleForCurrentSession` directly, so `withSignedOutCheck` in `sync-client.ts` was dead code on the real path. A 401 never dropped the session, so every focus, `online` and local edit resent it.

**How to apply:**
- Any new code that runs a sync cycle must catch through `pauseSyncOnAuthFailure` (`app/lib/sync/session-pause.ts`) and must not `reportError` what it returns `true` for.
- `app/lib/sync/orchestrator.ts` is a copied file (ADR-0008) and was NOT edited: the 412 header comes from `http-client.ts` defaulting `expectedUserId` to `getSyncSession()`.
- `root.tsx` marks both clientLoader fallbacks `isOfflineFallback: true`; the fallback `userId` is the hint's own, so it must never confirm the hint.
- `ConfirmAction` posts a form to the server, so a client-only destructive confirm (the erase flow) uses `AlertDialog` directly, as `device-dictionary-card.tsx` does.
- oxlint `no-conditional-empty-object-spread` bans `...(x ? {} : {k: v})`; build a `Headers` in statements instead.

Related: [[project_sign_out_wipes_via_clientaction]], [[project_root_clientloader_offline_revalidation]], [[project_en_only_locale_key_breaks_typecheck]].
