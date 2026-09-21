---
name: translate-alternative-chip-usethisshort
description: the alternative-lemma button grew a visible "Use this" chip beside the underlined word, and copy-all grew a visible label; lang moved off the button onto the lemma span alone
metadata:
  type: project
---

Follow-up to [[translate-primary-answer-and-alternatives]]. The alternative
row's `<button onClick={() => controller.choose(...)}>` used to render ONLY
the underlined `row.lemma` with an invisible `aria-label`; testers upvoted the
word instead of tapping it. Fixed by wrapping two children in the button:
`<span lang={to} className="font-mono ... underline ...">{row.lemma}</span>`
plus a visible pill `<span className="inline-flex items-center rounded-full
bg-muted px-2 py-0.5 text-xs text-muted-foreground ...">{t('translation.useThisShort')}</span>`,
both inside a `group` wrapper so `group-hover:` drives both children. `lang={to}`
moved from the button onto the lemma span alone — the chip is UI-language text
("Use this" / "Diese verwenden"), not the foreign word, so it must not carry a
`lang` override meant for the target language.

The vote control (`votesFor(row)`) stays a SIBLING of this button inside
`TranslationLine`'s wrapper `<div>`, never nested inside it — nesting a button
inside a button is invalid markup and was already called out in the block
comment before this change; the restructure preserved that.

`CopyButton` (`search-panes.tsx`) gained an optional `visibleLabel?: string`.
`undefined` keeps `size="icon-sm"` (the plain per-answer copy button stays
icon-only, the universal convention needs no caption); a defined value switches
to `size="sm"` and prints `<span className="text-xs">{visibleLabel}</span>`
after the icon. Only the copy-ALL call site in `ResultField` passes one
(`t('translation.copyAllShort')`) — two unlabelled icon buttons side by side is
what confused a tester in the first place.

Both chips reuse `GeneratedMarker`'s pill recipe
(`rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground`), the
established convention for this kind of inline badge in this file.

Neither the input nor the answer card's own `className="rounded-2xl border p-4"`
was touched by this change (only children inside `ResultField` changed), so
[[search-panes-card-recipe-must-stay-a-literal]]'s literal-className test still
passes untouched.

New locale keys, both languages: `translation.useThisShort` / `copyAllShort`.
