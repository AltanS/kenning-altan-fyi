import type { Route } from './+types/welcome';
import { redirect, type MetaFunction } from 'react-router';
import { useTranslation } from 'react-i18next';

import { Link } from '#app/components/link';
import PublicWrapper from '#app/components/public-wrapper';
import { buttonVariants } from '#app/components/ui/button';
import { documentTitle, metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { SIGN_IN_PATH, SIGN_UP_PATH } from '#app/lib/auth/paths';
import { cn } from '#app/lib/utils';
import { resolveUser } from '#app/middleware/auth';

/**
 * The front door (M199).
 *
 * WHAT IT REPLACED, AND WHY. A signed-out visitor at `/`, `/translate` or
 * `/explain` was handed the entire app shell: a sidebar offering lists,
 * favourites and history, a language bar, an input card and a mode switch,
 * none of which they could use. Every control on the screen refused them, and
 * the only way to learn that was to press one. This screen is what they get
 * instead, and the two routes that used to show them the shell now hop here or
 * to `/sign-in`.
 *
 * IT IS IN `_public`, NOT IN THE APP SHELL. That is the whole point of the
 * change rather than a detail of it: `_public` renders a header, a theme
 * toggle and nothing else, so there is no navigation here to refuse anybody.
 * The five account doors sit in `_auth-shell` for a related reason, stated in
 * that file: the app shell's 256px sidebar pushes a centred card off the
 * viewport centre.
 *
 * IT SAYS ONE THING, AND THEN SHOWS IT. One sentence naming what this product
 * does, the two doors, and under them one specimen entry card: a real word,
 * its translation and a sentence it appears in. Not a feature list. A claim is
 * something a reader without an account has to take on trust; a worked example
 * is the claim already carried out, and it is the only thing on this screen
 * that answers "what will I get" without asking anybody to sign up first.
 *
 * THE SPECIMEN IS STATIC AND INERT. No link, no hover, no control. It is a
 * picture of an answer, not an answer: a card that looked pressable here would
 * lead a signed-out reader straight into the gate this screen exists to keep
 * them out of.
 *
 * NO BRAND WASH, and it is not a hero (DESIGN.md section 1 rule 1 and section
 * 3). The amber is on the primary button, which is the one thing here somebody
 * is meant to press.
 *
 * ITS COPY IS ITS OWN NAMESPACE, `welcome`, for the reason `legal` is one: it
 * is read on no other screen, so a rewrite of the front door must not be able
 * to reach a nav label. `APP_NAME` is NOT in it. The product name is a proper
 * noun with one definition (`app/lib/app-name.ts`), and a copy of it in two
 * catalogues is a rename that reaches half the app.
 */
export const meta: MetaFunction = ({ matches }) => {
  const language = metaLanguage(matches);
  return [
    { title: documentTitle(language, 'welcome:meta.title') },
    { name: 'description', content: metaTitle(language, 'welcome:meta.description') },
  ];
};

/**
 * Sends a reader who already holds an account to the product.
 *
 * IT REFUSES NOBODY. Like `/sign-in` and `/sign-up`, it answers a question the
 * reader has already finished rather than turning anyone away, so this route
 * stays `public` in `app/lib/route-classification.ts`.
 *
 * @param request the incoming request, read only for its session cookie.
 * @returns nothing. The screen needs no data.
 * @throws a `redirect` Response when the caller is signed in.
 */
export async function loader({ request }: Route.LoaderArgs): Promise<null> {
  if ((await resolveUser(request)) !== null) throw redirect('/');
  return null;
}

export default function WelcomeRoute() {
  const { t } = useTranslation('welcome');

  return (
    <PublicWrapper>
      <div className="mx-auto flex max-w-lg flex-col gap-5 rounded-2xl border p-5">
        {/* THE SENTENCE IS THE HEADING. The wordmark stood here as an `h1` and
            the app header renders that same word a few pixels above, so the
            product name was on screen twice and the page's only top-level
            heading said nothing about what the page is for. */}
        <h1 className="font-display text-2xl font-semibold tracking-tight">{t('body')}</h1>
        {/* THE BUTTONS ARE 44px TALL AND FULL WIDTH BELOW `sm`. This screen is
            met on a phone more often than any other in the product, and both
            of these are thumb targets rather than links inside a paragraph.
            They become a row at `sm` and up, where a full-width button reads
            as a banner. */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Link to={SIGN_UP_PATH} className={cn(buttonVariants(), 'h-11 w-full sm:w-auto')}>
            {t('createAction')}
          </Link>
          <Link to={SIGN_IN_PATH} className={cn(buttonVariants({ variant: 'outline' }), 'h-11 w-full sm:w-auto')}>
            {t('signInAction')}
          </Link>
        </div>
        <SpecimenEntry />
      </div>
    </PublicWrapper>
  );
}

/**
 * One entry card, drawn exactly as the product draws them, and doing nothing.
 *
 * IT FOLLOWS THE ENTRY CARD RECIPE (DESIGN.md section 3): the term monospaced
 * at `text-lg font-semibold`, the translation monospaced at `text-base`, the
 * example in the sans face and quieter. What it deliberately drops is the
 * interactive half of that recipe, the hover shadow and the border change:
 * nothing here is pressable, and a card that lifts under the pointer promises
 * otherwise.
 *
 * `lang="de"` ON THE GERMAN TEXT, which is not decoration. A screen reader
 * loads a German voice for it and reads "Feierabend" as a German word rather
 * than as English letters (DESIGN.md section 4).
 */
function SpecimenEntry() {
  const { t } = useTranslation('welcome');

  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="font-mono text-lg font-semibold tracking-tight" lang="de">
        {t('example.term')}
      </p>
      <p className="font-mono text-base">{t('example.translation')}</p>
      <p className="mt-3 text-sm text-muted-foreground" lang="de">
        {t('example.sentence')}
      </p>
      <p className="text-sm text-muted-foreground">{t('example.sentenceTranslation')}</p>
    </div>
  );
}
