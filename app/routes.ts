import { type RouteConfig, route, layout, index } from '@react-router/dev/routes';

export default [
  // =============================================================================
  // Public Routes (No Auth Required)
  // =============================================================================
  route('/healthcheck', 'routes/healthcheck.ts'),

  // =============================================================================
  // REST API v1 (Bearer token auth, JSON only)
  // =============================================================================
  route('/api/v1/api-keys', 'routes/api.v1.api-keys.ts'),
  route('/api/v1/api-keys/:id', 'routes/api.v1.api-keys.$id.ts'),
  // The `workflows`, `users`, `orgs`, `data-sources` and `metric-events`
  // endpoints stood here until M189 (ADR-0010). The workflow TABLES live on,
  // because enrichment writes them and the CLI reads them; the REST surface
  // over them had no caller at all.

  // The product's own verb, over the API (M195/03). ONE endpoint answers a word
  // and a sentence, and the body carries no `kind`: the branch is decided by the
  // same `normalizeQuery` call the search loader makes, so the API and the
  // screen can never disagree about what a phrase is. It is a bearer-token route
  // rather than a session one because its caller is a script or the CLI, not a
  // fetcher inside a rendered page, which is the same line `/api/v1/transcribe`
  // sits on the other side of.
  route('/api/v1/translate', 'routes/api.v1.translate.ts'),
  // The operator's complaint queue, the rows `/super/llm` renders. Superadmin
  // only: a score is an operator's instrument here, never public data.
  route('/api/v1/translation-votes', 'routes/api.v1.translation-votes.ts'),

  // DB admin endpoints (superadmin only)
  route('/api/v1/admin/db/check', 'routes/api.v1.admin.db.check.ts'),
  route('/api/v1/admin/db/pool', 'routes/api.v1.admin.db.pool.ts'),
  route('/api/v1/admin/db/tables', 'routes/api.v1.admin.db.tables.ts'),
  route('/api/v1/admin/db/describe/:table', 'routes/api.v1.admin.db.describe.$table.ts'),
  route('/api/v1/admin/db/query', 'routes/api.v1.admin.db.query.ts'),

  // =============================================================================
  // The synced personal document (M191)
  // =============================================================================
  // One resource route, no UI. Sign-up, sign-in and the two mailed links are
  // ordinary page routes with server actions now: the browser derives nothing
  // and posts a form, so there is no client-side ceremony for a JSON endpoint
  // to serve. The endpoints that served it, `/api/v1/auth/*` and
  // `/api/v1/sync/key-records`, went with the encrypted layer.
  route('/api/v1/sync/blob', 'routes/api.v1.sync.blob.ts'),

  // Voice input's server half: a recorded clip in, a line of text out. It sits
  // under `/api/v1/` for the flat naming, NOT for the bearer token: the caller
  // is a browser with no Web Speech API, not an API client.
  //
  // GATED INLINE since M184, by its own account check rather than by a layout:
  // it is a resource route with no chrome and it must answer a refusal in JSON,
  // because a `fetch` cannot make sense of a redirect to a sign-in page. The
  // per-IP and per-session hourly limits and the daily budget cap all stay
  // behind that check, as defence in depth.
  route('/api/v1/transcribe', 'routes/api.v1.transcribe.ts'),

  // What build this server is running. PUBLIC and unauthenticated, like
  // `/healthcheck` and unlike every other `/api/` route here: its caller is the
  // update ribbon in the app shell, which has to work for a reader who is
  // signed out as much as for one who is not, and its answer names nobody. It
  // sits outside `/api/v1/` because it is not part of the bearer-token REST
  // surface an API client talks to.
  route('/api/build', 'routes/api.build.ts'),

  // Public and read only, unlike the bearer-token `/api/v1/*` routes above.
  route('/api/enrichment/:headwordId', 'routes/api.enrichment.$headwordId.ts'),

  // A public POST, gated by the SESSION rather than by a bearer token: the
  // caller is a fetcher inside an already-rendered entry page, not an API
  // client. The path deliberately sits BESIDE `/api/enrichment/`, not under it:
  // as `/api/enrichment/vote` it would be shadowed by the `:headwordId` dynamic
  // segment above and every vote would reach the poll loader instead.
  route('/api/enrichment-vote', 'routes/api.enrichment-vote.ts'),

  // The translation pane's two halves (M193/02). The GET is public and read
  // only, exactly like `/api/enrichment/:headwordId`: it reports where a pair
  // stands and never enqueues, because the pane polls it every three seconds.
  // The retry POST is the only other place a translation run is ever started,
  // and it carries `authMiddleware` in the file: it spends money, so it needs an
  // account, and under `/api/` that middleware refuses with a 401 in JSON rather
  // than a redirect a `fetch` could not act on.
  //
  // THE RETRY PATH SITS UNDER THE DYNAMIC SEGMENT, NOT BESIDE IT, and that is
  // safe here where `/api/enrichment-vote` was not: `retry` is a THIRD segment,
  // so it cannot be swallowed by `:headwordId`, which matches exactly one.
  // The vote on ONE translated word (M194/03). It sits BESIDE `/api/translation/`
  // for the reason the enrichment vote sits beside `/api/enrichment/`: as
  // `/api/translation/vote` the `:headwordId` segment below would swallow it and
  // every vote would reach the poll loader instead of the action.
  route('/api/translation-vote', 'routes/api.translation-vote.ts'),
  // The reader's own search log, written from the screen that ran the search.
  // Session-authenticated, like every other fetcher route here: its caller is a
  // component inside a rendered page, not a script. The two screens that RENDER
  // the log read it through their own loaders, so this path only writes.
  route('/api/search-history', 'routes/api.search-history.ts'),

  route('/api/translation/:headwordId', 'routes/api.translation.$headwordId.ts'),
  route('/api/translation/:headwordId/retry', 'routes/api.translation.$headwordId.retry.ts'),
  // Where a reader says the generated answer is wrong (M197). A THIRD segment,
  // like `retry` above and for the same reason: `:headwordId` matches exactly
  // one segment, so this path cannot be swallowed by it. It carries
  // `authMiddleware` in the file too, because it records a row against an
  // account and may order a paid re-run.
  route('/api/translation/:headwordId/reject', 'routes/api.translation.$headwordId.reject.ts'),

  // The same two halves for a typed SENTENCE (M195/01). Both sit BESIDE
  // `/api/translation/`, for the reason the vote route does: as
  // `/api/translation/phrase` the `:headwordId` segment above would swallow them
  // and every poll would reach the word loader. Both carry `authMiddleware` in
  // the file, and the GET is gated where the word poll is public: no public
  // surface serves a translated sentence, so an ungated read here would be a way
  // to reach this installation's paid answers without ever signing in.
  route('/api/translation-phrase', 'routes/api.translation-phrase.ts'),
  route('/api/translation-phrase/retry', 'routes/api.translation-phrase.retry.ts'),

  // The same two halves for a typed QUESTION (M198). Both carry
  // `authMiddleware` in the file, for the reason the phrase pair does: no public
  // surface serves an explanation, so an ungated read here would be a way to
  // reach this installation's paid answers without ever signing in. The retry
  // path sits under the `/api/explain` prefix as a SECOND segment, and nothing
  // dynamic stands above it, so there is no segment for it to be swallowed by.
  route('/api/explain', 'routes/api.explain.ts'),
  route('/api/explain/retry', 'routes/api.explain.retry.ts'),
  // The vote on ONE written explanation (M200/02). Flat, beside the other two
  // vote paths rather than under `/api/explain/`, for the reason they are flat:
  // a vote is an action on a row the reader already has, not a second read of
  // the question, and keeping the three votes side by side is what makes it
  // obvious they share a gate and a shape.
  route('/api/explanation-vote', 'routes/api.explanation-vote.ts'),

  // =============================================================================
  // App Shell (sidebar, mobile drawer, bottom tab bar)
  // =============================================================================
  layout('routes/_app.tsx', { id: '_app' }, [
    // ── The public half of the shell ────────────────────────────────────
    // Everything directly under `_app` renders for a signed-out visitor. The
    // gated half is the `_app.gated.tsx` block below, and the nesting is what
    // classifies a route: `app/lib/route-classification.ts` records the same
    // fact in one readable place, and a unit test fails when a route file
    // exists in neither.
    //
    // IT IS A SHORT LIST SINCE M199. The front door a stranger meets is
    // `/welcome`, in the `_public` layout at the foot of this file, and it is
    // a small card with no sidebar, no language bar and no mode switch. Until
    // then a signed-out visitor was handed the whole app shell around a
    // screen on which every control refused them.
    //
    // THE INDEX IS STILL HERE, AND IT IS NO LONGER OPEN. A route can only sit
    // in ONE layout, and `/` has to keep the app shell for the reader who is
    // signed in, so it cannot move into the gated block the way the alias
    // below did. Its rule is therefore the request-keyed one at the top of
    // `routes/translate.tsx`'s loader, and it now refuses a signed-out caller
    // twice over: an empty `q` goes to `/welcome`, any other `q` goes to
    // `/sign-in?next=` so a shared result link still lands on its result.
    index('routes/translate.tsx'),
    // `/search` is the route id `/translate` carried until earlier today. A
    // rename is invisible to a tab already open, a bookmark, or a `?next=`
    // already in flight from the account gate, so all three landed on a 404
    // the moment the rename shipped. This one hop, `301`, keeps the query
    // string: see `routes/search-redirect.ts`.
    route('/search', 'routes/search-redirect.ts'),
    // The two doors, inside the app shell rather than in `_public`, because a
    // visitor arriving at one is already looking at the product. Both stay
    // PUBLIC: they are the front door a stranger walks through, and a
    // gate in front of the sign-in page is a gate nobody can ever pass.
    //
    // THE PATHS NAME THE ACCOUNT, NOT THE SYNC. They were `/sync/setup` and
    // `/sync/login` until M189, which asked a newcomer to configure a feature
    // before they had an account for it to apply to. Sync is a consequence of
    // holding an account, never a thing a reader sets up. The two redirect hops
    // that kept the old paths alive went with the invite links they preserved
    // (M191): an invite token was the only reason a query string had to survive
    // a hop, and there are no invites now.
    // The five doors live OUTSIDE this shell, under `_auth-shell` below. The
    // sidebar this layout opens is 256px wide for everybody, and a card
    // centred inside the remaining column sits 128px right of the viewport
    // centre, which a browser walk measured on 2026-09-04.
    //
    // POST only, and it has no component, so it needs no chrome. Its loader
    // answers a GET with a redirect and changes nothing, because a URL that
    // signs you out is a URL an image tag can visit. Its `clientAction` is what
    // empties the device, which is why signing out is a route of its own rather
    // than an intent on `/account`.
    route('/sign-out', 'routes/sign-out.tsx'),
    // Public, and it reports the signed-out state rather than ending it. Its
    // loader already answers `null` for an anonymous visitor and never
    // redirects, which is the contract a public account screen needs.
    route('/account', 'routes/account.tsx'),
    // Inside `_app` so the offline fallback carries the same chrome as the
    // other shell routes the service worker precaches. It has no loader and no
    // action, so it renders with no network at all, which is also why it can
    // never be gated: a session cannot be resolved with the network off.
    route('/offline', 'routes/offline.tsx'),

    // ── The gated half (M184, ADR-0009) ─────────────────────────────────
    // A pathless layout carrying `authMiddleware`. Every route in here has
    // NO public surface to preserve, so a layout-level redirect is the right
    // shape for it. See `routes/_app.gated.tsx` for why the middleware cannot
    // sit on `_app.tsx` itself.
    layout('routes/_app.gated.tsx', { id: '_app_gated' }, [
      // `/translate` renders the SAME module as the index route above, under a
      // second id. React Router's typegen emits ONE `+types/translate` whose
      // `Matches` is a union of both ids. `/search` WAS this route's id until
      // M187, and an open tab, a bookmark and a `?next=` in flight all still
      // pointed at it, so it redirects rather than 404ing (see the public half
      // above).
      //
      // THE ALIAS IS GATED FROM HERE SINCE M199, AND THE INDEX IS NOT. That
      // asymmetry is deliberate and it is not a hole. `/translate` has no
      // public half left to preserve: the screen a signed-out visitor is owed
      // is `/welcome`, and nobody reaches the alias without already knowing
      // the product. The index cannot follow it in, because a route sits in
      // one layout and `/` must stay inside the app shell for the reader who
      // is signed in. The rule that refuses a stranger at `/` therefore stays
      // in the shared loader, where it is keyed on the REQUEST: this layout is
      // a SECOND gate over one of the two ids, never the only one. Deleting
      // the loader rule and trusting this line would reopen `/?q=`, which is
      // the exact hole M184 exists to close.
      route('/translate', 'routes/translate.tsx', { id: 'translate-alias' }),
      // The translator's sibling (M198): a free-text question about words, in,
      // and a structured explanation out. GATED BY THIS LAYOUT since M199. It
      // sat in the public half until then, on the argument that its empty-`q`
      // state was a landing screen a stranger could read for free; `/welcome`
      // is that screen now, and it says the same thing in one card instead of
      // in the whole app shell. The request-keyed rule inside `explain.tsx`'s
      // own loader is left exactly as it was: it is redundant under this
      // layout and it is harmless, and it is the thing that still holds if the
      // route is ever moved back out.
      route('/explain', 'routes/explain.tsx'),
      // What this reader has asked, and one page per question (M198). The rows
      // live in `explanation_asks`, which carries the reader; the ANSWERS live
      // in the readerless `explanations` ledger and are joined on the cache key
      // the two already share. Gated like every other personal screen, and here
      // the gate is doing real work: these rows are free text a person typed.
      route('/explanations', 'routes/explanations.tsx'),
      route('/explanations/:id', 'routes/explanations.$id.tsx'),
      route('/entry/:headwordId', 'routes/entry.$headwordId.tsx'),
      route('/attribution', 'routes/attribution.tsx'),
      route('/lists', 'routes/lists.tsx'),
      // Client only, like `/lists` itself: it reads the device's own store and
      // has no server loader, so it works with the network off. The service
      // worker does not precache it, so a HARD reload here while offline lands
      // on `/offline`; an in-app navigation from `/lists` does not.
      route('/lists/:listId', 'routes/lists.$listId.tsx'),
      // The flashcard loop over one list. Client only for the same reasons, and
      // for one more: a review session must not stall on a fetch between cards.
      route('/lists/:listId/review', 'routes/lists.$listId.review.tsx'),
      // The daily nudge's session. The three words it picks come from ANY list,
      // so there is no list id to hang them off: the entry ids travel in
      // `?entries=`, and the screen resolves them against the device's own store.
      route('/review', 'routes/review.tsx'),
      // Client only for the same reason `/lists` is: the rows are in this
      // device's own store. They SYNC, unlike history, but the server holds
      // them as one opaque document and never as rows, so there is still
      // nothing here for a server loader to read.
      route('/favourites', 'routes/favourites.tsx'),
      route('/history', 'routes/history.tsx'),
      route('/settings', 'routes/settings.tsx'),
    ]),
  ]),

  // =============================================================================
  // The account doors (M191/03)
  // =============================================================================
  // The same viewport-centred chrome `/legal/*` uses, and no navigation
  // sidebar. See `routes/_auth-shell.tsx` for why these five are not in the app
  // shell, and why `/account` still is.
  //
  // ALL FIVE ARE PUBLIC AND ALL FIVE MUST BE. A reader creating an account has
  // no session, a reader clicking a confirmation link has none by definition,
  // and a reader clicking a reset link has one they cannot use. A gate in front
  // of any of them is a gate nobody can ever pass.
  layout('routes/_auth-shell.tsx', { id: '_auth_shell' }, [
    route('/sign-up', 'routes/sign-up.tsx'),
    route('/sign-in', 'routes/sign-in.tsx'),
    route('/verify-email', 'routes/verify-email.tsx'),
    route('/forgot-password', 'routes/forgot-password.tsx'),
    route('/reset-password', 'routes/reset-password.tsx'),
  ]),

  layout('routes/_public.tsx', { id: '_public' }, [
    // The front door (M199). One card: what this product does, then the two
    // doors. It is in `_public` and not in the app shell on purpose, and that
    // is the whole change: a stranger used to be handed the sidebar, the
    // language bar, the mode switch and the input card, and could operate none
    // of them. This layout has no navigation at all, so there is nothing on
    // screen here that refuses the reader looking at it.
    //
    // ITS LOADER SENDS A SIGNED-IN READER TO `/`. It refuses nobody: it
    // answers a question the reader has already finished, exactly as
    // `/sign-in` and `/sign-up` do.
    route('/welcome', 'routes/welcome.tsx'),

    // The three legal documents, all under `/legal/` rather than at the root.
    // One prefix keeps them together in a sitemap, in a footer and in a link
    // somebody pastes into a support thread, and it leaves the root namespace
    // to the product. `/terms` and `/privacy` used to sit at the root carrying
    // the ts-factory-stack boilerplate, which described accounts, payment
    // processors and profile data this product does not have; nothing links to
    // the old paths, so they are gone rather than redirected.
    route('/legal/imprint', 'routes/legal/imprint.tsx'),
    route('/legal/privacy', 'routes/legal/privacy.tsx'),
    route('/legal/terms', 'routes/legal/terms.tsx'),

    // The public browse section (M200): answered questions anyone may read,
    // signed in or not. It is in `_public` rather than in the app shell for the
    // reason `/welcome` is: the shell's sidebar offers lists, favourites and
    // history, every one of them a dead end for a stranger. The two doors sit
    // in the page's own body instead.
    //
    // ABOVE THE CATCH-ALL, because `route('*')` below matches everything and a
    // route registered after it never runs.
    //
    // `:id` HERE IS `explanations.id`, a different id space from the private
    // `/explanations/:id`, which addresses the reader's own ask log. The file
    // names differ by the `browse.` prefix on purpose.
    route('/browse/explanations', 'routes/browse.explanations.tsx'),
    route('/browse/explanations/:id', 'routes/browse.explanations.$id.tsx'),

    // Catch-all: unmatched URLs get 404 inside the layout
    route('*', 'routes/$.tsx'),
  ]),

  // =============================================================================
  // Superadmin Routes (operator screens, no organization anywhere)
  // =============================================================================
  // A TOP-LEVEL LAYOUT SINCE M189. It used to nest under `_auth.tsx`, which
  // demanded a linked `users` row on top of the account session; that file and
  // the whole org surface below it are gone, so `_super.tsx` now carries the
  // account resolution and the superadmin check itself.
  layout('routes/_super.tsx', { id: '_super' }, [
    // `/super` is a hop, not a screen. Three screens live here now, and a bare
    // `/super` redirects to `/super/llm` rather than answering a 404.
    route('/super', 'routes/super/index-redirect.ts'),
    // The model configuration enrichment reads out of `app_settings`.
    route('/super/llm', 'routes/super/llm.tsx'),
    // The moderation queue for the public browse pages (M200): what readers
    // have reported, and what has been taken down. A hide is written against
    // the question's own cache key, so the ledger row itself is never touched.
    route('/super/explanations', 'routes/super/explanations.tsx'),
    // What the server believes the caller's IP is, for checking the
    // `TRUST_PROXY` hop count against a live reverse proxy.
    route('/super/whoami-ip', 'routes/super/whoami-ip.tsx'),
  ]),
] satisfies RouteConfig;
