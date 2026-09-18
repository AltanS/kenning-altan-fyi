import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { MetaFunction } from 'react-router';
import { Link, useFetcher } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import type { Route } from './+types/settings';
import { InstallApp } from '#app/components/install-app';
import { LanguageToggle } from '#app/components/language-toggle';
import { Button } from '#app/components/ui/button';
import { Input } from '#app/components/ui/input';
import { Label } from '#app/components/ui/label';
import { Switch } from '#app/components/ui/switch';
import { documentTitle, metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { PUBLIC_NAME_MAX_CHARS, PUBLIC_NAME_MIN_CHARS, parsePublicName } from '#app/lib/authorship/public-name';
import { resolveUser } from '#app/middleware/auth';
import {
  clearPublicName,
  getUserProfile,
  setHideNewExplanationsByDefault,
  setPublicName,
} from '#app/models/user-profiles.server';
import { getRawDb } from '#drizzle/db';

export const meta: MetaFunction = ({ matches }) => {
  const language = metaLanguage(matches);
  return [
    { title: documentTitle(language, 'settings.metaTitle') },
    { name: 'description', content: metaTitle(language, 'settings.metaDescription') },
  ];
};

/** What the settings screen shows a signed-in reader about their own profile. */
export interface SettingsProfile {
  publicName: string | null;
  hideNewExplanationsByDefault: boolean;
}

/**
 * Whether this browser is signed in, and this reader's own profile.
 *
 * ONE BIT, AND IT GATES NOTHING. This screen renders in both states; the value
 * decides which cards are shown, and every real gate re-reads the user itself.
 * `profile` follows the same rule: read only when signed in, and `null`
 * otherwise, never the all-defaults shape a signed-in reader with no row gets.
 */
export async function loader(
  { request }: Route.LoaderArgs,
): Promise<{ isSignedIn: boolean; profile: SettingsProfile | null }> {
  const user = await resolveUser(request);
  if (user === null) return { isSignedIn: false, profile: null };

  const profile = await getUserProfile(getRawDb(), user.id);
  return { isSignedIn: true, profile };
}

const INTENT = {
  SET_NAME: 'set-name',
  CLEAR_NAME: 'clear-name',
  SET_HIDE_DEFAULT: 'set-hide-default',
} as const;

const settingsFormSchema = z.discriminatedUnion('intent', [
  z.object({ intent: z.literal(INTENT.SET_NAME), publicName: z.string() }),
  z.object({ intent: z.literal(INTENT.CLEAR_NAME) }),
  z.object({
    intent: z.literal(INTENT.SET_HIDE_DEFAULT),
    hide: z.enum(['true', 'false']).transform((value) => value === 'true'),
  }),
]);

/** Every way this action can answer, as one union the two cards switch on. */
export type SettingsActionResult =
  | { success: true; intent: typeof INTENT.SET_NAME; publicName: string }
  | { success: true; intent: typeof INTENT.CLEAR_NAME }
  | { success: true; intent: typeof INTENT.SET_HIDE_DEFAULT; hide: boolean }
  | { success: false; intent: typeof INTENT.SET_NAME; error: 'invalid-name' | 'name-taken' }
  | { success: false; intent: null; error: 'unauthenticated' | 'invalid-form' };

/** SQLSTATE 23505, unique_violation. Raised when two readers claim the same folded public name at once. */
const uniqueViolationSchema = z.object({ code: z.literal('23505') });

/**
 * The three writes this screen makes, behind one action.
 *
 * A UNIQUE-VIOLATION ON THE FOLDED NAME IS CAUGHT HERE, NOT IN THE MODEL.
 * `setPublicName` does not swallow it, so a genuine collision on
 * `publicNameFolded`, two readers saving the same name at once, turns into a
 * field error naming the field, never a 500.
 */
export async function action({ request }: Route.ActionArgs): Promise<SettingsActionResult> {
  const user = await resolveUser(request);
  if (user === null) return { success: false, intent: null, error: 'unauthenticated' };

  const parsed = settingsFormSchema.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) return { success: false, intent: null, error: 'invalid-form' };
  const form = parsed.data;
  const db = getRawDb();

  if (form.intent === INTENT.CLEAR_NAME) {
    await clearPublicName(db, user.id);
    return { success: true, intent: INTENT.CLEAR_NAME };
  }

  if (form.intent === INTENT.SET_HIDE_DEFAULT) {
    await setHideNewExplanationsByDefault(db, { userId: user.id, hide: form.hide });
    return { success: true, intent: INTENT.SET_HIDE_DEFAULT, hide: form.hide };
  }

  const publicName = parsePublicName(form.publicName);
  if (publicName === null) return { success: false, intent: INTENT.SET_NAME, error: 'invalid-name' };

  try {
    await setPublicName(db, { userId: user.id, publicName });
  } catch (cause) {
    if (!uniqueViolationSchema.safeParse(cause).success) throw cause;
    return { success: false, intent: INTENT.SET_NAME, error: 'name-taken' };
  }

  return { success: true, intent: INTENT.SET_NAME, publicName };
}

export default function SettingsRoute({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { isSignedIn, profile } = loaderData;

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
      {/* Both cards below need a reader to write to, and a signed-out visitor
          never reaches this loader with one: `_app.gated` already turned them
          back before `resolveUser` ran a second time here. `profile` is the
          value that carries the bit, so the two stay in lock step by
          construction rather than by two separate checks agreeing. */}
      {isSignedIn && profile !== null && (
        <>
          <PublicNameCard publicName={profile.publicName} />
          <DefaultVisibilityCard hideNewExplanationsByDefault={profile.hideNewExplanationsByDefault} />
        </>
      )}
      {/* Renders nothing on a device that cannot install the app, and on one
          that already has, so there is no empty card to explain. */}
      <InstallApp />
      <LegalLinksCard />
    </div>
  );
}

/**
 * The name a reader may choose to write beside their own explanations.
 *
 * IT DOES NOTHING VISIBLE YET. This milestone stores the name; M200 is what
 * turns it into a byline, on the per-item toggle a reader will use to choose
 * it there. The copy says exactly that, and no more.
 */
function PublicNameCard({ publicName }: { publicName: string | null }) {
  const { t } = useTranslation();
  const fetcher = useFetcher<SettingsActionResult>();
  const isSubmitting = fetcher.state !== 'idle';
  const submittedIntent = fetcher.formData?.get('intent');

  useEffect(() => {
    if (fetcher.data?.success !== true) return;
    if (fetcher.data.intent === INTENT.SET_NAME) toast.success(t('settings.publicNameSavedToast'));
    if (fetcher.data.intent === INTENT.CLEAR_NAME) toast.success(t('settings.publicNameClearedToast'));
  }, [fetcher.data, t]);

  const fieldError =
    fetcher.data?.success === false && fetcher.data.intent === INTENT.SET_NAME ?
      fetcher.data.error
    : null;

  function handleClear(): void {
    const body = new FormData();
    body.set('intent', INTENT.CLEAR_NAME);
    void fetcher.submit(body, { method: 'post' });
  }

  return (
    <div className="rounded-xl border bg-card p-6">
      <h2 className="font-display text-base font-semibold">{t('settings.publicNameTitle')}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{t('settings.publicNameBody')}</p>
      <fetcher.Form method="post" className="mt-4 flex flex-col gap-2">
        <input type="hidden" name="intent" value={INTENT.SET_NAME} />
        <Label htmlFor="public-name">{t('settings.publicNameLabel')}</Label>
        <div className="flex flex-wrap gap-2">
          <Input
            // Uncontrolled on purpose: the fetcher, not this component, owns the
            // pending value. `key` forces a remount, and a fresh `defaultValue`
            // with it, whenever the underlying name actually changes, which is
            // the only way an UNCONTROLLED input can pick up a value the loader
            // just revalidated. React does not re-read `defaultValue` on props
            // alone, so without this key a Clear or a Save left the field
            // showing the name the reader had just replaced.
            key={publicName ?? ''}
            id="public-name"
            name="publicName"
            type="text"
            defaultValue={publicName ?? ''}
            minLength={PUBLIC_NAME_MIN_CHARS}
            maxLength={PUBLIC_NAME_MAX_CHARS}
            autoComplete="off"
            className="flex-1"
          />
          <Button type="submit" disabled={isSubmitting} pending={isSubmitting && submittedIntent === INTENT.SET_NAME}>
            {t('settings.publicNameSave')}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={isSubmitting || publicName === null}
            pending={isSubmitting && submittedIntent === INTENT.CLEAR_NAME}
            onClick={handleClear}
          >
            {t('settings.publicNameClear')}
          </Button>
        </div>
        {fieldError === 'invalid-name' && <p className="text-sm text-destructive">{t('settings.publicNameInvalid')}</p>}
        {fieldError === 'name-taken' && <p className="text-sm text-destructive">{t('settings.publicNameTaken')}</p>}
      </fetcher.Form>
    </div>
  );
}

/**
 * Whether this reader's future explanations start out hidden by default.
 *
 * THE COPY DOES NOT CLAIM ENFORCEMENT. This milestone stores the choice;
 * nothing on the write path that generates an explanation reads it back yet.
 * M200 is what makes it take effect, and a control that visibly claimed
 * otherwise would be a UI that lies, which this repo's design principles do
 * not allow.
 *
 * THIS REPO'S FIRST REAL `<Switch>`. The optimistic value comes from
 * `fetcher.formData`, the same rule `app/lib/votes/optimistic.ts` states for
 * a vote button: the in-flight submission already holds what the reader
 * chose, so a second copy in `useState` would disagree with it for one
 * render on every toggle.
 */
function DefaultVisibilityCard({ hideNewExplanationsByDefault }: { hideNewExplanationsByDefault: boolean }) {
  const { t } = useTranslation();
  const fetcher = useFetcher<SettingsActionResult>();
  const isSubmitting = fetcher.state !== 'idle';

  useEffect(() => {
    if (fetcher.data?.success === true && fetcher.data.intent === INTENT.SET_HIDE_DEFAULT) {
      toast.success(t('settings.hideNewExplanationsByDefaultSavedToast'));
    }
  }, [fetcher.data, t]);

  const submittedHide = fetcher.formData?.get('hide');
  const checked = submittedHide === null || submittedHide === undefined ? hideNewExplanationsByDefault : submittedHide === 'true';

  function handleCheckedChange(next: boolean): void {
    const body = new FormData();
    body.set('intent', INTENT.SET_HIDE_DEFAULT);
    body.set('hide', next ? 'true' : 'false');
    void fetcher.submit(body, { method: 'post' });
  }

  return (
    <div className="rounded-xl border bg-card p-6">
      <h2 className="font-display text-base font-semibold">{t('settings.hideNewExplanationsByDefaultTitle')}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{t('settings.hideNewExplanationsByDefaultBody')}</p>
      <p className="mt-2 text-sm text-muted-foreground">{t('settings.hideNewExplanationsByDefaultNotEnforcedYet')}</p>
      <div className="mt-4 flex items-center gap-3">
        <Switch
          checked={checked}
          onCheckedChange={handleCheckedChange}
          disabled={isSubmitting}
          aria-label={t('settings.hideNewExplanationsByDefaultLabel')}
        />
        <Label>{t('settings.hideNewExplanationsByDefaultLabel')}</Label>
      </div>
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
