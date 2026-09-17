/**
 * use-theme-preference.ts, the colour theme as ONE piece of state.
 *
 * The theme has two controls now: the cycle button in the public header
 * (`theme-toggle.tsx`) and the segmented strip in the account menu
 * (`avatar-menu.tsx`). The storage protocol lives here so both write it the
 * same way, and so the option table below is the only list of themes in the
 * app. Two controls each holding their own `useState` over the same
 * `localStorage` key is how one of them ends up offering a fourth state, or
 * writing a value the boot script cannot read.
 *
 * THE PROTOCOL IS UNCHANGED, and it is not this file's to change: write
 * `localStorage.theme`, then call `window.__applyTheme`, the blocking script
 * in `app/root.tsx` that puts `.dark` on `<html>` before the first paint so a
 * dark-mode reader never sees a white flash. Nothing here touches the DOM
 * itself and nothing here talks to the server: the theme is a device
 * preference, like the app language beside it.
 */
import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { z } from 'zod';

const themeSchema = z.enum(['system', 'light', 'dark']).catch('system');
export type Theme = z.infer<typeof themeSchema>;

declare global {
  interface Window {
    __applyTheme?: () => void;
    __getStoredTheme?: () => string;
  }
}

/**
 * What every control shows for a state: its icon and its wording. Keyed by the
 * state rather than listed, so a lookup for the ACTIVE theme is total and no
 * caller needs a fallback for a state that cannot be missing.
 */
export const THEME_DETAILS = {
  system: { labelKey: 'theme.system', icon: Monitor },
  light: { labelKey: 'theme.light', icon: Sun },
  dark: { labelKey: 'theme.dark', icon: Moon },
} as const satisfies Record<Theme, { labelKey: string; icon: typeof Sun }>;

/**
 * The three states, in the order a click walks them.
 *
 * SYSTEM IS FIRST, AND IT IS WHERE A READER WHO HAS NEVER TOUCHED THIS
 * CONTROL STANDS: nothing in `localStorage` reads back as `system`, so the app
 * follows the operating system until the reader says otherwise. The cycle
 * returns to it, so the reader can hand the decision back.
 */
export const THEME_ORDER = ['system', 'light', 'dark'] as const satisfies readonly Theme[];

/**
 * The options as a table, in display order.
 *
 * ONE TABLE, TWO CONTROLS. The cycle button in the public header walks it and
 * the segmented strip in the account menu draws it, so the two can never offer
 * different options or different words for them.
 */
export const THEME_OPTIONS = THEME_ORDER.map((value) => ({ value, ...THEME_DETAILS[value] }));

/** The state one click away from `theme`, wrapping at the end of the order. */
export function nextTheme(theme: Theme): Theme {
  const index = THEME_ORDER.indexOf(theme);
  return THEME_ORDER[(index + 1) % THEME_ORDER.length];
}

/**
 * Narrows the plain `string` a Radix radio group hands back to a theme.
 *
 * `themeSchema` cannot do this job: it carries `.catch('system')`, so it
 * answers `system` for a value that is not a theme at all rather than
 * refusing it, which is right for reading storage and wrong for a callback
 * where an unknown value must be ignored.
 */
export function isTheme(value: string): value is Theme {
  return THEME_ORDER.some((known) => known === value);
}

/**
 * Reads the stored theme through the `window.__getStoredTheme` bridge the boot
 * script installs, so there is one reader of `localStorage.theme` in the app.
 * The bridge is absent during SSR and before hydration, where `system` is the
 * right default, and the schema's `.catch` answers for anything an extension
 * or an older build wrote into the key.
 */
function getStoredTheme(): Theme {
  return themeSchema.parse(globalThis.window?.__getStoredTheme?.());
}

export interface ThemePreference {
  /** `system` on the server and on the first client render, the stored value after that. */
  theme: Theme;
  /** False until the effect below has read storage. Nothing may be drawn as selected before then. */
  hydrated: boolean;
  selectTheme: (next: Theme) => void;
}

/**
 * @returns the stored theme, whether it has been read yet, and how to change it.
 *
 * `hydrated` EXISTS BECAUSE THE SERVER CANNOT READ `localStorage`. A control
 * that marks a state selected on the server pass is guessing, and it guesses
 * `system` for a reader who chose dark months ago. The strip in the account
 * menu therefore marks nothing until this flips; the cycle button shows the
 * icon for `theme` throughout, which is the same icon the server rendered.
 */
export function useThemePreference(): ThemePreference {
  const [theme, setTheme] = useState<Theme>('system');
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setTheme(getStoredTheme());
    setHydrated(true);
  }, []);

  // Re-apply whenever the operating system flips, so a reader on `system`
  // follows it without a reload.
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => window.__applyTheme?.();
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  function selectTheme(next: Theme): void {
    setTheme(next);
    localStorage.setItem('theme', next);
    window.__applyTheme?.();
  }

  return { theme, hydrated, selectTheme };
}
