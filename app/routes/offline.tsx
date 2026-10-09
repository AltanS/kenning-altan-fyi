import { WifiOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams, type MetaFunction } from 'react-router';
import { Button } from '#app/components/ui/button';
import { documentTitle, metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { parseOfflineNext } from '#app/lib/auth/safe-next';
import { chooseReturnPath, probeServer } from '#app/lib/offline/return-path';

export const meta: MetaFunction = ({ matches }) => {
  const language = metaLanguage(matches);
  return [
    { title: documentTitle(language, 'offline.metaTitle') },
    { name: 'description', content: metaTitle(language, 'offline.metaDescription') },
  ];
};

/** When this page last sent the browser back to a screen by itself. Per tab, so a new tab starts clean. */
const BOUNCE_KEY = 'kenning.offline.bounce';

/**
 * Two automatic returns closer together than this are a loop, not a recovery.
 *
 * The case it stops: the browser reports it is online but the server never
 * answers. The worker sends every screen here after four seconds, this page
 * sends the reader straight back, and without the limit that repeats forever.
 */
const BOUNCE_WINDOW_MS = 60_000;

function hasBouncedRecently(): boolean {
  try {
    const raw = window.sessionStorage.getItem(BOUNCE_KEY);
    if (raw === null) return false;
    return Date.now() - Number(raw) < BOUNCE_WINDOW_MS;
  } catch {
    // Storage is blocked. Treat that as a recent bounce, because the alternative
    // is a loop that nothing can stop.
    return true;
  }
}

function rememberBounce(): void {
  try {
    window.sessionStorage.setItem(BOUNCE_KEY, String(Date.now()));
  } catch {
    // Nothing to do: `hasBouncedRecently` already treats a blocked store as a bounce.
  }
}

/**
 * The fallback the service worker serves when a document navigation fails with
 * no connection, or does not answer in four seconds. It has NO loader and NO
 * action on purpose: the worker replays a precached copy of this HTML, so
 * anything that needed the network would turn the offline page itself into an
 * offline failure.
 *
 * ── WHERE IT SENDS THE READER ──────────────────────────────────────────────
 *
 * The worker redirects a failed navigation to `/offline?next=<path>`. Once this
 * page has hydrated it takes the reader back to that path, exactly once:
 *
 *   - the server answers a small probe (`/api/build`, two and a half seconds at
 *     most): a full page load, which also replaces the possibly stale root data
 *     embedded in this cached document. It is skipped when the last automatic
 *     return was under a minute ago, which is the hung-network loop described at
 *     `BOUNCE_WINDOW_MS`.
 *   - the probe fails or times out: a client-side navigation, so the screens' own
 *     client loaders decide what to show without a server.
 *
 * `navigator.onLine` is not the test. Wi-Fi with no internet, a VPN interface
 * and a captive portal all report `true` with a dead network, and trusting it
 * sent the reader on a full load that the worker bounced straight back here.
 * Only a browser that says it is OFFLINE skips the probe. The decision itself is
 * `chooseReturnPath`, a pure function with its own test.
 *
 * `next` is read from a query string anybody can type, so `parseOfflineNext`
 * accepts only a same-origin path. The first render never depends on it: this
 * document is server-rendered once, without a query string, and the client has
 * to hydrate it into the same markup.
 *
 * It sits inside the `_app` layout so it carries the same chrome as the other
 * screens. Landing on a bare page with no nav would read as the app having
 * crashed.
 *
 * Translations are bundled inline (see `app/i18n/i18n.ts`), so this renders in
 * the visitor's language while genuinely offline, with no catalog fetch to
 * fail. `meta()` goes through the pure `meta-title` seam, which degrades to the
 * default language when the root match is absent.
 */
export default function OfflineRoute() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const next = parseOfflineNext(searchParams.get('next'));
  const hasLeft = useRef(false);
  const [isStillOffline, setIsStillOffline] = useState(false);

  useEffect(() => {
    // Once per page life. A client navigation that lands back here changes the
    // search params and re-renders this component without remounting it, and
    // trying again would loop.
    if (hasLeft.current) return;
    hasLeft.current = true;
    if (next === null) return;

    const returnToScreen = async (target: string): Promise<void> => {
      const isOnLine = navigator.onLine !== false;
      const isProbeOk = isOnLine && (await probeServer());
      const choice = chooseReturnPath({ isOnLine, isProbeOk, hasBouncedRecently: hasBouncedRecently() });

      if (choice === 'client-navigate') {
        await navigate(target, { replace: true });
        // Reached only when the navigation ended on this page again. When it
        // ended anywhere else this component is gone and the call is a no-op.
        setIsStillOffline(true);
        return;
      }
      if (choice === 'stay') {
        setIsStillOffline(true);
        return;
      }
      rememberBounce();
      window.location.replace(target);
    };
    void returnToScreen(next);
  }, [next, navigate]);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="surface-brand-soft flex flex-col items-start rounded-xl border border-dashed p-6">
        <WifiOff className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
        <h2 className="mt-3 font-display text-base font-semibold">{t('offline.title')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('offline.body')}</p>
        {isStillOffline && (
          <output className="mt-2 block text-sm text-muted-foreground">{t('offline.stillOffline')}</output>
        )}
        <Button type="button" className="mt-4" onClick={() => window.location.replace(next ?? '/')}>
          {t('offline.retry')}
        </Button>
      </div>
    </div>
  );
}
