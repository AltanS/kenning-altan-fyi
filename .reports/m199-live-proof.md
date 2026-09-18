# M199 production proof — 2026-09-18

Deploy: push `813c74f` (main), build `bay-build@translate.service` on infra (100.64.0.5) succeeded (Result=success, ExecMainStatus=0). Both `translate` and `translate-prod` on sprqvntrs-eu (100.64.0.1) swapped to the new image and came up healthy: migrations applied cleanly (`[✓] migrations applied successfully!`), no restarts (`RestartCount=0`), `/healthcheck` returns `200` on both containers' internal port 3000, and `https://kenning.altan.fyi/healthcheck` returns `200` publicly.

Probe account: `probe-m199@example.com` (id 7), created through the real `/sign-up` flow on `https://kenning.altan.fyi`, verified by one direct `UPDATE users SET email_verified_at = now()` on `translate_prod` (no mailed link followed).

Steps 1-5 repeated against production, signed in as the probe:

1. PASS — set public name "M199 Probe", saved. Toast "Public name saved."
2. PASS — reload: name persisted.
3. PASS — toggled "Hide new explanations by default" on, toast "Setting saved.", reload: still `checked=true`.
4. PASS — cleared the name, reload: name field empty, Clear disabled, switch still `checked=true` — clearing the name did not touch the unrelated preference.
5. PASS — toggled the switch back off, reload: `checked=false` — clean end state.

Database proof, captured directly via `psql` on `translate_prod` before deleting the probe:

```
user_profiles row for probe (user_id, public_name, public_name_folded, hide_new_explanations_by_default):
7|||f
```

Matches steps 4-5: name cleared, switch off.

`user_profiles` exists on production: `select to_regclass('public.user_profiles')` → `user_profiles`.

`explanations` column list, captured BEFORE this deploy and again AFTER, byte-identical — no reader-identifying column was added:

```
answer, cost_usd, created_at, error, finished_at, from_language_code, id,
latency_ms, model, prompt_version, provider, question, question_normalized,
status, to_language_code
```

Cleanup: `DELETE FROM users WHERE email = 'probe-m199@example.com'` → 1 row deleted. Cascade confirmed: `user_profiles` row for user_id 7 also gone (`select count(*) ... = 0`). `select count(*) from users where email='probe-m199@example.com'` → `0`.
