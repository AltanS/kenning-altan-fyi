import { useTranslation } from 'react-i18next';
import type { MetaFunction } from 'react-router';
import { Link } from 'react-router';
import type { Route } from './+types/settings';
import { InstallApp } from '#app/components/install-app';
import { LanguageToggle } from '#app/components/language-toggle';
import { documentTitle, metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { resolveUser } from '#app/middleware/auth';

export const meta: MetaFunction = ({ matches }) => {
  const language = metaLanguage(matches);
  return [
    { title: documentTitle(language, 'settings.metaTitle') },
    { name: 'description', content: metaTitle(language, 'settings.metaDescription') },
  ];
};

/**
 * Whether this browser is signed in.
 *
 * ONE BIT, AND IT GATES NOTHING. This screen renders in both states; the value
 * decides which card is shown, and every real gate re-reads the user itself.
 */
export async function loader({ request }: Route.LoaderArgs): Promise<{ isSignedIn: boolean }> {
  return { isSignedIn: (await resolveUser(request)) !== null };
}

export default function SettingsRoute() {
  const { t } = useTranslation();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="rounded-xl border bg-card p-6">
        <h2 className="font-display text-base font-semibold">{t('settings.appearanceTitle')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('settings.appearanceBody')}</p>
      </div>
      {/* The app language is a real, working control, so it gets its own card
          rather than a line inside the one above, which describes things that
          are not built yet. */}
      <div className="rounded-xl border bg-card p-6">
        <h2 className="font-display text-base font-semibold">{t('settings.languageTitle')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('settings.languageBody')}</p>
        <div className="mt-4">
          <LanguageToggle />
        </div>
      </div>
      {/* Renders nothing on a device that cannot install the app, and on one
          that already has, so there is no empty card to explain. */}
      <InstallApp />
      <LegalLinksCard />
    </div>
  );
}

/**
 * The way into the imprint, the privacy policy and the terms.
 *
 * THIS IS THE ONLY PLACE THESE LINKS LIVE, AND THAT IS DELIBERATE. `AppWrapper`
 * carried a matching footer on every screen until it was tried and removed: a
 * bottom tab bar and a sidebar are destinations a person USES, and a privacy
 * policy is not one of them, so a line about it on every screen was noise
 * rather than access. Settings is the screen a reader already opens to find
 * out what the app does with their words, so the three documents hang off it
 * instead, and each document cross-links to the other two once you are inside.
 *
 * The labels come from the `legal` namespace, not from `common`, so the whole
 * legal vocabulary lives in one catalogue.
 */
function LegalLinksCard() {
  const { t } = useTranslation('legal');

  return (
    <div className="rounded-xl border bg-card p-6">
      <h2 className="font-display text-base font-semibold">{t('links.title')}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{t('links.body')}</p>
      <ul className="mt-4 flex list-none flex-wrap gap-x-6 gap-y-2 pl-0 text-sm">
        <li>
          <Link to="/legal/imprint" className="underline underline-offset-4">
            {t('links.imprint')}
          </Link>
        </li>
        <li>
          <Link to="/legal/privacy" className="underline underline-offset-4">
            {t('links.privacy')}
          </Link>
        </li>
        <li>
          <Link to="/legal/terms" className="underline underline-offset-4">
            {t('links.terms')}
          </Link>
        </li>
      </ul>
    </div>
  );
}
