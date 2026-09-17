---
name: kenning_theme_color_is_script_owned
description: root.tsx's theme-color meta tag must never be rendered in JSX; React 19 re-creates a JSX metadata tag during hydration and strands the boot script's mutation
metadata:
  type: project
---

`app/root.tsx`'s `<meta name="theme-color">` is entirely script-owned inside the
inline boot script's `applyTheme()`. It is never rendered in `Layout`'s JSX.

**Why:** React 19 hoists `<meta>` tags rendered in JSX into its own metadata
handling and RE-CREATES them during hydration, which runs AFTER the pre-paint
boot script. The app used to render a light/dark media-scoped pair in JSX and
have `applyTheme` mutate `content` and strip `media` on boot. Measured in a real
browser with the app theme set to dark: hydration re-created the light tag from
its ORIGINAL JSX props, leaving three tags in the DOM — two correct dark ones
plus a stray `#ffffff` light one the script could never reach again, since it
ran before that tag existed. That stray tag painted a white status-bar band
above the dark installed Android PWA.

**How to apply:** `applyTheme()` does `document.querySelector('meta[name="theme-color"]')`,
creates+appends one via `document.createElement` if absent, and sets only
`content` — it must never set `media`, because the app's own theme is the
authority, not the OS's. If a future change wants a pre-script OS-colour
fallback again, it cannot be a rendered JSX tag mutated post-render; it would
need a different mechanism entirely (e.g. an inline non-React DOM write before
hydration). The two hexes (`#0a0a0a` dark, `#ffffff` light) must stay in sync in
exactly two places: `--background` in `app.css`, and the `color` variable inside
`applyTheme`. Related: [project_kenning_build_stamp](project_kenning_build_stamp.md).
