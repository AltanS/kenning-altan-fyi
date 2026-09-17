---
name: language-bar-labels-and-allow-detect
description: LanguageBar always renders a label per select, sr-only since the M200 density pass, drops aria-label for aria-labelledby, and takes allowDetect=false on the explain screen
metadata:
  type: project
---

`app/components/language-bar.tsx` renders a LABEL over each select, always. The
optional `labels?: { source, target }` prop only changes the words; omitted, it
reads `search.fromLabel` / `search.intoLabel` ("From" / "Into"), so the translate
screen gained visible labels with no call-site change.

**Why:** the two sides mean different things on different screens. On `/explain`
the target is the language the answer is WRITTEN IN, and that was a line of prose
under the question box that nobody connected to a control two blocks above it.
`/explain` passes `explain.wordsIn` / `explain.explainIn`.

**How to apply:**
- The labels were CELLS OF THE SAME `grid-cols-[1fr_auto_1fr]`, with an empty
  `aria-hidden` middle spacer. That is REVERSED: `LABEL_RECIPE` is now the bare
  string `'sr-only'` and the spacer cell is deleted, so the grid is one row of
  three controls. The `<label>` elements themselves must stay, because the two
  triggers name themselves with `aria-labelledby` pointing at them; deleting
  them leaves two unnamed dropdowns. With nothing visible there is nothing left
  to align, which is why the old cell argument no longer applies.
- The triggers now carry `aria-labelledby`, not `aria-label`. Radix renders each
  as a button, `<label htmlFor>` on a button is not reliably its name, and two
  names on one control is how a screen reader announces something the screen does
  not say.
- `allowDetect={false}` drops the "Detect language" option and leaves the swap
  button always enabled. `/explain` passes it, because detection reads the TYPED
  TEXT and the typed text there is a question in the reader's own language about
  words in another one, so a detector would answer about the wrong side.
- A stored pair can still say `detect` on that screen.
  `app/lib/translation/explain-source-language.ts` turns it into a real code (UI
  language, else `de`) for the bar, the mode switch and the example chips.
  Rendered unchanged it would be a select with no matching option and a submitted
  `from=detect`.
