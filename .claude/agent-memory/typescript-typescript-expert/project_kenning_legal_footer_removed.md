---
name: kenning-legal-footer-removed
description: The app shell's per-page legal footer was tried and removed 2026-09-17; settings.tsx's LegalLinksCard is now the sole home for imprint/privacy/terms links
metadata:
  type: project
---

`AppWrapper` (`app/components/app-wrapper.tsx`) used to render a `LegalFooter`
component (imprint + privacy links, `legal` i18n namespace) on every signed-in
screen, right before `<BottomNav />`. It was deleted 2026-09-17.

**Why:** the user decided a footer repeated on every page was noise, not
access — the sidebar/tab bar are places a person USES, and a link nobody taps
99% of the time doesn't earn a permanent slot there. `/settings` already had
`LegalLinksCard` (`app/routes/settings.tsx`) with all three links (imprint,
privacy, terms) and is where a reader already goes to see what the app does
with their data, so that card is now the ONLY place these links live in the
signed-in shell.

**How to apply:** if asked to touch legal-link placement in this repo again,
don't re-add a shell-wide footer without checking with the user first — it was
tried and explicitly rejected. `app/routes/legal/page-links.tsx`
(`LegalPageLinks`, the cross-link strip at the bottom of the imprint/privacy/terms
documents themselves) and `app/components/landing.tsx`'s privacy link are a
different, still-live surface — don't confuse the two when grepping for "legal"
UI. The bottom padding in `InnerContent`
(`pb-[calc(env(safe-area-inset-bottom)+5rem)]`) is unrelated to the footer; it
clears `BottomNav` and must not be touched when this kind of change comes up
again.

See also [[project_kenning_translate_altan_fyi_decisions]] if that memory
exists — this repo is Kenning (formerly translate.altan.fyi).
