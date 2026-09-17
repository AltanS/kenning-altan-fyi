---
name: item-actions-menu-is-the-per-item-surface
description: Kenning's per-item actions live in app/components/item-actions-menu.tsx as four row KINDS; a confirm row needs onSelect preventDefault and a non-modal dropdown
metadata:
  type: project
---

`app/components/item-actions-menu.tsx` is the ONE overflow control behind every
per-item action (explanations list and detail, favourites, lists, list entries).
The caller describes rows as DATA, four kinds: `link`, `button`, `copy`,
`confirm`. `resolveItemActions` is the pure part, it drops `null` rows and moves
destructive rows last, and it is unit tested in
`tests/unit/item-actions-menu.test.ts` with no DOM.

Two mechanics that are easy to get wrong:

- A `ConfirmAction` nested in a menu row needs
  `onSelect={(event) => event.preventDefault()}` on the `DropdownMenuItem`, or
  Radix unmounts the closed dropdown's content and tears the dialog down in the
  frame it opened.
- The dropdown root is `modal={false}`. A modal dropdown locks body pointer
  events and its cleanup races the dialog's, which can leave the page unclickable.

**Why:** the four-button band on `/explanations/:id` stacked full width below
`sm` and pushed the answer off a phone screen.

**How to apply:** a new screen with per-item actions uses this component, never
a fresh row of buttons. The trigger's `aria-label` must NAME the item, because
the visible button name is gone. A shared row component like
`saved-word-row.tsx` takes the menu as `trailing`, it never owns one, see
[[search-panes-card-recipe-must-stay-a-literal]] for the sibling rule about
shared row markup.
