import type { Route } from './+types/explain';
import { redirect, type MetaFunction } from 'react-router';
import { ExplainPanes } from '#app/components/explain-panes';
import { useExplainPane } from '#app/components/explain-pane';
import { PersistLanguagePair } from '#app/components/persist-language-pair';
import { documentTitle, metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { resolveRequestLanguage } from '#app/i18n/language-prefs';
import { SIGN_IN_PATH } from '#app/lib/auth/paths';
import { detectLanguage } from '#app/lib/dictionary/detect-language';
import { reconcilePairWithDirection, resolveLanguagePair } from '#app/lib/dictionary/language-pair';
import { normalizeQuery } from '#app/lib/dictionary/normalize';
import { resolveTriggeredExplainPanel, type ExplainPanel } from '#app/lib/translation/explain-panel.server';
import { EXPLAIN_MAX_QUESTION_CHARS } from '#app/lib/translation/limits';
import { recordExplanationAsk } from '#app/models/explanation-asks.server';
import { getUserProfile } from '#app/models/user-profiles.server';
import type { ExplainPaneTarget } from '#app/lib/translation/explain-pane';
import type { TitleHandle } from '#app/lib/route-title';
import { resolveUser } from '#app/middleware/auth';
import type { AuthenticatedUser } from '#app/middleware/helpers';
import { getRawDb } from '#drizzle/db';
import { ExplainLandingHint } from '#app/components/explain-landing-hint';

// `meta()` runs outside the React tree, so it has no `t`. It goes through the
// pure `meta-title` seam instead, which reads the language off the ROOT loader
// rather than the process-wide i18next singleton. See that module for why the
// singleton is a cross-request bug here.
export const meta: MetaFunction = ({ matches }) => {
  const language = metaLanguage(matches);
  return [
    { title: documentTitle(language, 'explain.metaTitle') },
    { name: 'description', content: metaTitle(language, 'explain.metaDescription') },
  ];
};

/** The name of this screen, for the chrome's `h1`. */
export const handle = { titleKey: 'nav.explain' } satisfies TitleHandle;

/**
 * The 302 a signed-out visitor gets, carrying where they were going.
 *
 * @param request the incoming request.
 * @returns the redirect Response, for a caller to throw.
 */
function signInRedirect(request: Request): Response {
  const url = new URL(request.url);
  return redirect(`${SIGN_IN_PATH}?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
}

/**
 * The signed-in user, or a redirect to the sign-in page carrying `?next=`.
 *
 * IT THROWS RATHER THAN RETURNING A FLAG, so a caller cannot forget to act on
 * the answer, and the throw is a `Response` the router turns into an ordinary
 * 302.
 *
 * @param request the incoming request.
 * @returns the signed-in user.
 * @throws a `redirect` Response when nobody is signed in.
 */
async function requireSignedIn(request: Request): Promise<AuthenticatedUser> {
  const user = await resolveUser(request);
  if (user !== null) return user;
  throw signInRedirect(request);
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') ?? '').trim();

  // THE ACCOUNT GATE, KEYED ON THE REQUEST RATHER THAN ON THE PATH, exactly as
  // `translate.tsx` keys its own. An empty `q` is the landing state and costs
  // nothing: no dictionary query, no queue, no model call. Any other `q` reaches
  // `resolveTriggeredExplainPanel`, which may start a billed run, so it needs an
  // account.
  //
  // IT SITS HERE, ABOVE EVERYTHING, ON PURPOSE. Before `getRawDb()`, before the
  // language resolution and before the panel. A signed-out request therefore
  // costs one cookie unseal and one indexed token lookup.
  //
  // IT IS THE SAME SHAPE AS THE SEARCH GATE AND NOT A SHARED HELPER, because the
  // two loaders differ in what they do afterwards and a helper that returned a
  // user would still leave each caller free to ignore it. The throw is what
  // makes forgetting impossible, and it is three lines.
  const user = q === '' ? null : await requireSignedIn(request);

  // WHO IS READING, ASKED SEPARATELY AND ONLY ON THE OPEN BRANCH, for the reason
  // `translate.tsx` gives: the landing screen needs to know whether to show the
  // doors, and that boolean gates nothing and decides no spend.
  const reader = user ?? (await resolveUser(request));
  const signedIn = reader !== null;

  const db = getRawDb();
  // Read on the landing state too, so the notice is on screen before the first question.
  const profile = reader === null ? null : await getUserProfile(db, reader.id);
  const hideByDefault = profile?.hideNewExplanationsByDefault ?? null;

  // The UI language comes from the request cookie, not from the i18next
  // singleton: that instance is process-wide and would leak one reader's
  // language into another reader's request.
  const cookieHeader = request.headers.get('cookie');
  const uiLanguage = resolveRequestLanguage(cookieHeader);

  // THE PAIR THE BAR IS SET TO, resolved exactly as the translator resolves it:
  // the URL wins, then the cookie, then the default. A shared link has to render
  // the pair it was captured with rather than the pair the device opening it
  // prefers, and the cookie exists because the server renders this bar in the
  // first byte of HTML and cannot read IndexedDB.
  const pair = resolveLanguagePair({
    from: url.searchParams.get('from'),
    to: url.searchParams.get('to'),
    cookieHeader,
  });
  const direction = await detectLanguage(db, { q, from: pair.source, to: pair.target, uiLanguage });

  if (q === '') {
    // NOT RECONCILED, AND THAT IS RIGHT. `direction` here is only what an empty
    // question would resolve to if it were asked; nothing below reads it as an
    // answer, and reconciling a pair against a direction nobody asked with would
    // report a target for a question that never happened.
    return { q, direction, pair, signedIn, panel: null, hideByDefault };
  }

  // THE SAME GATE AGAIN, AS A NARROWING RATHER THAN A SECOND CHECK. `q` is
  // non-empty past the return above, so `requireSignedIn` already ran and either
  // threw or answered a user; TypeScript cannot see that through the ternary
  // that produced `user`. This throws the same 302 rather than asserting past
  // the null, because the resolver below now needs a reader id and a wrong one
  // would be written onto a row.
  if (user === null) throw signInRedirect(request);

  // THE PAIR THE BAR SHOWS FOR THIS ANSWER, RECONCILED WITH THE RESOLUTION THAT
  // ACTUALLY RAN. `pair` above is the reader's own statement, `detect` included,
  // and `direction` is what that statement resolved to. `from=detect` hides a
  // source and target collision from `resolveLanguagePair`, and this is what
  // repairs it, the same call `translate.tsx` makes for the same reason.
  const resolvedPair = reconcilePairWithDirection(pair, direction);

  // THE FOLD THIS LOADER ALREADY COMPUTED, handed straight to the resolver. `q`
  // is what a run would answer and `query.normalized` is the cache key. Folding
  // it a second time would be a second implementation of the key, and the pane
  // polls with the raw question so the server can fold it once, in
  // `explainKeyFromRequest`, exactly the way this line does.
  const query = normalizeQuery(q, direction.from);

  // AWAITED, and it has to be: the four guards inside it decide whether a job
  // starts at all, and a decision taken after the response has gone is no
  // decision.
  const panel: ExplainPanel = await resolveTriggeredExplainPanel(db, {
    request,
    question: q,
    questionNormalized: query.normalized,
    from: direction.from,
    to: direction.to,
    userId: user.id,
  });

  // THE ASK IS RECORDED HERE, AFTER THE PANEL AND WHATEVER THE PANEL SAYS.
  //
  // AFTER, because the panel is what decides whether a run starts, and a write
  // in front of it would be a write on a request that was about to be refused
  // for rate limiting. WHATEVER IT SAYS, because a reader who asked and was told
  // to come back tomorrow still asked: the detail page renders every state the
  // card does, including a pending one, so a row with no answer behind it yet is
  // a screen that works rather than a dead link.
  //
  // THE LENGTH CAP IS THE ONE THING THAT STOPS IT. A question over the cap is
  // refused outright and no run is ever opened for it, so logging it would put a
  // row in the reader's list that can never be answered and can only be removed.
  // It is the same cap `refuseExplain` applies, read from the same constant.
  //
  // THE LANGUAGES ARE THE RESOLVED ONES, not the reader's raw statement, so the
  // row repeats the ask that actually ran. The folded question is the one this
  // loader already computed for the cache key: folding it twice would be two
  // implementations of one identity.
  if (q.length <= EXPLAIN_MAX_QUESTION_CHARS) {
    await recordExplanationAsk({
      userId: user.id,
      question: q,
      questionNormalized: query.normalized,
      fromLanguage: direction.from,
      toLanguage: direction.to,
    });
  }

  return { q, direction, pair: resolvedPair, signedIn, panel, hideByDefault };
}

/**
 * The explain screen, the sibling of the translator at `/`.
 *
 * THE SURFACE ITSELF LIVES IN `ExplainPanes`, and this route is what feeds it.
 * The split is the one `translate.tsx` makes: the loader gates every non-empty
 * question behind an account, so the only way to render an ANSWERED surface
 * without a session is to hand the answer to the component directly.
 *
 * THE PANE'S CONTROLLER IS HELD HERE, AND HANDED DOWN, for the same reason it is
 * on the search screen: the route is where a second consumer of the answer would
 * be added, and a second call to the hook would be a second poll of one run.
 * Nothing else reads it today.
 *
 * THERE IS NO SEARCH-HISTORY WRITE HERE, AND THAT IS STILL DELIBERATE. The
 * search log's identity is `(user, query, from, to)` and its rows carry a
 * translation. A question is not a search: logging one would put free text a
 * reader typed about themselves into a table keyed as though it were a word they
 * looked up, and the `/history` screen would then offer to run it again through
 * the translator. The ask has its own table and its own screen, `/explanations`.
 */
export default function ExplainRoute({ loaderData }: Route.ComponentProps) {
  const { q, direction, pair, signedIn, panel, hideByDefault } = loaderData;

  // THE PANE'S STATE MACHINE, CALLED UNCONDITIONALLY, because it is a hook. The
  // landing branch passes a `none` target and a null panel, which polls nothing
  // and renders nothing.
  const target: ExplainPaneTarget =
    q === '' ? { kind: 'none' } : { kind: 'question', question: q, from: direction.from, to: direction.to };
  const explanation = useExplainPane({ panel, target });

  // ONE COLUMN, ONE WIDTH, AT EVERY VIEWPORT, the same `max-w-2xl` the
  // translator uses. The two screens are one product and a reader switches
  // between them mid-thought.
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <ExplainPanes
        q={q}
        direction={direction}
        pair={pair}
        explanation={explanation}
        hideByDefault={hideByDefault}
        // WHAT AN UNTOUCHED SCREEN SHOWS, where the answer card will go. One
        // line saying what this box is for, because an empty state is not an
        // error and must never read as one: DESIGN.md section 9 rule 5.
        emptyPane={<ExplainLandingHint signedIn={signedIn} source={pair.source} />}
      />

      {/* The language pair WRITE, and it renders nothing. It writes both copies,
          the device store and the cookie the server reads on the next request,
          so a pair stated here is still stated when the reader switches back to
          the translator. */}
      <PersistLanguagePair pair={pair} />
    </div>
  );
}
