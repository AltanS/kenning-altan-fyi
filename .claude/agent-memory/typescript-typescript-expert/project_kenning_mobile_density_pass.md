---
name: kenning-mobile-density-pass
description: The phone chrome is one 56px header whose drawer trigger IS the KenningMark, the language-bar labels are sr-only, and ModeSwitch is the one control allowed under 44px. The header's height is `min-h-14 md:min-h-16`, never a bare `min-h-14`
metadata:
  type: project
---

The M200 density pass on the translate screen, as a set of rules that outlive it.

**The header is one line, and its height is `min-h-14 md:min-h-16`, never a
bare `min-h-14`.** No wrapping flex column, no mobile wordmark eyebrow and no
separate mark-`<Link to="/">`. `NavDrawer`'s `SheetTrigger` renders
`<KenningMark className="size-7" />` instead of the `Menu` lucide icon, so one
control carries both the brand and the menu. The bottom nav's first tab is the
way home. The `md:min-h-16` half is load-bearing, not decorative: at md and up
`AppSidebar` is on screen with its own `SidebarHeader` fixed at `h-16`, and
both headers close on the same `border-brand-ink/20` hairline, which is meant
to read as ONE line across the chrome. A bare `min-h-14` (56px) shortens the
phone line correctly but also shortens it at md, where the sidebar's header
stays 64px — the two hairlines then sit 8px apart. This regressed once
already (`app/components/app-wrapper.tsx`, fixed 2026-09-17): the M200 pass
shortened the header for the phone and dropped the `md:` override, so the
desktop-width case was untested against the sidebar it has to line up with.
Check both breakpoints in the browser, not just the phone width, whenever this
header's height changes.

**`KenningMark` takes `className` and nothing else, and it NAMES ITSELF**
(`aria-label={APP_NAME}` plus a `<title>`). Inside a labelled button the
`aria-hidden` therefore goes on a `<span className="contents">` wrapper, never
as a prop on the mark.

**`Button`'s base sets `[&_svg:not([class*='size-'])]:size-4`.** Any icon
bigger than 16px must carry its own `size-*`, or it is silently shrunk.

**`ModeSwitch` is `h-10` and it is the exception.** DESIGN.md's 44px rule names
the two selects, the swap button and the submit button. It does not name this
one, because those four act on what was typed and this one only navigates
between two screens. Do not read the 40px as licence to shrink the four.

**The two translator cards are `rounded-2xl border p-4`.** They still have to be
byte-identical: see [[search-panes-card-recipe-must-stay-a-literal]].
`explain-panes.tsx` mirrors `p-4` and the switch's `mb-3`, but NOT `rows`, the
label treatment or the note size, because its box has a `field-sizing-content`
floor of two rows and a counter rather than a note.

**A `VoiceControl` status line needs `empty:hidden`.** The `<output>` is empty at
rest but still took a line box plus the column `gap-2`, which pushed the mic
button ~10px above the submit button in the `items-center` row beside it. Never
unmount it: a live region has to exist before its content changes.
`ServerVoiceControl`'s own `<output>` has text in every one of its states, so it
does not carry the class.

Related: [[translator-surface-is-one-column]],
[[language-bar-labels-and-allow-detect]].
