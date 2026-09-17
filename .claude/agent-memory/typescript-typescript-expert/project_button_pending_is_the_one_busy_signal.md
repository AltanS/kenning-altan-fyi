---
name: button-pending-is-the-one-busy-signal
description: Button's `pending` prop draws the spinner, disables and sets aria-busy together, and is ignored under asChild because Slot takes one child
metadata:
  type: project
---

`app/components/ui/button.tsx` takes `pending?: boolean`. It renders `Loader2`
(`size-4 animate-spin`) before the children, sets `disabled` and sets
`aria-busy`. The caller still owns the LABEL.

**Why:** the three were hand-rolled separately at several call sites, which let
a spinner sit beside a still-clickable button and invited a second submit of the
work already in flight.

**How to apply:** never write `{pending && <Loader2 .../>}` beside a Button
again, pass `pending`. Under `asChild` the prop is IGNORED on purpose: `Slot`
renders the caller's own element and a injected spinner would hand it two
children, which Slot refuses at runtime. The `asChild` branch is a separate
early return in the component for exactly that reason.

See [[search-panes-card-recipe-must-stay-a-literal]].
