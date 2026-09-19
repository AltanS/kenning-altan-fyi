import * as React from 'react';
import { useLocation, useMatches, useNavigation, useRouteLoaderData } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { Link } from '#app/components/link';
import { AvatarMenu } from '#app/components/avatar-menu';
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
import { UpdateRibbon } from './update-ribbon';
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
 * `md:hidden`, because at md and up the sidebar is already on screen.
 *
 * THE TRIGGER IS THE MARK, AND THAT IS WHY THE HEADER IS ONE LINE. It used to
 * be a hamburger with a separate mark-link home beside it, which spent two
 * controls and a whole line of a phone header on saying one thing. The drawing
 * carries the brand where the eyebrow used to, and the first tab of the bottom
 * nav is the way home, so the link it replaces had no job left. The button
 * keeps its accessible name, `nav.openMenu`: the mark is a drawing and stays
 * `aria-hidden`, so what a screen reader hears is still what the control does.
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
          {/* THE `aria-hidden` SITS ON A WRAPPER, because `KenningMark` takes a
              class list and nothing else, and it names itself with an
              `aria-label` and a `<title>`. Hidden here, the button's own
              `nav.openMenu` is the single name a screen reader reads; left
              visible, the mark offers the product's name from inside a control
              that opens a menu. */}
          <span aria-hidden="true" className="contents">
            <KenningMark className="size-7" />
          </span>
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
      {/* `min-w-0`: as a flex item beside the sidebar, `main` would otherwise grow to the
          min-content width of a wide table and push the page sideways. */}
      <SidebarInset className="min-w-0">
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
      {/* IN FLOW AND ABOVE THE HEADER, so it reserves its own space. It renders
          nothing at all until this page is two polls behind the server, and
          then it is one line with one button. See
          `#app/components/update-ribbon`. */}
      <UpdateRibbon />
      {/* The chrome sits on `bg-card`, not `bg-background`, so the header is a
          treated surface rather than the same fill as the page under it.
          `border-brand-ink/20` tints the closing hairline the way the active tab
          is tinted, and `AppSidebar`'s header carries the same value so the two
          rules read as one line across the chrome at md and up. */}
      {/* 56px ON THE PHONE, 64px AT md AND UP. It was two stacked lines at
          64px on every width, a wordmark eyebrow over the screen title, and
          the eyebrow said the product's name to a reader who had just tapped
          its icon to get here. The mark in the drawer trigger says it
          instead, in the space the header was already spending, and that
          collapse is a PHONE decision: below md there is no sidebar on
          screen for this hairline to meet. At md and up `AppSidebar` renders
          alongside this header with its own 64px `SidebarHeader`, and the two
          `border-brand-ink/20` hairlines close at the same height and read as
          ONE line across the chrome. `min-h-14` here at 64px would leave an
          8px step where the two rules meet. */}
      <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-brand-ink/20 bg-card md:min-h-16">
        <div className="flex w-full items-center gap-2.5 px-4">
          {/* Desktop only. Below md the drawer trigger beside it opens the same
              list, and two triggers for one sheet is one too many. */}
          <SidebarTrigger className="-ml-1 hidden md:inline-flex" />
          <Separator orientation="vertical" className="mr-2 hidden h-4 md:block" />
          <NavDrawer />
          <div className="flex flex-1 items-center justify-between">
            {/* THE TITLE IS THE ONLY THING IN THIS CELL NOW. It shared a
                two-line column with a mobile wordmark eyebrow, and had a
                separate mark-link home to the left of that column. Both are
                gone: the drawer trigger beside this cell draws the mark, and
                the bottom nav's first tab is the way home, so the header spends
                one line on the one thing that changes per screen. `min-w-0` is
                what lets the `truncate` below act, since a flex item does not
                shrink below its content width without it. */}
            <div className="flex min-w-0 flex-1 items-center">
              {/* `truncate`, because a long title would otherwise wrap the
                  header to a second line on a narrow phone. */}
              <h1 className="truncate font-display text-lg font-semibold leading-tight tracking-tight md:text-xl">
                {title ?? handleTitle ?? activeLabel ?? APP_NAME}
              </h1>
            </div>
            {/* THE ACCOUNT AND THE DEVICE, IN ONE CONTROL. This cell used to
                hold the reader's address beside the theme button, under a
                `min-w-0` and a 40% width cap: an address is a long, variable
                string, and without the cap it ran into the screen title on a
                narrow phone. The trigger inside is a fixed width at every
                breakpoint now, so there is nothing left to cap and nothing
                left to truncate. `shrink-0` keeps it whole when the title
                beside it is long. */}
            <div className="flex shrink-0 items-center">
              <AvatarMenu />
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
          // `py-3` below md rather than `p-4`: the phone screens in this app
          // open with a control the reader came to use, and 16px of dead space
          // above it is 16px of the fold. The horizontal 16px stays, because it
          // is the gutter every card in the well lines up against, and md and up
          // keeps the roomier 24px on both axes.
          'flex-1 px-4 py-3 md:p-6 md:pb-6',
          isSignedIn ? 'pb-[calc(env(safe-area-inset-bottom)+5rem)]' : 'pb-6',
        )}
      >
        {children}
      </div>
      <BottomNav />
    </>
  );
}
