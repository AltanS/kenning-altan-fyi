---
name: nav-catalog-carries-requires-account
description: requiresAccount on a nav entry drives visiblePrimaryNavigationItems; BottomNav returns null signed out and AppWrapper's bottom padding follows it
metadata:
  type: project
---

`app/components/app-sidebar.tsx` is the one nav catalog. Two filters read it:
`visibleFooterNavigationItems(isSuperadmin)` and, since the signed-out rail
landed, `visiblePrimaryNavigationItems(isSignedIn)` over a `requiresAccount?: true`
flag. Every primary entry carries the flag today.

**Why:** a signed-out reader was offered six rows that all end at `/sign-in`,
the same defect `/welcome` fixed for the home page. The flag DESCRIBES the
destination; `accountMiddleware` on `_app.gated.tsx` is still the only gate.

**How to apply:** all three surfaces read `userId` from the ROOT loader
(`useRouteLoaderData<{ userId: number | null }>('root')`, a presence check).
`BottomNav` returns `null` when it is null, and `AppWrapper`'s content bottom
padding must follow the same condition: the `pb-[calc(env(safe-area-inset-bottom)+5rem)]`
reserve is a contract with the bar, so leaving it on a barless screen shows as a
gap above the legal footer. Tab order is Translate, Explain, Lists, Favourites;
History has no `tab` any more and lives in the drawer and sidebar only.
