---
name: explanation-body-is-the-one-rendering
description: ExplanationBody renders the answer for both explain screens and its variant may change only the lead size and heading level, with explanationToText as its label-free plain-text twin
metadata:
  type: project
---

`app/components/explanation-body.tsx` is the ONLY rendering of an explanation
document. `explanation-card.tsx` (under the question box) and
`app/routes/explanations.$id.tsx` (one saved ask) both call it.

**Why:** a reader opening a question they asked last week must meet the answer
they already read. Two renderings would be two answers to one question inside a
milestone.

**How to apply:**
- `variant: 'card' | 'page'` may change the lead size and the heading level, and
  NOTHING else. Not the order, not which section appears, not one class on a term
  or a cell. The order is lead, at-a-glance chips, contrasts, the words, pitfalls,
  related, references, generated marker; contrasts come BEFORE the words so the
  comparison is not buried under three dictionary entries.
- `app/lib/translation/explanation-text.ts` is the same document as plain text
  for the copy buttons. It has no `t` and MUST NOT gain one: it runs from a click
  handler and from the unit tier, and an English "The words" heading over German
  prose is worse than a blank line. The shape carries the structure, and a
  contrast row is `Aspect: term = cell`, one line per cell.
  `tests/unit/explanation-text.test.ts` asserts the headings stay absent.
- The copy control is `app/components/copy-text-button.tsx`. Every string is a
  prop, the clipboard is probed in a MOUNT EFFECT (see
  [[translate-env-probe-needs-a-mount-effect]]), and a refused clipboard raises
  `toast.error` rather than being swallowed.

- The waiting copy is phased by the SHARED machine: `explainWaitingKey` takes a
  `TranslationWaitPhase` from `translationPaneWaitPhase`, and this screen owns
  only the three sentences. No second timer, see
  [[translation-wait-phases-ride-the-tick-counter]].

See [[the-ask-log-is-the-reader-half-of-explain]].
