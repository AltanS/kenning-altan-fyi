import { Monitor, Moon, Sun } from 'lucide-react';
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

const themeSchema = z.enum(['system', 'light', 'dark']).catch('system');
type Theme = z.infer<typeof themeSchema>;

declare global {
  interface Window {
    __applyTheme?: () => void;
    __getStoredTheme?: () => string;
  }
}

function getStoredTheme(): Theme {
  // The inline boot script in root.tsx installs `__getStoredTheme`; it is absent
  // during SSR and before hydration, where `system` is the right default.
  return themeSchema.parse(globalThis.window?.__getStoredTheme?.());
}

/**
 * The three states, in the order a click walks them.
 *
 * SYSTEM IS FIRST, AND IT IS WHERE A READER WHO HAS NEVER TOUCHED THIS
 * CONTROL STANDS: nothing in `localStorage` reads back as `system`, so the app
 * follows the operating system until the reader says otherwise. The cycle
 * returns to it, so the reader can hand the decision back.
 */
const THEME_ORDER = ['system', 'light', 'dark'] as const satisfies readonly Theme[];

/** The state one click away from `theme`, wrapping at the end of the order. */
export function nextTheme(theme: Theme): Theme {
  const index = THEME_ORDER.indexOf(theme);
  return THEME_ORDER[(index + 1) % THEME_ORDER.length];
}

const THEME_ICONS = { system: Monitor, light: Sun, dark: Moon } as const;

/**
 * The colour theme, as ONE button rather than a menu.
 *
 * A MENU WAS THREE CLICKS FOR A TWO-STATE DECISION. Opening a popover, reading
 * three rows and picking one is the wrong ceremony for a control whose whole
 * job is "not this, the other one". The button now applies the next state
 * directly, and the icon on it is the state the app is IN, not the state a
 * click would reach: the reader looks at the header to know where they are.
 *
 * THE CYCLE HAS THREE STOPS, NOT TWO, because `system` has to stay reachable.
 * A light/dark flip would strand a reader who had once chosen: there would be
 * no way back to following the operating system, and the app would keep an
 * opinion the reader never meant to make permanent.
 */
export function ThemeToggle() {
  const { t } = useTranslation();
  const [theme, setTheme] = useState<Theme>(getStoredTheme);

  // Sync state from localStorage on mount
  useEffect(() => {
    setTheme(getStoredTheme());
  }, []);

  // Apply theme when it changes
  useEffect(() => {
    localStorage.setItem('theme', theme);
    window.__applyTheme?.();
  }, [theme]);

  // Listen for system preference changes
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      window.__applyTheme?.();
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  const Icon = THEME_ICONS[theme];

  return (
    <button
      type="button"
      onClick={() => setTheme(nextTheme(theme))}
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
