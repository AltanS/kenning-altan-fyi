---
name: project-header-account-slot-truncation
description: The shell header's account address needs min-w-0 on the link AND the text, and its percentage cap belongs on the cell, not on the link
metadata:
  type: project
---

In `app/components/app-wrapper.tsx` the account slot is
`flex min-w-0 max-w-32` with `min-w-0 truncate` on the address span, and the
cell around it (`AccountSlot` + `ThemeToggle`) carries
`min-w-0 max-w-[40%] sm:max-w-none`, with the toggle in a `shrink-0` wrapper.

**Why:** `max-w-32` alone did not hold. A flex item does not shrink below its
own content unless it is told to, so `truncate` never acted and at 390px the
address ran into the screen `h1` on `/explanations/:id`. The percentage sits on
the CELL because that cell's parent is the header's `flex-1` row, which has a
definite width; on the link inside it a percentage has nothing to resolve
against.

**How to apply:** keep the link visible below `sm` rather than hiding it. It is
the only thing saying which account the device carries, and the drawer's
account row is two taps away, which is not the same thing. The longest title it
must survive is `nav.explanations`, "Explanations".
