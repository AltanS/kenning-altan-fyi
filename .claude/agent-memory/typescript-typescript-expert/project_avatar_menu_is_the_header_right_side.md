---
name: avatar-menu-is-the-header-right-side
description: The kenning app shell header's right side is one avatar dropdown; the theme cycle button survives only in the public shell, and both read one hook
metadata:
  type: project
---

`app/components/avatar-menu.tsx` is the ONLY control on the right of the app
shell header (`app-wrapper.tsx`), at every breakpoint. `AccountSlot` and the
`<ThemeToggle />` slot are gone from that file, and so is the
`max-w-[40%]`/`min-w-0` cell that existed only to stop a raw email address
overrunning the screen title on a 390px phone.

`app/components/theme-toggle.tsx` still exists and is still the cycle button,
but `public-wrapper.tsx` is its one caller now.

**Why:** two controls now offer the theme, so the state had to leave the
component. `app/hooks/use-theme-preference.ts` owns it: `THEME_DETAILS` (keyed,
so an active-theme lookup is total and needs no fallback), `THEME_ORDER`,
`THEME_OPTIONS` derived from the two, `nextTheme`, `isTheme` and
`useThemePreference` returning `{ theme, hydrated, selectTheme }`. `themeSchema`
carries `.catch('system')`, so it can never be the guard for a Radix callback:
`isTheme` is, because an unknown value must be REFUSED there, not defaulted.

**How to apply:** add a header-chrome affordance to `avatar-menu.tsx`, not to
`app-wrapper.tsx`. Never give a control its own `useState` over
`localStorage.theme`. The foot of the menu is deliberately empty, a build stamp
is planned there. See [[avatar-menu-door-resolver]].
