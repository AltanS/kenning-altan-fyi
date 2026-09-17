import { useTranslation } from 'react-i18next';

import { nextTheme, THEME_DETAILS, useThemePreference } from '#app/hooks/use-theme-preference';

/**
 * The colour theme, as ONE button rather than a menu.
 *
 * A MENU WAS THREE CLICKS FOR A TWO-STATE DECISION. Opening a popover, reading
 * three rows and picking one is the wrong ceremony for a control whose whole
 * job is "not this, the other one". The button applies the next state
 * directly, and the icon on it is the state the app is IN, not the state a
 * click would reach: the reader looks at the header to know where they are.
 *
 * THE CYCLE HAS THREE STOPS, NOT TWO, because `system` has to stay reachable.
 * A light/dark flip would strand a reader who had once chosen: there would be
 * no way back to following the operating system, and the app would keep an
 * opinion the reader never meant to make permanent.
 *
 * THIS IS THE PUBLIC HEADER'S CONTROL ONLY. `public-wrapper.tsx` renders it,
 * and that shell has no account, so a cycle button is the whole of what the
 * chrome there can offer. Inside the app shell the same choice is a segmented
 * strip in the account menu (`avatar-menu.tsx`), which has the room to show
 * all three states at once. Both read `useThemePreference`, so the two
 * controls cannot disagree about what is stored or about what the options are.
 */
export function ThemeToggle() {
  const { t } = useTranslation();
  const { theme, selectTheme } = useThemePreference();
  const Icon = THEME_DETAILS[theme].icon;

  return (
    <button
      type="button"
      onClick={() => selectTheme(nextTheme(theme))}
      className="relative inline-flex h-8 w-8 items-center justify-center rounded-lg p-0 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      // The label names the control and the state it is in, so a screen reader
      // hears which theme is active rather than only that a theme button exists.
      aria-label={`${t('theme.selector')}: ${t(`theme.${theme}`)}`}
      title={t(`theme.${theme}`)}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}
