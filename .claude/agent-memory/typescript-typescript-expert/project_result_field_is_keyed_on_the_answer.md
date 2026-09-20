---
name: result-field-is-keyed-on-the-answer
description: ResultField in search-panes.tsx is keyed on the answer text, so anything under the translation pane that must outlive an answer change belongs in useTranslationPane
metadata:
  type: project
---

`search-panes.tsx` renders `<ResultField key={resultText} ...>`, where `resultText` is the PRIMARY lemma. Any state held by a component inside `body` is destroyed the moment the answer changes, including the change from a word to the empty string when the pane goes back to `translating`.

**Why:** the key exists so a new answer arrives with a fresh copy button rather than one still reading "Copied".

**How to apply:** a confirmation that has to survive its own mutation, such as the rejection control's "Asking again now" after a re-run is queued, must live in `useTranslationPane` and reach the markup through the controller. Local `useState` inside a child of the pane is fine only for something that SHOULD reset with the answer, such as an open-or-closed disclosure. Related: [[one-answer-is-the-answer-the-rest-are-alternatives]].
