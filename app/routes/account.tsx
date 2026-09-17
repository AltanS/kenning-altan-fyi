/**
 * `/account`: the address, the password, the export, the door out.
 *
 * ANONYMOUS IS A NORMAL STATE HERE, and this screen reports it rather than
 * ending it. Its loader never redirects, which is what lets the shell link to
 * it from every screen and what lets a signed-out reader still export the data
 * their own device holds.
 *
 * WHAT LEFT THIS SCREEN IN M191. The sign-in name, the device list, the
 * recovery code and the "resume syncing" unlock card were all parts of the
 * encrypted account. There is no key to unlock, no device to revoke and no
 * recovery code to lose: an address and a password replaced all four, and a
 * forgotten password is a mailed link now rather than a dead account.
 *
 * CHANGING THE PASSWORD KEEPS THIS TAB SIGNED IN. `changePassword` moves the
 * session epoch, which refuses every cookie issued before it, this request's
 * included, and hands back a fresh one. Setting that cookie is not optional.
 *
 * DELETING ASKS TWICE, AND THE TWO QUESTIONS ARE DIFFERENT. The password asks
 * whether this is the owner; the `ConfirmAction` dialog that follows asks
 * whether they meant it. The password alone was the whole gate until now, which
 * turned one mis-aimed tap into a deleted account.
 */
import { useState } from 'react';
import { Form, redirect, useNavigation, type MetaFunction } from 'react-router';
import { useTranslation } from 'react-i18next';

import type { Route } from './+types/account';
import { AuthCard, AuthField, AuthNotice } from '#app/components/account/auth-card';
import { ExportDataButton } from '#app/components/account/export-data-button';
import { ConfirmAction } from '#app/components/confirm-action';
import { Button, buttonVariants } from '#app/components/ui/button';
import { Input } from '#app/components/ui/input';
import { Label } from '#app/components/ui/label';
import { Link } from '#app/components/link';
import { documentTitle, metaLanguage } from '#app/i18n/meta-title';
import { requestT } from '#app/i18n/request-t';
import { MIN_PASSWORD_LENGTH } from '#app/lib/auth/password-rule';
import { SIGN_IN_PATH, SIGN_UP_PATH } from '#app/lib/auth/paths';
import { changePassword, deleteAccount } from '#app/services/auth.server';
import { resolveUser } from '#app/middleware/auth';
import { redirectWithToast } from '#app/utils/toast.server';

export const meta: MetaFunction = ({ matches }) => [{ title: documentTitle(metaLanguage(matches), 'account.metaTitle') }];

/** What a post to this screen can report. Each member carries one literal, so each narrows on its own. */
type AccountResult =
  | { status: 'wrong-password' }
  | { status: 'invalid-password' }
  | { status: 'password-mismatch' }
  /**
   * The delete form's refusal, and it is shaped for a FETCHER rather than for
   * this screen's `actionData`. `ConfirmAction` submits the deletion through
   * `useFetcher` and reads `{ success, error }` back, so the sentence is
   * resolved on the server, in the reader's own language, and rendered inside
   * the dialog they are still looking at. It keeps a `status` so every member
   * of this union answers `.status`.
   */
  | { status: 'delete-wrong-password'; success: false; error: string };

/** Anonymous is a NORMAL state here: this screen reports it rather than ending it. */
export async function loader({ request }: Route.LoaderArgs): Promise<{ email: string | null }> {
  const user = await resolveUser(request);
  return { email: user?.email ?? null };
}

export async function action({ request }: Route.ActionArgs): Promise<Response | AccountResult> {
  const user = await resolveUser(request);
  if (user === null) throw redirect(SIGN_IN_PATH);

  const form = await request.formData();

  if (String(form.get('intent') ?? '') === 'delete') {
    const removed = await deleteAccount({ userId: user.id, password: String(form.get('deleteCurrent') ?? '') });
    if (removed.status === 'wrong-password') {
      return { status: 'delete-wrong-password', success: false, error: requestT(request)('account.wrongPassword') };
    }
    // The account is gone, so the cookie names nobody. `/sign-out` would be
    // the tidier destination, but it needs a session to sync one last time and
    // there is nothing left to sync to.
    throw redirect('/');
  }

  const next = String(form.get('next') ?? '');
  if (next !== String(form.get('nextConfirm') ?? '')) return { status: 'password-mismatch' };

  const result = await changePassword({
    userId: user.id,
    current: String(form.get('current') ?? ''),
    next,
    request,
  });
  if (result.status !== 'ok') return { status: result.status };

  // THE CONFIRMATION IS A TOAST, NOT A QUERY FLAG. `?changed=1` said so in the
  // URL, which meant the sentence survived a reload, a share and a bookmark: a
  // reader who came back to that address a week later was told their password
  // had just changed. The flash cookie says it once, to the tab that asked.
  //
  // The fresh cookie is what keeps THIS tab signed in: the change moved the
  // session epoch, so every older cookie, this request's included, is refused
  // from now on. Both cookies ride the same response.
  return redirectWithToast(
    '/account',
    { description: requestT(request)('account.passwordChangedToast'), type: 'success' },
    { headers: { 'Set-Cookie': result.setCookie } },
  );
}

export default function AccountRoute({ loaderData, actionData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { email } = loaderData;
  // THREE FORMS, ONE NAVIGATION, SO THE PENDING STATE IS SCOPED BY WHAT WAS
  // POSTED. A bare `state !== 'idle'` would spin the password button while the
  // reader was signing out. The sign-out form posts to another route, so its
  // own `formAction` names it; the password form is this route's only other
  // navigation, and the deletion never appears here at all because
  // `ConfirmAction` submits through a fetcher.
  const navigation = useNavigation();
  const isNavigating = navigation.state !== 'idle';
  const isSigningOut = isNavigating && navigation.formAction?.endsWith('/sign-out') === true;
  const isChangingPassword = isNavigating && !isSigningOut;

  if (email === null) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <AuthCard title={t('account.title')} headingLevel="h2" description={t('account.signedOutBody')}>
          <div className="flex flex-wrap items-center gap-4">
            <Link to={SIGN_UP_PATH} className={buttonVariants()}>
              {t('account.createAction')}
            </Link>
            <Link to={SIGN_IN_PATH} className="text-sm underline underline-offset-4 hover:text-foreground">
              {t('account.signInAction')}
            </Link>
          </div>
        </AuthCard>
        {/* NO EXPORT CARD FOR A SIGNED-OUT READER, and it is not a feature
            being withheld. Every screen that writes to the device is gated, so
            somebody without an account has nothing on it to export, and
            somebody who just signed out had it wiped. What the card is not free
            of is a side effect: the check it runs on mount OPENS
            `translate-primary` in IndexedDB, which re-creates the database
            sign-out just deleted. */}
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <section className="rounded-xl border bg-card p-6">
        <h2 className="font-display text-base font-semibold">{t('account.title')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('account.signedInBody')}</p>
        <p className="mt-4 font-mono text-sm">{email}</p>
      </section>

      <section className="rounded-xl border bg-card p-6">
        <h2 className="font-display text-base font-semibold">{t('account.changePasswordTitle')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('account.changePasswordBody')}</p>
        <Form method="post" className="mt-6 flex flex-col gap-5">
          <AuthField
            name="current"
            label={t('account.currentPasswordLabel')}
            type="password"
            autoComplete="current-password"
          />
          <AuthField
            name="next"
            label={t('account.newPasswordLabel')}
            type="password"
            autoComplete="new-password"
            hint={t('account.passwordHint')}
          />
          <AuthField
            name="nextConfirm"
            label={t('account.passwordConfirmLabel')}
            type="password"
            autoComplete="new-password"
          />
          {actionData?.status === 'password-mismatch' && <AuthNotice>{t('account.passwordMismatch')}</AuthNotice>}
          {actionData?.status === 'wrong-password' && <AuthNotice>{t('account.wrongPassword')}</AuthNotice>}
          {actionData?.status === 'invalid-password' && (
            <AuthNotice>{t('account.passwordTooShort', { min: MIN_PASSWORD_LENGTH })}</AuthNotice>
          )}
          <Button type="submit" className="self-start" pending={isChangingPassword}>
            {isChangingPassword ? t('account.changingPassword') : t('account.changePasswordSubmit')}
          </Button>
        </Form>
      </section>

      <ExportCard />

      <section className="rounded-xl border bg-card p-6">
        <h2 className="font-display text-base font-semibold">{t('account.signOutTitle')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('account.signOutBody')}</p>
        {/* Posts to `/sign-out`, which syncs once and then empties this device.
            The wipe is why the sentence above warns rather than reassures. */}
        <Form method="post" action="/sign-out" className="mt-4">
          <Button type="submit" variant="outline" pending={isSigningOut}>
            {isSigningOut ? t('account.signingOut') : t('account.signOutAction')}
          </Button>
        </Form>
      </section>

      <section className="rounded-xl border bg-card p-6">
        <h2 className="font-display text-base font-semibold">{t('account.deleteTitle')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('account.deleteBody')}</p>
        <DeleteAccountForm />
      </section>
    </div>
  );
}

/**
 * Deleting the account: the password, then a confirmation dialog.
 *
 * TWO GATES, AND THEY ASK DIFFERENT QUESTIONS. The password asks whether this
 * is the owner; the dialog asks whether they meant it. A screen that asks only
 * the first deletes an account on one mis-aimed tap, and `window.confirm` is
 * banned (DESIGN.md section 10), so the dialog is `ConfirmAction`.
 *
 * THE PASSWORD IS CONTROLLED STATE RATHER THAN A FORM FIELD, because
 * `ConfirmAction` submits its own `FormData` through a fetcher and never reads
 * the surrounding form. Holding the value here is what lets the dialog carry it.
 * It is never sent anywhere but this route's own action.
 */
function DeleteAccountForm() {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');

  return (
    <div className="mt-6 flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Label htmlFor="deleteCurrent">{t('account.currentPasswordLabel')}</Label>
        <Input
          id="deleteCurrent"
          name="deleteCurrent"
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>
      <ConfirmAction
        trigger={
          <Button type="button" variant="destructive" className="self-start" disabled={password === ''}>
            {t('account.deleteSubmit')}
          </Button>
        }
        title={t('account.deleteConfirmTitle')}
        description={t('account.deleteConfirmBody')}
        formData={{ intent: 'delete', deleteCurrent: password }}
        confirmText={t('account.deleteConfirmAction')}
        confirmPendingText={t('account.deletingAccount')}
        confirmVariant="destructive"
        cancelText={t('favourites.removeCancel')}
      />
    </div>
  );
}

/** The export, which works signed in and signed out alike: it reads this device, never the server. */
function ExportCard() {
  const { t } = useTranslation();

  return (
    <section className="rounded-xl border bg-card p-6">
      <h2 className="font-display text-base font-semibold">{t('account.exportTitle')}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{t('account.exportBody')}</p>
      <div className="mt-4">
        <ExportDataButton />
      </div>
    </section>
  );
}
