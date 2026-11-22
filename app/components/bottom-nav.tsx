import { useTranslation } from 'react-i18next';
import { NavLink } from '#app/components/link';
import { useEffectiveUserId } from '#app/hooks/use-effective-user-id';
import { cn } from '#app/lib/utils';
import { tabNavigationItems, type NavigationItem } from './app-sidebar';

/**
 * The mobile tab bar. It carries the five places you move between, in this
 * order: Translate, Explain, Lists, Favourites and History. Explanations, Quiz,
 * Sources, Settings and Account live in the top-left navigation drawer
 * (`app-wrapper.tsx`), which shows the same complete map the desktop sidebar
 * does.
 *
 * FIVE TABS, AND THE LABELS MUST SURVIVE 360px. Each tab is an equal fifth of
 * the bar, so a long translated label has about 70px. `min-w-0` lets a flex
 * child shrink below its content width and `truncate` on the label span cuts
 * an over-long word with an ellipsis instead of pushing a neighbour out. The
 * text stays `text-xs`; shrinking it further would fail the legibility floor.
 *
 * The tabs are equal. There is no raised centre button, because this app has no
 * single flagship verb, and a raised tab would claim one.
 *
 * THE BAR NAMES NO DESTINATION OF ITS OWN: every label is a catalog key,
 * resolved where each tab is rendered. A key written here would be a second
 * place a destination can be labelled, and the two would eventually disagree.
 *
 * The entries come from the shared catalog, pre-ordered by each item's
 * `tab.order`, so this file lists no catalog keys or hrefs of its own and the
 * bar cannot disagree with the drawer about a destination.
 */
const BOTTOM_NAV_TABS: readonly NavigationItem[] = tabNavigationItems;

/**
 * One tab: icon over label. The active state carries the brand in three places,
 * a top rule, a faint wash and the text colour, so it never depends on hue
 * alone.
 */
function FlatTab({ tab }: { tab: NavigationItem }) {
  const { t } = useTranslation();

  return (
    <NavLink
      to={tab.to}
      // `end` so the Search tab, whose href is `/`, is active on the home page
      // only. Without it react-router treats `/` as a prefix of every route.
      end={tab.to === '/'}
      className={({ isActive }) =>
        cn(
          'relative flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-0.5 text-xs font-medium outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
          isActive ?
            'bg-primary/5 text-brand-ink after:absolute after:inset-x-5 after:top-0 after:h-0.5 after:rounded-full after:bg-brand-ink after:content-[""]'
          : 'text-muted-foreground hover:text-foreground',
        )
      }
    >
      <tab.icon className="h-5 w-5" aria-hidden="true" />
      <span className="max-w-full truncate">{t(tab.labelKey)}</span>
    </NavLink>
  );
}

/**
 * Mobile-only fixed bottom tab bar, hidden at md and up where the sidebar takes
 * over. The `h-14` content height plus the `env(safe-area-inset-bottom)`
 * padding is a contract: `AppWrapper` reserves matching bottom padding, so page
 * content is never hidden behind the bar.
 */
export function BottomNav() {
  const { t } = useTranslation();
  // NOTHING AT ALL FOR A SIGNED-OUT READER. Every tab is behind the account
  // gate, so the bar would be five rows that all end at `/sign-in`, pinned to
  // the bottom of the screen where they cannot be ignored. `AppWrapper` drops
  // the bottom padding that reserves room for it in the same state.
  const userId = useEffectiveUserId();
  if (userId === null) return null;

  return (
    <nav
      aria-label={t('nav.bottomBarLabel')}
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
    >
      <div className="flex h-14 items-stretch">
        {BOTTOM_NAV_TABS.map((tab) => (
          <FlatTab key={tab.to} tab={tab} />
        ))}
      </div>
    </nav>
  );
}
