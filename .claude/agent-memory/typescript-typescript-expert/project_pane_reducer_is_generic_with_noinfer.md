---
name: pane-reducer-is-generic-with-noinfer
description: translationPaneReducer is generic over the ready payload, and NoInfer on both parameters is what keeps the translator's call sites compiling
metadata:
  type: project
---

`app/lib/translation/pane-state.ts` is shared by the translator pane and the
explain pane. `TranslationPaneState`, `TranslationPaneAction`,
`translationPaneReducer`, `translationPaneView` and `isTranslationPanePolling` are
generic over a `Panel extends PanePanel`, defaulting to `TranslationPanel`.

**Why:** plain inference reads `Panel` off the `state` argument and narrows it to
the ONE union member that state holds, so a `polled` action carrying a `ready`
panel is then rejected. That broke five existing assertions in
`tests/unit/translation-pane-*.test.ts` the moment the functions became generic.

**How to apply:** every generic parameter position is `NoInfer<Panel>`, so `Panel`
falls back to the default unless a caller names it. The translator's call sites and
its tests are untouched; `app/components/explain-pane.tsx` writes
`translationPaneReducer<ExplainPanel>(...)` explicitly at all six call sites.
`isTranslationPanePolling` must pass `<Panel>` to `translationPaneView` for the
same reason. See [[explain-is-the-third-sibling-m198]].
