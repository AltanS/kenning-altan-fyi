import * as React from 'react';
import { useLocation, useMatches, useNavigation, useRouteLoaderData } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Menu } from 'lucide-react';
import { Link } from '#app/components/link';
import { ThemeToggle } from '#app/components/theme-toggle';
import { APP_NAME } from '#app/lib/app-name';
import { KenningMark } from '#app/components/kenning-mark';
import { routeTitle } from '#app/lib/route-title';
import { cn } from '#app/lib/utils';
import { useInstallPrompt } from '#app/hooks/use-install-prompt';
import {
  activeNavigationHref,
  AppSidebar,
  installNavigationAction,
  navigationItems,
  visibleFooterNavigationItems,
  visiblePrimaryNavigationItems,
  type NavigationItem,
} from './app-sidebar';
import { BottomNav } from './bottom-nav';
import { Button } from './ui/button';
import { Separator } from './ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from './ui/sheet';
import { SidebarInset, SidebarProvider, SidebarTrigger } from './ui/sidebar';

/**
 * A thin navigation indicator across the top of the chrome, shown only while a
 * navigation is in flight. The bar itself is the `--animate-loading-bar` token
 * from `app.css`, so its timing is set once for the whole app.
 */
function ProgressBar() {
  const navigation = useNavigation();
  if (navigation.state === 'idle') return null;

  return (
    <div className="fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden" aria-hidden="true">
      <div className="h-full w-1/3 animate-loading-bar bg-primary" />
    </div>
  );
}

/** One drawer row's classes. Active rows carry the brand the same way the sidebar's do. */
function drawerItemClasses(isActive: boolean): string {
  return cn(
    'flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors',
    isActive ? 'bg-primary/10 text-brand-ink' : 'text-foreground hover:bg-muted',
  );
}

/** One drawer destination, the drawer's counterpart to the sidebar's row. */
function DrawerRow({
  item,
  isActive,
  onNavigate,
}: {
  item: NavigationItem;
  isActive: boolean;
  onNavigate: () => void;
}) {
  const { t } = useTranslation();

  return (
    <Link
      to={item.to}
      onClick={onNavigate}
      aria-current={isActive ? 'page' : undefined}
      className={drawerItemClasses(isActive)}
    >
      <item.icon className="h-4 w-4" aria-hidden="true" />
      <span>{t(item.labelKey)}</span>
    </Link>
  );
}

/**
 * The install row in the drawer, the mobile counterpart of the sidebar's.
 *
 * It shares `useInstallPrompt` with the sidebar row and the settings card, and
 * like them it is absent, never disabled, until the browser has actually
 * offered an install. A button is used rather than a link because there is no
 * destination: the browser's own dialog opens over the current screen.
 *
 * @param onNavigate - closes the drawer, as with every other row in it.
 */
function InstallDrawerRow({ onNavigate }: { onNavigate: () => void }) {
  const { t } = useTranslation();
  const offer = useInstallPrompt();

  if (offer.kind !== 'ready') return null;

  return (
    <button
      type="button"
      onClick={() => {
        onNavigate();
        offer.install();
      }}
      className={cn(drawerItemClasses(false), 'w-full border-0 bg-transparent text-left')}
    >
      <installNavigationAction.icon className="h-4 w-4" aria-hidden="true" />
      <span>{t(installNavigationAction.labelKey)}</span>
    </button>
  );
}

/**
 * The mobile navigation drawer. It renders the same catalog the desktop sidebar
 * does, in the same order and with the same footer separation, so a phone user
 * and a laptop user see one map of the app rather than two.
 *
 * `md:hidden`, because at md and up the sidebar is already on screen. There is
 * no logo image to tap yet, so the trigger is a real button with an accessible
 * label rather than a decorative mark.
 */
function NavDrawer() {
  const { t } = useTranslation();
  const location = useLocation();
  const [isOpen, setIsOpen] = React.useState(false);
  const close = (): void => setIsOpen(false);
  const activeHref = activeNavigationHref(location.pathname);
  // Same source and same convenience-not-a-gate reasoning as `AppSidebar`.
  const rootData = useRouteLoaderData<{ isSuperadmin: boolean; userId: number | null }>('root');
  const footerItems = visibleFooterNavigationItems(rootData?.isSuperadmin ?? false);
  const primaryItems = visiblePrimaryNavigationItems((rootData?.userId ?? null) !== null);

  return (
    <Sheet open={isOpen} onOpenChange={setIsOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="size-9 shrink-0 md:hidden" aria-label={t('nav.openMenu')}>
          <Menu className="size-5" aria-hidden="true" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-72 gap-0 p-0 md:hidden">
        <SheetHeader className="border-b">
          <SheetTitle className="font-display text-lg">{APP_NAME}</SheetTitle>
          <SheetDescription className="sr-only">{t('nav.drawerDescription')}</SheetDescription>
        </SheetHeader>
        <nav className="flex flex-col gap-1 p-2">
          {primaryItems.map((item) => (
            <DrawerRow key={item.to} item={item} isActive={activeHref === item.to} onNavigate={close} />
          ))}
          {/* The same footer separation the sidebar draws: the things you set
              once sit below a rule, not among the places you go every day. It
              separates nothing for a signed-out reader, who has no primary
              rows, so it is drawn only when there is something above it. */}
          {primaryItems.length > 0 && <Separator className="my-2" />}
          {footerItems.map((item) => (
            <DrawerRow key={item.to} item={item} isActive={activeHref === item.to} onNavigate={close} />
          ))}
          <InstallDrawerRow onNavigate={close} />
        </nav>
      </SheetContent>
    </Sheet>
  );
}

/**
 * The account slot in the header: the reader's address, or the way to get an
 * account.
 *
 * BOTH STATES ARE A DOOR, AND THAT IS THE POINT. Until M189 the shell showed
 * an anonymous visitor nothing at all about accounts, which was correct while
 * the product was anonymous by default and wrong the moment M184 made an
 * account mandatory: an invited reader had to be told a URL by hand. A signed
 * in reader gets the opposite job done, seeing which account this device is
 * carrying.
 *
 * IT READS THE ROOT LOADER, NOT A SESSION. `userEmail` is a label for the
 * chrome and nothing more; every real gate re-reads the user itself on the
 * server. It comes from `root` rather than from a layout loader so it survives
 * the offline fallback in `root.tsx` unchanged.
 *
 * `truncate` with a width cap, because an address can be long and the header
 * must not grow a second line on a narrow phone. `min-w-0` ON BOTH THE LINK AND
 * THE TEXT IS WHAT LETS `truncate` ACT AT ALL: a flex item does not shrink below
 * its own content unless it is told to, so the 8rem cap was being overrun and on
 * a 390px phone the address ran into the screen title beside it. The share of
 * the header this slot may take is capped by the cell around it, in the header
 * itself, where a percentage has a definite width to resolve against.
 *
 * THE LINK STAYS ON SCREEN BELOW `sm` rather than being hidden. It is the only
 * thing that says which account this device is carrying, and truncated it still
 * leads to `/account`; the drawer's own account row is two taps away, which is
 * not the same thing.
 *
 * IT NEEDS NO PER-PATH EXCEPTION ANY MORE. It used to render nothing on
 * `/sign-in` and `/sign-up`, because a link to the page you are reading is
 * noise. Those five screens left this shell in M191/03 (`_auth-shell.tsx`), so
 * the only screen left that shows both doors as content is `/account`, and a
 * signed-out reader arriving there is exactly who the link is for.
 */
function AccountSlot() {
  const { t } = useTranslation();
  const rootData = useRouteLoaderData<{ userEmail: string | null }>('root');
  const email = rootData?.userEmail ?? null;

  if (email === null) {
    return (
      <Link
        to="/sign-in"
        className="text-sm font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
      >
        {t('account.signInAction')}
      </Link>
    );
  }

  return (
    <Link to="/account" className="flex min-w-0 max-w-32 items-center gap-1 text-sm hover:underline">
      <span className="sr-only">{t('account.title')}</span>
      <span className="min-w-0 truncate font-mono text-xs">{email}</span>
    </Link>
  );
}

export default function AppWrapper({
  title,
  backTo,
  children,
}: {
  title?: string;
  backTo?: string;
  children: React.ReactNode;
}) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <InnerContent title={title} backTo={backTo}>
          {children}
        </InnerContent>
      </SidebarInset>
    </SidebarProvider>
  );
}

function InnerContent({ title, backTo, children }: { title?: string; backTo?: string; children: React.ReactNode }) {
  const { t } = useTranslation();
  const location = useLocation();
  const matches = useMatches();
  // THE BOTTOM PADDING IS A CONTRACT WITH `BottomNav`, so it has to follow the
  // same condition the bar does. The bar renders nothing for a signed-out
  // reader, and 5rem of reserved space under a screen with no bar on it would
  // be a visible empty gap at the foot of the screen.
  const rootData = useRouteLoaderData<{ userId: number | null }>('root');
  const isSignedIn = (rootData?.userId ?? null) !== null;
  // When a route passes no title, two fallbacks answer for it, in order. A
  // route can name itself through a `handle` (see `#app/lib/route-title`),
  // which is the only way a screen inside this layout can reach the header at
  // all. Failing that, the nav catalog already knows the name of the screen the
  // user is on, so the header reads it from there rather than making every
  // route repeat its own label. Screens outside the catalog, `/translate` and
  // `/entry/:id`, are exactly why the handle exists: without it the h1 fell all
  // the way back to the wordmark and the mobile header said "translate" twice.
  const activeHref = activeNavigationHref(location.pathname);
  const activeItem = navigationItems.find((item) => item.to === activeHref);
  const activeLabel = activeItem && t(activeItem.labelKey);
  const handleTitle = routeTitle(matches, (key) => t(key));

  return (
    <>
      <ProgressBar />
      {/* The chrome sits on `bg-card`, not `bg-background`, so the header is a
          treated surface rather than the same fill as the page under it.
          `border-brand-ink/20` tints the closing hairline the way the active tab
          is tinted, and `AppSidebar`'s header carries the same value so the two
          rules read as one line across the chrome at md and up. */}
      <header className="flex min-h-16 shrink-0 items-center gap-2 border-b border-brand-ink/20 bg-card">
        <div className="flex w-full items-center gap-2.5 px-4">
          {/* Desktop only. Below md the drawer trigger beside it opens the same
              list, and two triggers for one sheet is one too many. */}
          <SidebarTrigger className="-ml-1 hidden md:inline-flex" />
          <Separator orientation="vertical" className="mr-2 hidden h-4 md:block" />
          <NavDrawer />
          <div className="flex flex-1 items-center justify-between">
            {/* THE MARK, MOBILE ONLY, AND IT IS A LINK HOME. At md and up the
                sidebar header carries this exact drawing a few pixels away, so
                a second one there is a duplicate rather than emphasis. Below md
                the sidebar is gone and the header carried a word and no mark at
                all, which read as unbranded chrome. Decorative for assistive
                tech: the link is named, the drawing is not. */}
            <Link
              to="/"
              aria-label={APP_NAME}
              className="mr-2.5 shrink-0 transition-opacity hover:opacity-80 md:hidden"
            >
              <KenningMark className="size-8" />
            </Link>
            <div className="flex min-w-0 flex-1 flex-col justify-center gap-px">
              {/* The wordmark, mobile only, beside the mark. At md and up the
                  sidebar's own logo renders this exact word a few pixels away,
                  and a second one there is a duplicate rather than emphasis.
                  Decorative: the page title below names the screen for
                  assistive tech. */}
              <span
                aria-hidden="true"
                className="font-display text-xs font-semibold leading-none text-brand-ink md:hidden"
              >
                {APP_NAME}
              </span>
              {/* `truncate`, because a long title would otherwise wrap the
                  header to a second line on a narrow phone. */}
              <h1 className="truncate font-display text-lg font-semibold leading-tight tracking-tight md:text-xl">
                {title ?? handleTitle ?? activeLabel ?? APP_NAME}
              </h1>
            </div>
            {/* `min-w-0` so the account slot inside it can give way to the
                screen title, a 40% cap below `sm` so it can never take most of a
                phone's header, and `shrink-0` on the theme toggle so the one
                control that cannot truncate never does. The percentage resolves
                against this cell's own flex parent, which has a definite width;
                on the link inside it there would be nothing to resolve. */}
            <div className="flex min-w-0 max-w-[40%] items-center gap-3 sm:max-w-none">
              <AccountSlot />
              <div className="shrink-0">
                <ThemeToggle />
              </div>
            </div>
          </div>
        </div>
      </header>
      {backTo && (
        <div className="border-b bg-muted/50 px-4 py-2 sm:px-6 lg:px-8">
          <Link
            to={backTo}
            className="inline-flex items-center text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />
            {t('nav.back')}
          </Link>
        </div>
      )}
      {/* The bottom padding clears the mobile tab bar, so page content is never
          hidden behind it. The sidebar owns navigation at md and up, where the
          bar is gone and the padding drops back to normal. */}
      <div
        className={cn(
          'flex-1 p-4 md:p-6 md:pb-6',
          isSignedIn ? 'pb-[calc(env(safe-area-inset-bottom)+5rem)]' : 'pb-6',
        )}
      >
        {children}
      </div>
      <BottomNav />
    </>
  );
}
