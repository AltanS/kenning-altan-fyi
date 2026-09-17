/**
 * avatar-menu.tsx, the app shell's top-right control, at every breakpoint.
 *
 * WHAT IT REPLACED, AND WHY. The header carried two things side by side: the
 * reader's raw email address as a link to `/account`, and the theme cycle
 * button. On a 390px phone the address took most of the header and crowded the
 * screen title beside it, which is what a `max-w-[40%]` cap and two `min-w-0`s
 * were there to contain. A fixed-width trigger removes the problem rather than
 * capping it: the address is still one tap away, it is just inside the menu
 * where it has a full row to sit on.
 *
 * WHAT IT IS ABOUT. The account and the two device preferences: who this
 * browser is signed in as, the way in or the way out, and the two settings a
 * reader flips mid-task, the theme and the app language. Both of those live in
 * `/settings` too and neither is duplicated logic: the theme goes through
 * `useThemePreference` and the language through `selectLanguage`, the same
 * calls the settings screen makes.
 *
 * WHAT IT IS NOT. It is not a third copy of the navigation. The destinations
 * here are deliberately not catalog items (see `app-sidebar.tsx`): the tabs
 * and the drawer own the map of the app, and this owns the account and the
 * device. Two rows lead out of it, `/account` and `/settings`, and that is the
 * whole of it.
 *
 * IT READS THE ROOT LOADER, NOT A SESSION. `userEmail` is a label for the
 * chrome and nothing more; every real gate re-reads the user on the server. It
 * comes from `root` rather than from a layout loader so it survives the
 * offline fallback in `root.tsx` unchanged.
 */
import { useTranslation } from 'react-i18next';
import { useRouteLoaderData, useSubmit } from 'react-router';
import { LogIn, LogOut, Settings, User } from 'lucide-react';

import { Link } from '#app/components/link';
import { isTheme, THEME_OPTIONS, useThemePreference } from '#app/hooks/use-theme-preference';
import {
  DEFAULT_LANGUAGE,
  isLanguageCode,
  LANGUAGE_LABELS,
  selectLanguage,
  SUPPORTED_LANGUAGES,
} from '#app/i18n/language-prefs';
import { BUILD, formatBuildLabel } from '#app/lib/build-info';
import { cn } from '#app/lib/utils';

import { Avatar, AvatarFallback } from './ui/avatar';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

/** The one account row the menu offers, and which way it points. */
export type AvatarMenuDoor = 'sign-in' | 'sign-out';

/**
 * Which account door this menu shows.
 *
 * It is one line, and it is a function rather than a condition in the JSX
 * below for two reasons. A test can assert it with no DOM, and there is
 * exactly one place to change when a third state arrives, which it did in the
 * sibling product this menu is modelled on: an instance with no accounts at
 * all has no door, and an instance nobody may sign up to has a different one.
 * This app has neither state today, because signup is open and an account is
 * required for every search (AGENTS.md), so the answer here is the signed-in
 * question and nothing else.
 *
 * @param isSignedIn - whether the root loader named an account for this request.
 */
export function resolveAvatarMenuDoor({ isSignedIn }: { isSignedIn: boolean }): AvatarMenuDoor {
  if (isSignedIn) return 'sign-out';
  return 'sign-in';
}

/** Shared classes for the two plain destination rows, so they cannot drift apart. */
const MENU_ROW = 'cursor-pointer py-2';

/** Shared classes for one cell of a segmented strip, theme or language. */
const SEGMENT_CELL = cn(
  // The primitive's first child is its absolutely positioned dot indicator. A
  // segmented cell says "selected" with the whole filled cell instead, so the
  // dot, and the `pl-8` reserved for it, both go away.
  '[&>span:first-child]:hidden',
  'min-w-0 cursor-pointer justify-center rounded-md px-2 py-2 text-[11px] font-medium',
  'text-muted-foreground data-[state=checked]:bg-background data-[state=checked]:text-foreground',
  'data-[state=checked]:shadow-sm data-[state=checked]:ring-1 data-[state=checked]:ring-brand-ink/20',
);

/**
 * The way out. It POSTs to `/sign-out` rather than linking to it, because
 * `/sign-out` answers a GET with a redirect that changes nothing: a link there
 * would be a sign-out any prefetcher could trip, which is why that route is
 * POST only. The submit goes through react-router's own data flow, so
 * `sign-out.tsx`'s `clientAction` runs, and that is the step that empties this
 * device before the server destroys the cookie.
 */
function SignOutRow() {
  const { t } = useTranslation();
  const submit = useSubmit();

  return (
    <DropdownMenuItem
      className={MENU_ROW}
      onSelect={() => {
        void submit(null, { method: 'post', action: '/sign-out' });
      }}
    >
      <LogOut className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span>{t('account.signOutAction')}</span>
    </DropdownMenuItem>
  );
}

/** The way in, for a reader whose device is carrying no account. */
function SignInRow() {
  const { t } = useTranslation();

  return (
    <DropdownMenuItem asChild className={MENU_ROW}>
      <Link to="/sign-in">
        <LogIn className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span>{t('account.signInAction')}</span>
      </Link>
    </DropdownMenuItem>
  );
}

/**
 * The top line of the menu: who this browser is signed in as.
 *
 * The address is `font-mono text-xs` and truncated, because it can be longer
 * than the menu is wide, and this is the one place in the chrome that still
 * shows it where it fits. Signed out, the line says so rather than being
 * absent: a menu that opens on a sign-in row with no heading does not tell the
 * reader why the row is there.
 */
function IdentityLabel({ email }: { email: string | null }) {
  const { t } = useTranslation();

  if (email === null) {
    return (
      <DropdownMenuLabel className="py-2 font-normal text-muted-foreground">
        {t('account.signedOutLabel')}
      </DropdownMenuLabel>
    );
  }

  return <DropdownMenuLabel className="truncate py-2 font-mono text-xs font-normal">{email}</DropdownMenuLabel>;
}

/** The account door, whichever one `resolveAvatarMenuDoor` chose. */
function AccountDoor({ door }: { door: AvatarMenuDoor }) {
  if (door === 'sign-out') return <SignOutRow />;
  return <SignInRow />;
}

/**
 * The theme choice as a segmented row.
 *
 * KEYBOARD: these are real Radix `RadioItem`s, so the group keeps menu
 * semantics. Radix's roving focus walks items in DOM order with Up and Down
 * whatever the visual layout, and Left and Right stay reserved for sub-menus.
 * A horizontal strip of plain buttons would have looked identical and been
 * unreachable by keyboard, so the layout here is CSS only and the elements are
 * unchanged.
 *
 * `preventDefault` on select is what keeps the menu OPEN: switching theme is
 * something a reader does in order to LOOK at the page behind the menu, and
 * closing on each try makes comparing light and dark a three-tap loop.
 */
function ThemeRow() {
  const { t } = useTranslation();
  const { theme, hydrated, selectTheme } = useThemePreference();

  return (
    <DropdownMenuRadioGroup
      // Before hydration nothing is marked selected. The server cannot read
      // `localStorage`, so showing `system` as active would be a guess, and a
      // wrong one for every reader who has ever chosen.
      value={hydrated ? theme : ''}
      onValueChange={(value) => {
        // Radix hands back a plain string. Narrow it rather than assert it: an
        // unknown value must be ignored, never written to storage the boot
        // script reads before first paint.
        if (isTheme(value)) selectTheme(value);
      }}
      className="grid grid-cols-3 gap-1 rounded-lg bg-muted/40 p-1"
    >
      {THEME_OPTIONS.map((option) => {
        const Icon = option.icon;
        return (
          <DropdownMenuRadioItem
            key={option.value}
            value={option.value}
            onSelect={(event) => event.preventDefault()}
            className={cn(SEGMENT_CELL, 'flex-col gap-1')}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            <span>{t(option.labelKey)}</span>
          </DropdownMenuRadioItem>
        );
      })}
    </DropdownMenuRadioGroup>
  );
}

/**
 * The app language, in the same grammar as the theme above it.
 *
 * The options are the NATIVE names, never translated. A visitor who has landed
 * in a language they cannot read has to be able to find their own one in the
 * list, and a translated list defeats exactly that. `lang` on each cell tells a
 * screen reader to pronounce the name that way.
 *
 * NO `preventDefault` HERE, unlike the theme. `selectLanguage` writes the
 * cookie and the localStorage mirror and then reloads the document, so the
 * server re-renders from the new cookie and the page is never half translated.
 * There is no menu left to keep open.
 *
 * NO HYDRATION GATE EITHER. The theme lives in storage the server cannot read;
 * the language is the cookie this very document was rendered from, so the
 * active code is known on the first paint and is marked from the start.
 */
function LanguageRow() {
  const { i18n } = useTranslation();
  const active = i18n.resolvedLanguage ?? i18n.language;
  const value = isLanguageCode(active) ? active : DEFAULT_LANGUAGE;

  return (
    <DropdownMenuRadioGroup
      value={value}
      onValueChange={(next) => {
        // Narrow rather than assert, for the same reason the theme row does:
        // an unsupported code must be ignored, never written to the cookie the
        // server renders from.
        if (isLanguageCode(next)) selectLanguage(next);
      }}
      className="grid grid-cols-2 gap-1 rounded-lg bg-muted/40 p-1"
    >
      {SUPPORTED_LANGUAGES.map((code) => (
        <DropdownMenuRadioItem key={code} value={code} lang={code} className={SEGMENT_CELL}>
          <span>{LANGUAGE_LABELS[code]}</span>
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}

export function AvatarMenu() {
  const { t } = useTranslation();
  const rootData = useRouteLoaderData<{ userEmail: string | null }>('root');
  const email = rootData?.userEmail ?? null;
  const door = resolveAvatarMenuDoor({ isSignedIn: email !== null });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* Below `sm` the trigger is the circle alone, so the `aria-label`
            carries the meaning whether or not the word beside it is drawn. The
            label is never the address: an address is a long, variable string
            and it is the thing that made the old header overflow. `pr-2 -mr-2`
            cancels the ghost button's right padding, so this control sits the
            same distance from the header's right edge as the drawer trigger
            sits from the left. */}
        <Button variant="ghost" className="-mr-2 flex items-center gap-2 pr-2" aria-label={t('account.menuLabel')}>
          <Avatar className="h-7 w-7">
            <AvatarFallback className="text-sm">
              <User className="h-4 w-4" aria-hidden="true" />
            </AvatarFallback>
          </Avatar>
          <span className="hidden text-sm sm:inline">{t('nav.account')}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <IdentityLabel email={email} />

        <AccountDoor door={door} />

        {email !== null && (
          <DropdownMenuItem asChild className={MENU_ROW}>
            <Link to="/account">
              <User className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span>{t('nav.account')}</span>
            </Link>
          </DropdownMenuItem>
        )}

        <DropdownMenuItem asChild className={MENU_ROW}>
          <Link to="/settings">
            <Settings className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span>{t('nav.settings')}</span>
          </Link>
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="py-1 text-xs font-medium text-muted-foreground">
          {t('theme.selector')}
        </DropdownMenuLabel>
        <ThemeRow />

        <DropdownMenuLabel className="py-1 text-xs font-medium text-muted-foreground">
          {t('settings.languageTitle')}
        </DropdownMenuLabel>
        <LanguageRow />

        {/* WHICH BUILD THIS PAGE IS, AT THE FOOT AND OUT OF THE WAY.
            It is a line of text and not a menu item: it leads nowhere, it takes
            no keyboard focus, and picking nothing means there is nothing for it
            to close. It is here because it is the one fact an operator or a
            reporter needs in order to say WHICH version misbehaved, and asking
            somebody to find that in a page source is asking them not to say.
            The stamp comes from the bundle this page is running, never from the
            server, which is the whole point of it. */}
        <div className="px-2 pb-1 pt-2 text-xs text-muted-foreground">{formatBuildLabel(BUILD)}</div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
