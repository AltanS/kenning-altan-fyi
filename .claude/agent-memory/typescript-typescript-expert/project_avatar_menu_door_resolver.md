---
name: avatar-menu-door-resolver
description: The account row in kenning's avatar menu is chosen by an exported pure function, because the repo has no DOM test environment
metadata:
  type: project
---

`resolveAvatarMenuDoor({ isSignedIn }): 'sign-in' | 'sign-out'` is exported from
`app/components/avatar-menu.tsx` and asserted by
`tests/unit/avatar-menu-door.test.ts`.

**Why:** kenning's unit tier is `node --test` with no DOM, so a rule written as
`&&`s inside JSX is untestable here. A `.tsx` module CAN be imported by a unit
test (several already are), so the resolver stays beside its markup rather than
moving to `app/lib/`.

**How to apply:** sign-out is a `useSubmit(null, { method: 'post', action:
'/sign-out' })` from a `DropdownMenuItem`, never a `Link`: `/sign-out` answers a
GET with a harmless redirect and the POST is what runs its `clientAction`, which
is the step that wipes the device. If a third door state ever arrives (openplate
has four, keyed on instance policy), it lands in this function.
