# Repository Guidelines

## Project Structure

- `app/` — routes, components, models, utilities, workflows
- `drizzle/` — database schema, migrations, data migrations
- `cli/` — Laravel-style management commands
- `server.ts` — Express + React Router v8 SSR entry (dev **and** production; see [ADR-0004](.adr/0004-custom-server-is-the-production-entry.md))
- `.claude/` — AI assistant rules, skills, and commands
- `tools/oxlint/anti-slop/` — vendored third-party lint plugin, MIT (do not edit; provenance in [tools/oxlint/README.md](tools/oxlint/README.md))
- `.githooks/` — pre-commit lint gate and pre-push test gate, installed by the `prepare` script

### Translations on demand (M193)

The code: `app/lib/translation/*` (payload, limits, enqueue, panel resolver),
`app/lib/llm/translation-schema.ts`, `app/prompts/translation/`,
`app/workflows/operations/translation/translate-headword.ts`,
`app/models/translation-runs.server.ts`, `drizzle/schema/translation-runs.ts`,
`app/components/translation-pane.tsx`, the routes
`api.translation.$headwordId.ts` and `api.translation.$headwordId.retry.ts`,
and `cli/commands/translation.ts`. Tests: `tests/unit/translation-*.test.ts`,
`tests/integration/translation-*.test.ts`, and
`tests/integration/anonymous-search-enqueues-no-translation.test.ts`.

Two rules: never pass `reasoningEffort` in a `registry.complete` call here,
because OpenRouter rejects `none` for gemini-3.8-flash, and the active model's
own configured setting already applies. And the pane has exactly five states,
`ready`, `translating`, `no-entry`, `budget`, `failed`, with no "no translation
yet" copy anywhere on the search surface.

### A phrase translates like a word (M195)

The code: `drizzle/schema/phrase-translations.ts`, `app/prompts/phrase/`,
`app/lib/llm/phrase-schema.ts`, `app/lib/translation/phrase-panel.server.ts`
and its enqueue and payload siblings, `app/models/phrase-runs.server.ts`,
`app/workflows/operations/translation/translate-phrase.ts`, the routes
`api.translation-phrase.ts` and its retry, and for the outside world
`app/lib/translation/translate-request.server.ts`,
`app/routes/api.v1.translate.ts`, `app/routes/api.v1.translation-votes.ts`
and `cli/commands/translate.ts`.

Three rules. **A phrase answer is never dictionary data**: it lives in
`phrase_translations` and the job must not touch `senses`, `headwords` or
`translations`, because a sentence is not a lexical edge and one row of running
text would poison every corpus query M193 built. **The word and the phrase
branch are decided by one call**, `normalizeQuery(q, from).isPhrase`, in the
loader AND in the API, so the screen and the CLI can never disagree about what a
phrase is. **A text over `PHRASE_MAX_CHARS` is refused, never truncated**:
truncating would translate a sentence the reader did not type and present it as
their answer. This reverses M193 decision 8, which said a phrase creates
nothing.

### Explain (M198)

A third sibling of the translation pipeline: a free-text QUESTION about words
in, a structured explanation out. Same guard order, same pane states, same
run-record-is-the-cache table shape, same read/trigger split as the phrase path.

The code: `drizzle/schema/explanations.ts`, `app/models/explanations.server.ts`,
`app/lib/llm/explain-schema.ts`, `app/prompts/explain/`,
`app/lib/translation/explain-panel.server.ts` and its enqueue, payload and
pane-endpoint siblings, `app/workflows/operations/translation/explain-terms.ts`
with its template, the routes `explain.tsx`, `explanations.tsx`,
`explanations.$id.tsx`, `api.explain.ts` and `api.explain.retry.ts`, the reader's
own half in `drizzle/schema/explanation-asks.ts` and
`app/models/explanation-asks.server.ts`, and on the screen
`app/components/mode-switch.tsx`, `explain-panes.tsx`, `explain-pane.tsx`,
`explanation-card.tsx`, `explanation-body.tsx`, `copy-text-button.tsx` and
`explain-landing-hint.tsx`. Tests: `tests/unit/explain-schema.test.ts`,
`tests/unit/explain-panel-gate.test.ts`, `tests/unit/explain-waiting.test.ts`,
`tests/unit/explanation-text.test.ts` and
`tests/unit/explanation-asks-schema.test.ts`.

Four things to know. The ANSWER SHAPE is the feature: `explanationSchema` names
five parts, and its refinement is the only thing that can check that every
contrast row is as wide as the term header, so a crooked table is a failed run
rather than a crooked card. It has ITS OWN QUEUE, `explain-terms`, unlike the
phrase job which shares the word job's, because an explain call is the slowest
this app makes; a new queue needs its `stately` policy set in
`initializeWorkflows` or its singleton key dedupes nothing, silently. The PANE
STATE MACHINE is shared, not copied: `translationPaneReducer` is generic over
the ready payload and `NoInfer` pins it to the translator's own type unless a
caller says otherwise. And NOTHING IS LOGGED TO THE SEARCH HISTORY: a question
is not a search, and its table carries no reader at all.

Prompt v2 added `references`, up to three places the reader can go and read a
proper explanation. `title` and `locator` are required, `url` is not, and the
prompt says why: a model reliably knows that a word has a Duden entry and does
not reliably know its URL, so a guessed address is refused rather than risked.
`references` is `.default([])` at the schema, which is load-bearing: every row
written under v1 is re-parsed with the current schema on every read, and a
required field would turn every answer already paid for into a row that "does
not decode".

EVERY ASKED QUESTION IS STORED FOR THE READER, and the ledger still names
nobody. `explanation_asks` (`drizzle/schema/explanation-asks.ts`,
`app/models/explanation-asks.server.ts`) is the second table: one row per
`(user, from, to, question_normalized)`, upserted by `explain.tsx`'s loader after
the panel resolves and whatever the panel says, so a repeat MOVES `asked_at`
rather than adding a row. It is modelled on `search_history` down to its indexes.
The only thing that stops the write is the length cap, because a question over it
opens no run and could never be answered. `/explanations` lists this reader's
asks, twenty at a time, with the latest answer's first 140 characters beside each
one; `/explanations/:id` renders one, through the SAME `useExplainPane`
controller the inline card uses, so a pending, failed or refused run polls and
retries there too. Its loader resolves the panel READ-ONLY and can never enqueue:
opening an old question must not spend money. Every value on that page comes from
the stored row and only the id comes from the URL.

A local "saved explanations" collection was proposed here first and was retired
before it shipped: storing by default is strictly better than a keep button
almost nobody presses, and the device store then held a second copy of an answer
the server already had. `SCHEMA_VERSION` stays at 3 and the blob carries five
collections, not six. `explanations` is a shared ledger with no reader on it, so
it cannot answer "what have I asked"; it is not, and must not become, the place
that does.

The answer DOCUMENT is rendered by `app/components/explanation-body.tsx`, which
both screens use. Its `variant` changes the lead size and the heading level and
NOTHING else, because a reader opening a question they asked last week must meet
the answer they already read. `app/lib/translation/explanation-text.ts` is the
same document as plain text for the copy buttons; it names no section, because it
has no `t` and an English heading over German prose is worse than a blank line.

**The v1 API and the CLI command follow once the output shape is approved.**
There is deliberately no `/api/v1/explain` and no `pnpm cli explain` in this
pass.

### Public explanations, authorship, votes and a browse page (M199/M200)

M199 and M200 here are the TRACKER milestone numbers for this feature, not the
`/welcome` front-door rewrite the Accounts section below also calls M199.

The code, M199: the `user_profiles` table in
`drizzle/schema/user-profiles.ts`, `app/models/user-profiles.server.ts`,
`app/lib/authorship/public-name.ts`, and the public-name and
default-visibility cards in `app/routes/settings.tsx`. M200:
`drizzle/schema/explanation-authorship.ts`, `explanation_votes` in
`drizzle/schema/votes.ts`, `drizzle/schema/explanation-reports.ts` and
`drizzle/schema/explanation-moderation.ts`; the models
`app/models/explanation-authorship.server.ts`,
`app/models/explanation-votes.server.ts`,
`app/models/explanation-reports.server.ts`,
`app/models/explanation-moderation.server.ts` and
`app/models/explanation-browse.server.ts`; the two helpers
`app/lib/authorship/resolve-own-authorship.server.ts` and
`app/lib/authorship/withdraw-own-authorship.server.ts`; the routes
`browse.explanations.tsx`, `browse.explanations.$id.tsx`,
`super/explanations.tsx` and `api.explanation-vote.ts`, with the per-item
controls on `explanations.$id.tsx`; and on the screen
`app/components/explanation-votes.tsx` and the ask-time notice in
`app/components/explain-panes.tsx`. Tests:
`tests/unit/explanation-listing-no-user-filter.test.ts`,
`tests/unit/public-name.test.ts`, and under `tests/integration/` the six
`explanation-authorship-*` files, `explanation-votes.test.ts`,
`explanation-browse-listing.test.ts`, `explanation-browse-detail-404s.test.ts`,
`explanation-report-and-moderation.test.ts`,
`public-surface-browse-explanations.test.ts`,
`user-profiles-independent-fields.test.ts` and
`settings-profile-actions.test.ts`.

Six rules.

**The link is the default, and the name is the opt-in.** `enqueueExplain`
writes an `explanation_authorship` row in the same transaction as the ledger row
it opens, with `listed` set to the opposite of that reader's own
`user_profiles.hide_new_explanations_by_default` and `show_name` false. A reader
with no profile row is listed. A byline appears only once they switch
`show_name` on for that one question and hold a public name, which is joined
live rather than copied, so clearing the name clears every past byline at once.

**Only a request that OPENS a row writes the link.** A reader served from the
cache, and a reader joined to a job already running, write none; a deduped
request deletes the pending row it opened and the link cascades away with it.
The reader's own `explanation_asks` row is written either way, so "what have I
asked" and "what did I cause to be written" are deliberately different sets.

**Removing a question withdraws by DELETE, keyed on the question.**
`withdrawOwnAuthorship` runs before `removeExplanationAsk` and deletes every
authorship row this reader holds over that `(from, to, question_normalized)`
triple, the pending and failed attempts included. It does not set
`listed = false`: afterwards nothing in the database ties the account to the
question. The answer stays in `explanations`, naming nobody.

**One visibility predicate serves both public pages, and absence means NOT
listed.** `app/models/explanation-browse.server.ts` takes the latest answered
row per question, INNER JOINs `explanation_authorship` on `listed = true`, and
requires no `explanation_moderation` row for the key. The list and the detail
page are the same builder with one extra filter, so a row cannot be on the list
and 404 on its own page. Every row written before M200 carries no authorship row
and is therefore not public.

**Moderation is keyed on the question, a report is per row, and the report form
is inline.** `explanation_moderation` holds the `(from, to,
question_normalized)` triple and no foreign key onto the ledger, because the
ledger is append only and a per-row flag would be lost the moment a retry opened
a new row; no row means visible. `explanation_reports` points at one answer, one
row per reader per answer, a reason of at most 500 characters, replaced on a
repeat, and a report hides nothing by itself. The form is inline at the foot of
`/browse/explanations/:id`, and a signed-out visitor is refused. The operator
triages at `/super/explanations`, which reads neither the authorship table nor
the profile table, and selects no reporter's account.

**No per-user public page, ever, and the pages are indexable.** Neither browse
function takes a reader and there is no slot for one;
`tests/unit/explanation-listing-no-user-filter.test.ts` fails the build if any
public listing filters by a user id. The pages carry no robots tag, because
moderation and the report control shipped in the same milestone rather than
after it. A vote needs an account and goes through
`POST /api/explanation-vote`; the public pages show totals only, and a score
reorders the list at a margin of two before recency takes over.

### Favourites, history and translation votes (M194)

The code: `app/lib/local-store/favorites.ts` and the `favorites` collection in
`schema.ts` (`SCHEMA_VERSION` 3, synced, in the blob),
`app/components/personal/favorite-toggle.tsx`,
`app/components/personal/saved-word-row.tsx`, `app/routes/favourites.tsx`,
`app/lib/local-store/history.ts`, `drizzle/schema/votes.ts`'s
`translationVotes`, `app/models/translation-votes.server.ts`,
`app/routes/api.translation-vote.ts`, `app/components/translation-votes.tsx`
and `app/lib/votes/optimistic.ts`.

Three rules. A favourite is NOT a list entry: one tap on an answer cannot ask a
reader to pick a sense first, so it is its own entity and lists stay curated
study material. `recordSearch` is an UPSERT on the search identity and the row
survives a repeat, so searching one word twice moves a row rather than adding
one. A translation vote is recorded and nothing else: no re-run, no hiding, and
the operator's list on `/super/llm` is the only thing built on the scores. The
"no reordering" half of that rule was amended by M196 below, under a margin; the
rest of it stands.

**The "device-only history" half of the second rule is REVERSED** (2026-09-07).
See the section below.

### One answer, its alternatives, and a usage note (M196)

The code: `app/lib/translation/rank.ts`, the ranking call at the foot of
`listTranslationsInto` in `app/lib/translation/translations-query.server.ts`,
`translations.note` in `drizzle/schema/dictionary.ts`, the `note` field in
`app/lib/llm/translation-schema.ts` and its bullet in
`app/prompts/translation/v2.md`, the write in
`app/workflows/operations/translation/translate-headword.ts`, and on the screen
`translationPanePrimary`, `translationPaneAlternatives`, `translationPaneText`
and `translationPaneAllText` in `app/lib/translation/pane-state.ts`, with
`TranslationPane` and `ResultField` rendering them.

THE DEFECT. The answer card listed every translation the corpus held as coequal
words, so it had no answer on it: the reader took the first, which was a fact
about the alphabet. Three things then took the WHOLE list rather than any one
word, the copy button, the favourite snapshot and the device history. An
operator who up-voted one of three Turkish words for `Gartenhacke` still copied
and kept the other two, and reported it as "I'm upvoting only one of the terms,
yet all of them are dragged along".

Four rules.

**Choosing is not voting.** Tapping an alternative promotes it to the answer.
That writes nothing, posts nothing and changes nothing for any other reader.
Fusing the two controls would trap the reader either way: they could not pick a
word without publicly judging the others, and could not judge one without
changing what everybody else is shown.

**The reader's own vote is never a sort key.** `myVote` is on every row and
`rank.ts` does not read it. If it did, two readers would see two different
primary answers for one word and the shared corpus view would quietly become a
personalised one.

**A score moves the answer only at a margin of two.** `VOTE_MARGIN_THRESHOLD`
is the bounded amendment to M194's "no reordering". Below the margin the score
counts as nothing, so on a low-traffic headword one drive-by vote cannot flip
the word every later reader copies and saves. An imported edge leads a generated
one regardless of score.

**The note is optional at the schema, not only nullable at the column.** A lone
candidate has nothing to disambiguate, and a model forced to fill the field
would invent a usage claim that reads as authoritative. Every imported edge and
every edge generated before prompt v2 carries `null`, and a row with no note
renders nothing rather than promising one.

Not done here: no backfill. A word translated before prompt v2 grows notes only
if `pnpm cli translation retract` drops its edges and a reader looks it up
again.

### The search log lives on the server (2026-09-07)

The code: `drizzle/schema/search-history.ts`,
`app/models/search-history.server.ts`, `app/routes/api.search-history.ts`, the
loaders in `app/routes/history.tsx` and `app/routes/translate.tsx`, and the two
client components `app/components/personal/record-search.tsx` and
`app/components/personal/recent-history.tsx`. The decision is recorded in
[ADR-0011](.adr/0011-plain-accounts-replace-the-encrypted-layer.md), amended in
place rather than given a new number, and in
`app/lib/local-store/BLOB-CONTENTS.md`.

The log was device-only until this change, on the argument that the server must
never learn what anybody looked up. That argument does not hold here: the search
loader already receives every word typed, because it queries the shared corpus
with it, so a device-only log reduced retention and not disclosure, while
costing the reader the one thing a history is for. It did not follow them to a
second device.

Four rules.

**It is not in the sync blob, and must not be.** That document is rewritten
whole under a compare-and-swap and capped at 2 MiB. A collection that grows with
every query typed belongs in its own table with its own endpoint, which is what
`search_history` is.

**Nothing logs a query.** The model and the route hold an account id and a typed
word in one scope, which makes them the two places this product could turn its
own log file into a search log. Neither writes a log line at any level. Keep it
that way.

**The identity of a search is `(user, query, from, to)`, and `headword_id` is
outside it.** The same typed word can land on a different top hit as the
dictionary grows, and a reader who types the same thing twice has run the same
search either way.

**A later `NULL` never unwrites an answer.** The recorder posts once when the
search is on screen and again when the pane has words, so the write uses
`coalesce(excluded, existing)` on both answer-carrying columns. Taking the first
`null` literally would blank an answer the reader can still see.

`MigrateLocalHistory` is TEMPORARY. It hands a device's old local log to the
server once and then clears it, so nobody loses a history to this change. When
the devices in use have all handed over, it and `app/lib/local-store/history.ts`
can both go.

## Prerequisites

The four `@sprqvntrs/*` dependencies are published to npmjs and need no
credentials. `.npmrc` pins the scope to `https://registry.npmjs.org/` so an
install still works on a machine whose `~/.npmrc` routes the scope to GitHub
Packages.

There is no cloud CI test runner. `.githooks/pre-push` is the only gate, by
workspace policy: a push from the workstation is what triggers the deploy, so
the tests belong in front of it.

Install the gate once per clone: `make hooks` from the workspace root, or
`pnpm install` (the `prepare` script sets `core.hooksPath`).

## Commands

```bash
pnpm dev          # Dev server (requires: docker compose up)
pnpm build        # Production build
pnpm typecheck    # Type check (never run tsc without --noEmit)
pnpm lint         # oxlint (anti-slop + correctness + import guardrails)
pnpm lint:fix     # oxlint auto-fixable subset
pnpm cli          # CLI commands (see .claude/cli.md)
```

## Linting

**oxlint is this repo's linter.** It runs oxlint's own correctness/suspicious/perf
catalog *and* [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) in a
single pass over `.oxlintrc.json` — oxlint's default config path, so a bare
`oxlint` (editor extension, `--fix`, ad-hoc run) picks up the full gate with no
flags. It is the *only* linter: ESLint and typescript-eslint were removed once
their last job, the cross-variant `no-restricted-imports` guardrails, moved into
`.oxlintrc.json` `overrides` — which is also what unblocked TypeScript 7
([ADR-0007](.adr/0007-one-linter-and-typescript-7.md)).

**Editing the `overrides` globs:** oxlint matches `files` against the full path,
so every glob needs a `**/` prefix. A bare `app/**/*.ts` silently matches
nothing — no error, it just never applies.

**All 15 anti-slop rules run at `error`.** The plugin is a vendored copy of
[dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) (MIT) living under
`tools/oxlint/anti-slop/` and loaded via `jsPlugins` — it is not an npm
dependency, and upstream publishes none. Source, pinned commit, drift check, and
re-vendor procedure: [tools/oxlint/README.md](tools/oxlint/README.md). Do not
edit the vendored tree, and do not downgrade a rule to clear a finding; fix the
code.

Why the gate is this blunt, and why the boundary helpers below exist in the
shapes they do: [ADR-0005](.adr/0005-oxlint-and-anti-slop-are-the-lint-gate.md).

### Where the gate runs

| Surface | What runs | Wiring |
|---------|-----------|--------|
| Editor | oxlint on type, `source.fixAll.oxc` on save | `.vscode/settings.json` + the `oxc.oxc-vscode` recommendation |
| Claude Code | oxlint on each written/edited file; a finding blocks with the diagnostic | `.claude/hooks/lint-edited-file.sh` (PostToolUse) |
| Commit | oxlint on staged files | `.githooks/pre-commit`, installed by the `prepare` script — no husky, no setup step |
| Push | full-tree oxlint → typecheck → unit tests → build | `.githooks/pre-push`, the repo's only test gate — there is no cloud CI |

`git commit --no-verify` skips the commit hook; pre-push lints the whole tree
anyway. `SKIP_TESTS=1 git push` skips the push gate and pushes unverified code —
use it deliberately, and say so.

### Rules deliberately disabled

Seven of oxlint's built-in rules are `off` in `.oxlintrc.json`. Each is
inapplicable to this stack rather than inconvenient — the reason matters if you
are tempted to re-enable one:

| Rule | Why off |
|------|---------|
| `react/react-in-jsx-scope` | Automatic JSX runtime (React 19 + Vite). The rule predates it. |
| `unicorn/no-instanceof-builtins` | It wants `typeof x === 'function'`, which `anti-slop/no-runtime-typeof` bans. `instanceof Function` is the callable check the stricter gate leaves open. |
| `import/no-named-as-default-member` | Fires on `pg.Pool` / `bcrypt.hash`. The default-namespace form is the correct CJS-interop idiom for these packages. |
| `import/no-unassigned-import` | `import 'dotenv/config'` is the documented usage. |
| `eslint/no-await-in-loop` | Migrations, seeds, and retry backoff are sequential *by design*; the rule pushes toward incorrect parallelization. |
| `eslint/no-underscore-dangle` | `__workflowOrchestrator` and friends are deliberate `globalThis` singletons that survive HMR. |
| `jsx-a11y/control-has-associated-label` | Fires on `<tr>` elements, which are not controls. Real label problems are still caught by `label-has-associated-control`, which stays on. |

Also not enabled: the `react-perf` plugin, which flags every inline callback
passed to a plain DOM element. It is built for memoized component trees and
produces no signal here.

### What the anti-slop rules ask for, and how this repo answers

| Rule | The fix |
|------|---------|
| `no-runtime-typeof` | Parse the value with a Zod schema at the I/O boundary, then branch on the decoded domain value. |
| `no-unknown-parameters` / `no-unknown-returns` | Name a domain type. A parameter genuinely holding a caught error may be named `cause` — that is the rule's own exemption. |
| `no-unsafe-dictionary-type` | Use `JsonValue` / `JsonObject` from `#app/lib/json`, or a schema-derived type. |
| `no-known-value-widening` | Drop the annotation and use `satisfies` so the literal types survive. |
| `require-safety-comment-for-type-assertion` | Prefer removing the assertion. Where TypeScript genuinely cannot express the invariant (Drizzle generic erasure, CSS custom properties, cross-package type identity), write a `// SAFETY:` comment immediately above the assertion or its containing statement stating what makes it sound. |

The boundary helpers that exist so you rarely need an assertion:

- `parseJsonBody(request, schema)` — `#app/lib/api-auth.server`, for request bodies
- `transport.get(path, schema, params)` — `cli/lib/transport`, for every CLI call
- `cli/lib/schemas.ts` — response schemas derived from the Drizzle tables via `drizzle-zod`

## Key Documentation

| Topic | Location |
|-------|----------|
| Design language and UI recipes | [DESIGN.md](DESIGN.md) |
| TypeScript | [.claude/typescript-rules.md](.claude/typescript-rules.md) |
| React | [.claude/react-rules.md](.claude/react-rules.md) |
| React Router v8 | [.claude/react-router-rules.md](.claude/react-router-rules.md), [skill](.claude/skills/react-router-framework-mode/SKILL.md) |
| Forms (Conform + Zod v4) | [.claude/conform-to-react.md](.claude/conform-to-react.md) |
| Workflows | [.claude/workflows.md](.claude/workflows.md) |
| CLI | [.claude/cli.md](.claude/cli.md) |
| Architecture Decisions | [.adr/README.md](.adr/README.md) |

**Read [DESIGN.md](DESIGN.md) before writing any UI.** It is the normative
source for surfaces, colour tokens, typography and layout, and the code cites it
by section and rule number, so a comment saying "DESIGN.md rule 3" is pointing
at a real, checkable statement. Two of its rules are enforced by
`tests/unit/design-rules.test.ts` rather than by review: no thick left border
accents, and no em dashes.

## Accounts

Two things about this app surprise people, so read them before touching anything
under `app/lib/sync/`, `app/routes/sign-*` or `app/routes/api.v1.auth.*`.

**1. Every search needs an account, and the account gate is keyed on the
request, not on the path.** Signup is open (M191, [ADR-0011](.adr/0011-plain-accounts-replace-the-encrypted-layer.md)): there is no
invite and no bootstrap token, so a route decision never needs to ask who
minted a way in. The contract, in full:

- `/welcome` is the front door, and it must stay a `200` for a signed-out
  stranger: one card naming the product, with `/sign-up` and `/sign-in` on it.
  It is in the `_public` layout, NOT in the app shell. Do not gate it, and do
  not put navigation on it.
- `/` was that screen until M199, and it is not any more. A stranger there met
  the whole app shell, a sidebar offering lists, favourites and history, a
  language bar, an input card and a mode switch, and could use none of it. A
  signed-out visit to `/` with nothing typed now hops to `/welcome`, and with a
  query it hops to `/sign-in?next=`, so a shared result link still lands on its
  result. The worked example survives, on `/` for the reader who is signed in.
- Everything past the front door needs an account, except the public pages
  named below: a typed search, `/explain`, entry pages, lists, history, review,
  attribution, settings, and `POST /api/v1/transcribe`. That last one was ungated on purpose before M184,
  and the reversal is deliberate.
- `/` and `/translate` are two route ids over ONE file, and the product's real
  URL is `/?q=<word>`. `/translate` sits under `app/routes/_app.gated.tsx`
  since M199 and `/` cannot, because a route sits in exactly one layout and the
  index has to keep the app shell for the reader who is signed in. So the rule
  for `/` lives at the top of the loader both ids share and reads the REQUEST:
  an empty `q` hops to `/welcome`, any other `q` to `/sign-in?next=`. Do not
  delete that rule because the alias is gated by a layout, and do not replace
  it with a path-keyed one. A path-keyed rule gated `/search` (this route's old
  name) and left `/?q=` wide open once already.
- The screens with no public half are gated by nesting under
  `app/routes/_app.gated.tsx`, which carries `accountMiddleware`. That is the
  only app-screen gate. `authMiddleware` also demanded a linked `users` row,
  which almost no account had, and it is gone with that table (ADR-0010).
- The front door stays open. `/welcome`, `/account`, `/sign-in`, `/sign-up`
  and `/offline` are never gated, because a gate in front of the sign-in page is a gate nobody
  can ever pass. `/healthcheck` and `/legal/*` stay public too, and
  `tests/integration/public-surface-*.test.ts` says so in executable form.
  `/browse/explanations` and `/browse/explanations/:id` joined them in M200: a
  stranger reads the answered questions their askers left listed, and both
  loaders are read only, so nothing there can queue a job or spend money.
- The doors are `/sign-in` and `/sign-up`. They were `/sync/login` and
  `/sync/setup` until M189. The old paths still answer, with a permanent
  redirect that keeps the query string, from the era when a signup URL carried
  an invite token that had to survive the hop; nothing survives that hop
  today, since there is nothing left to carry.
- **`/welcome` and `/account` carry both doors.** This reverses the older rule
  that no screen may ask anybody to sign up. That rule belonged to an
  anonymous-by-default product, and M184 ended it: an account is now required
  for every search, so a front door with no way in is a wall, not restraint.
  `/sign-up` is the primary action and `/sign-in` the secondary one on both
  screens, and the shell header carries the same pair. The home page carried
  the pair too until M199, which moved the signed-out visitor off it
  altogether.
- **An account is an account, and sync is a consequence of holding one.** No
  user-facing screen presents sync as something to set up.
- **An account is an email address and a password** (M191). Signup is open, and
  the address has to be confirmed by a mailed link before the first sign-in. A
  forgotten password is replaced by a second mailed link, which also signs every
  other device out. Sign-up, sign-in and forgot-password all answer the same way
  for a known and an unknown address, so none of them is an enumeration oracle.
  `pnpm cli account grant-superadmin <email>` is the only out-of-band grant.
- The gate blocks the SCREEN, never the device's own store. Lists and history
  are still written locally and were never uploaded, and a redirect must not be
  the thing that deletes them.
- `app/lib/route-classification.ts` records how every file under `app/routes/`
  decides who may reach it. A new route file that nobody classified fails a
  unit test.

**2. The account is an address and a password (M191).** `users` holds the
address, a bcrypt hash at cost 10, the confirmation instant, the password-change
instant and the superadmin flag; `user_tokens` holds the digests of the two
mailed links, `verify` and `reset`. Nothing here is derived material a browser
computed, and the synced document in `sync_blobs.payload` is plain JSON the
operator can read.

Rules you cannot design around:

- **Nothing says which half of a credential was wrong.** `signIn` answers `null`
  for an unknown address, a wrong password and an unconfirmed address alike, and
  sign-up and forgot-password answer the same sentence whether or not the
  address is on file. Those decisions live in `app/services/auth.server.ts`, not
  in a screen, because the one caller that forgets is what builds the oracle.
- **A mailed link is consumed in one statement.** `UPDATE user_tokens SET
  used_at = now() WHERE token_hash = ... AND used_at IS NULL AND expires_at >
  now() RETURNING user_id`. A read-then-write pair lets two clicks on one reset
  link both be accepted.
- **`users.password_changed_at` is the session epoch.** The cookie carries
  `{ userId, issuedAt }` and nothing else; `authMiddleware` refuses a cookie
  older than that column. That is how a reset signs the other devices out with
  no session table. The tab that made the change is handed a fresh cookie by
  `auth.server.ts` and must set it.
- **The rate limiter reads `x-client-ip`, which `server.ts` writes** from
  `req.ip` after Express resolves `trust proxy`, deleting any incoming value
  first. Reading `x-forwarded-for` in a middleware would count a header the
  client can write. It is an in-memory map (`app/middleware/rate-limit.ts`),
  scoped to one process on purpose, and it resets on every deploy: a restart
  clears every counter, which is accepted because the limiter's job is to slow
  a script down, not to be exact.
- **The old encrypted layer is gone.** `app/lib/e2ee/`, its wire specification, the
  `accounts`, `account_tokens`, `sync_key_records` and `invites` tables, and the
  root secret they were peppered with, were all removed by M191. The copied sync
  ENGINE stays: `app/lib/sync/` still carries the Lamport merge and the
  compare-and-swap loop, under
  [ADR-0008](.adr/0008-e2ee-sync-copied-not-extracted.md), with the encrypt and
  decrypt steps replaced by JSON framing.
- **Mail is a hard dependency, not an enhancement.** `app/services/email.server.ts`
  sends over plain `fetch` against pigeon (`PIGEON_API_KEY`, `PIGEON_BASE_URL`),
  from `EMAIL_FROM`. Production refuses to boot without both pigeon variables set
  rather than fail a signup silently; every other environment falls back to a
  console transport that prints the verification and reset links in full, which
  is the only way to reach them in local dev with no mail service configured.

**Tests for this area moved.** `tests/unit/e2ee/` is gone with the library it
tested. In its place: `tests/unit/auth/` covers the password rule and the
token digest and expiry logic, and `tests/unit/email/` covers the mail
templates and the pigeon transport, including its console fallback.

`users` is the only identity in this app. The organization tables are gone
(M189, [ADR-0010](.adr/0010-drop-the-inherited-tenancy.md)): they held zero rows
and nothing read them. `apiKeys` stands alone, carrying its own `isSuperadmin`
flag rather than joining through a user row to an organization, and
screen-level superadmin is `users.is_superadmin`.

`/super/*` holds three screens and nothing else: `llm`, which edits the model
selection enrichment reads out of `app_settings`; `explanations`, the moderation
queue for the public browse pages, where a reported answer is triaged and a
question is hidden or un-hidden; and `whoami-ip`, which echoes the IP the server
resolved so a `TRUST_PROXY` hop count can be checked against a live proxy. A
bare `/super` redirects to `/super/llm`. On the hosted instance
`/super` is fenced twice: Bay's `vpn_routes` restricts it to the operator's
tailnet, and the superadmin session check runs as an independent second layer.

### Account and mail environment variables

| Variable | Required | What it does |
|----------|----------|---------------|
| `SESSION_SECRET` | Production | Signs and encrypts the session cookie. Rotating it signs everybody out. |
| `PIGEON_API_KEY` | Production | The tenant key that authenticates mail sends to pigeon. |
| `PIGEON_BASE_URL` | Production | The pigeon service address, e.g. `http://100.64.0.1:3601`. |
| `EMAIL_FROM` | No, defaults to `no-reply@kenning.altan.fyi` | The sender address on outgoing mail. |

Production refuses to start if `PIGEON_API_KEY` or `PIGEON_BASE_URL` is unset.
The root peppering secret and the one-shot signup token from the account model
M191 removed are both gone, and no replacement was needed: this table is now
the complete list.

## Architecture Decision Records (ADRs)

Significant decisions — anything that constrains future work, locks in a trade-off, or would surprise a new contributor — are recorded as ADRs in [`.adr/`](.adr/). Read them before proposing a change that touches the same area; if you're making a new big-call decision, write a new ADR in the same conversation.

**When to write an ADR:**
- Adopting or dropping a framework, runtime, or major library
- Cross-cutting architectural patterns (auth model, tenancy enforcement, transport layer)
- Decisions that take effort to reverse (DB schema shape, file layout, public API contracts)
- "Why didn't you just X?" answers that future-you will forget

**Workflow:** copy `.adr/0000-template.md` to the next zero-padded number, fill in `Status`, `Context`, `Decision`, `Consequences`, then add the entry to the index below and to `.adr/README.md`.

### Index

| # | Title | Status |
|---|-------|--------|
| [0001](.adr/0001-cli-wraps-the-api.md) | CLI wraps the API | Accepted |
| [0002](.adr/0002-data-migrations.md) | Data migrations alongside schema migrations | Accepted |
| [0003](.adr/0003-app-enforced-multi-tenancy.md) | App-enforced multi-tenancy (no RLS) | Superseded by 0010 |
| [0004](.adr/0004-custom-server-is-the-production-entry.md) | The custom `server.ts` is the production entrypoint | Accepted |
| [0005](.adr/0005-oxlint-and-anti-slop-are-the-lint-gate.md) | oxlint + anti-slop is the lint gate | Accepted |
| [0007](.adr/0007-one-linter-and-typescript-7.md) | One linter (oxlint), and TypeScript 7 | Accepted |
| [0008](.adr/0008-e2ee-sync-copied-not-extracted.md) | The E2EE sync code is copied from openplate-sync, not shared | Superseded by 0011 |
| [0009](.adr/0009-invite-only-accounts.md) | Invite-only accounts, bootstrapped by a one-shot token | Superseded by 0011 |
| [0010](.adr/0010-drop-the-inherited-tenancy.md) | Drop the inherited tenancy, org and CMS surfaces | Accepted |
| [0011](.adr/0011-plain-accounts-replace-the-encrypted-layer.md) | Plain accounts replace the encrypted layer | Accepted |

## Coding Style Summary

- **TypeScript**: Strict types, no `any`, use Zod inference
- **Files**: `kebab-case.ts/tsx`; routes use `_layout.tsx` patterns
- **React**: Avoid `useEffect` for derived state; prefer early returns over nested ternaries
- **Drizzle**: Use `Select*` types in UI, `Insert*` for mutations

## API-First — CLI wraps the API

**Rule:** new functionality lands in the HTTP API first; the CLI is a thin client over that API. Never add a CLI subcommand that talks to the DB or business logic directly when an API call could do the same work.

**Why:**
- Single code path for web UI, CLI, third-party clients, and LLM agents — no drift
- HTTP layer carries auth and audit on every operation
- Prod CLI calls don't require DB credentials on the operator's machine
- Remote agents can act on prod via `--remote=<url>` + scoped API keys

**Bootstrap-only exceptions** (direct-DB allowed because they precede the auth surface itself):
- `api-key create` — bootstrap the first key for a fresh environment
- `db check`, `db migrate`, `db reset` — DB-level health and lifecycle, run before the API is up

These are enumerated in [ADR-0001](.adr/0001-cli-wraps-the-api.md). Don't add to the list without an ADR amendment.

See `.adr/0001-cli-wraps-the-api.md` for the full rationale. The four-layer pattern in the next section is the canonical recipe for adding any non-bootstrap feature.

### Adding a new endpoint (the four-layer pattern)

Every non-bootstrap feature touches four files. Doing all four keeps `--remote` HTTP mode, direct-DB CLI mode, and the web/agent surface in sync.

**Layer 1 — Model** (`app/models/<resource>.server.ts`)

The business-logic primitive. There is no tenancy and no query wrapper: this app
has one instance and one dictionary cache, so a model reads and writes its table
through `db` directly (ADR-0010). List functions return `{ rows, total }` with a
real `COUNT(*)` run in parallel.

```typescript
export async function listFoos(
  pagination: PaginationParams = { limit: 20, offset: 0 },
): Promise<{ rows: SelectFoo[]; total: number }> {
  const [rows, totalRow] = await Promise.all([
    db.select().from(foos).orderBy(desc(foos.createdAt))
      .limit(pagination.limit).offset(pagination.offset),
    db.select({ value: count() }).from(foos).then((r) => r[0]),
  ]);
  return { rows, total: Number(totalRow?.value ?? 0) };
}
```

**Layer 2 — HTTP route** (`app/routes/api.v1.<resource>.ts`, registered in `app/routes.ts`)

Use the shared auth helpers from `app/lib/api-auth.server.ts`:
- `requireApiKey(request)` — returns the key after the revoked-key check.
- `requireSuperadminApiKey(request)` — same, but refuses a key whose `isSuperadmin` is false. Use it for anything operational.
- `jsonError(status, message)` — always `throw jsonError(...)`. Returns the standard `{ error, code }` JSON envelope.

List endpoints use `parsePaginationParams(url.searchParams)` + `paginatedJson({data, total, limit, offset})` from `app/lib/pagination.server.ts` for a uniform envelope and clamped limits (default 20, max 100).

```typescript
export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  const url = new URL(request.url);
  await requireApiKey(request);

  const pagination = parsePaginationParams(url.searchParams);
  const { rows, total } = await listFoos(pagination);
  return paginatedJson({ data: rows, total, ...pagination });
}
```

**Layer 3 — DirectTransport registration** (`cli/lib/direct-transport-handlers.ts`)

Register a responder with the same path/method/shape as the HTTP route. This is what runs when the CLI is invoked without `--remote` (the default for local dev). All registrations live in one file — do **not** scatter `direct.register(...)` calls across command files.

```typescript
direct.register('GET', '/api/v1/foos', async ({ query }) => {
  const pagination = parsePaginationParams(query);
  const { rows, total } = await listFoos(pagination);
  return { data: rows, total, ...pagination };
});
```

**Layer 4 — CLI command** (`cli/commands/<resource>.ts`)

Flat file under `cli/commands/`. Only `data-migration/` is nested today; everything else is one file per resource group. The command imports the `transport` live-binding singleton from `cli/lib/transport.ts` and calls `transport.get(path, params?)` — never `instanceof` the transport, use `isHttpTransport(t)` from `transport.ts` if you must branch.

```typescript
import { transport } from '../lib/transport';

async function listFoosCmd(options: { format: OutputFormat; limit: string; offset: string }) {
  const response = await transport.get('/api/v1/foos', {
    limit: parseInt(options.limit, 10),
    offset: parseInt(options.offset, 10),
  });
  const envelope = response as PaginatedResult<SelectFoo>;
  output(options.format, envelope.data, fooColumns, {
    total: envelope.total, limit: envelope.limit, offset: envelope.offset,
  });
}
```

Document the new command in [.claude/cli.md](.claude/cli.md).

### Hiding secret columns from API responses

If a table holds a credential artifact (hash, token, encrypted blob), never let it cross the route boundary. Pattern from `app/models/api-keys.server.ts`:

1. Export a `SelectFooPublic = Omit<SelectFoo, 'secretField'>` type from the model.
2. Define a `fooPublicColumns` Drizzle projection that lists every column except the secret.
3. Use `db.select(fooPublicColumns).from(foos)…` for reads.
4. For `UPDATE … RETURNING`, follow the update with a `SELECT fooPublicColumns` to fetch the post-update row without the secret.
5. Every public-facing function returns `SelectFooPublic` (or `{ rows: SelectFooPublic[], total }` for lists). The secret column is read only inside the model, only for WHERE-clause matching during auth.

The downstream types (`ApiKeyAuth.apiKey`, formatters, CLI columns) all reference the public type — there's no path for the secret to leak via inference.


## Calling the CLI against production

With all commands migrated to HTTP, an LLM agent or human operator can act on production data using only an API key — no database credentials required.

### Creating the first API key

The first key must be created via direct-DB access (bootstrap exception per ADR-0001):

```bash
pnpm cli api-key create --name="agent-key"
# Outputs: sk_...  (copy this value)
```

Add `--superadmin` for a key that may reach the DB admin endpoints.

### Using the key

```bash
export TRANSLATE_API_KEY=sk_<your-key>

# Against a specific server
pnpm cli --remote=http://localhost:3456 api-key list
pnpm cli --remote=https://app.example.com db check
```

### `--prod` shorthand

Set `TRANSLATE_PROD_URL` in your environment and use `--prod` instead of `--remote`:

```bash
export TRANSLATE_PROD_URL=https://app.example.com
pnpm cli --prod api-key list
```

### Key scopes

There are two, and no organization behind either (ADR-0010):

| Key type | What it can access |
|----------|-------------------|
| **Ordinary** | The api-key endpoints. |
| **Superadmin** (`isSuperadmin` on the key itself) | The above, plus `admin/db/*`, and revoking any key. |

### Example commands

```bash
# API keys
pnpm cli --prod api-key list

# Database (superadmin key required)
pnpm cli --prod db check
pnpm cli --prod db tables
```

### Safety note

CLI commands sent via `--remote` go through the app's HTTP auth layer — auth is enforced and all operations are auditable. No raw database access is required on the operator's machine.

## Data Migrations

Schema migrations (`drizzle/migrations/`) change the shape of the DB. **Data migrations** change the contents — backfills, enrichments, one-time fix-ups, repopulating denormalized columns. They live alongside schema migrations and run automatically on deploy.

**Key properties:**
- Tracked in a `data_migrations` table (name + applied_at) so each runs at most once per environment
- Discovered from `drizzle/data-migrations/<YYYY-MM-DD>-<slug>.ts` at startup
- Each migration is an async function that receives a DB connection and runs inside a transaction
- Run by `pnpm cli data-migration run` (deploy invokes this after schema migrations)

**When to write one:**
- Backfilling a new NOT-NULL column on existing rows
- Renaming/normalizing values in bulk
- Repopulating denormalized data after a schema change
- Any one-shot bulk write you'd otherwise be tempted to run as an ad-hoc psql script

See [ADR-0002](.adr/0002-data-migrations.md) for the rationale.
Runner: `drizzle/data-migrations/runner.ts`
CLI: `cli/commands/data-migration/run.ts`
Migrations: `drizzle/data-migrations/migrations/<YYYY-MM-DD>-<slug>.ts`

## Commits

Use Conventional Commits: `feat:`, `fix:`, `chore:`, `refactor:`, `docs:`

See: [.claude/commands/commit.md](.claude/commands/commit.md)

## Claude Code Integration

```
.claude/
├── commands/       # /commit, /sync-cli
├── skills/         # cli-sync, form-persistence, react-router-framework-mode
├── hooks/          # Post-edit validations (see below)
└── *.md            # Coding standards
```

`PostToolUse` hooks run on every `Write`/`Edit`:

| Hook | What it does |
|------|--------------|
| `lint-edited-file.sh` | Runs oxlint on the edited file. A finding **blocks** with the diagnostic, so slop is corrected in the same turn rather than at commit time. |
| `on-schema-change.sh` | Reminds you to generate a migration after a `drizzle/schema.ts` edit. |

If a lint hook blocks you: fix the code. Do not downgrade the rule, and do not
add a suppression comment — see [ADR-0005](.adr/0005-oxlint-and-anti-slop-are-the-lint-gate.md).
