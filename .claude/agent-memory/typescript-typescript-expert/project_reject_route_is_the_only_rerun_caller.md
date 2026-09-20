---
name: reject-route-is-the-only-rerun-caller
description: resolveTriggeredTranslationPanel's `rerun` param is the only thing that steps over a `ready` pair; the reject route owns the cooldown, and TranslationPaneEndpoints now has a third field every branch must fill
metadata:
  type: project
---

`resolveTriggeredTranslationPanel` takes `rerun?: { reason: RejectionReason } | null`.
It is the ONLY way a paid call is made for a pair that already has an answer.
`translating` still always returns early (the singleton key would dedupe a second
send anyway); `ready` returns early unless `rerun` is set; `failed` is stepped over
by `retry` OR `rerun`. The three guards run unchanged for a re-run.

**Why:** a reject button that bypassed the budget, daily cap and rate limit would be
an unbounded spend path behind a friendly label. And the cooldown cannot live in the
resolver: it is keyed on the reader's ACT of rejecting, not on the pane's state, so
`app/routes/api.translation.$headwordId.reject.ts` reads it, and stamps it ONLY when
the returned panel is `translating`.

**How to apply:** never pass `rerun` from a loader or the retry route. When adding a
member to `TranslationPaneEndpoints`, remember there are THREE producers, not two:
`translationPaneEndpoints` (headword and phrase branches) in `pane-state.ts` AND
`explainPaneEndpoints` in `explain-pane.ts` — the explain pane reuses the same
interface, so a new required field breaks it and typecheck is what finds it.

Related: [[project_enrichment_trigger_is_the_shared_seam]],
[[project_translate_rate_limit_last_of_three_guards_m193]]
