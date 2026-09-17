---
name: translation-wait-phases-ride-the-tick-counter
description: the 8s/25s waiting-copy thresholds read pane-state's elapsedMs, which advances one 3s poll at a time, so a phase turns at the first tick past it
metadata:
  type: project
---

`app/lib/translation/pane-state.ts` exports `TRANSLATION_PHASE_SECOND_MS` (8_000),
`TRANSLATION_PHASE_THIRD_MS` (25_000), `waitPhaseFor(elapsedMs)` and
`translationPaneWaitPhase(state)`. `TranslationPaneController.waitPhase` carries
it out to `TranslationPane`, which renders a three-bar `Skeleton` plus the phased
line.

**Why:** one sentence held for most of a minute reads as a frozen screen, and a
progress bar would be a number this app cannot know.

**How to apply:** the phases read the SAME `elapsedMs` the ninety second stall
rule uses, and that counter is advanced by the poll tick
(`TRANSLATION_POLL_INTERVAL_MS`, 3000), not by a wall clock. So a threshold turns
over at the first tick past it (8s fires at 9s). Do not add a second timer to
make it exact: that would give the machine two ideas of how long it has waited.
`waitPhase` is not a second state value, `translationPaneView` still decides the
branch; it only picks which sentence that one branch prints, and answers `first`
on every settled pane.

Related: [[project_pane_reducer_is_generic_with_noinfer]].
