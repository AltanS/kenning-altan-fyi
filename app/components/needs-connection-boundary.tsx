import { useTranslation } from 'react-i18next';
import { useRevalidator, useRouteError } from 'react-router';
import { Button } from '#app/components/ui/button';
import { isServerUnreachable } from '#app/lib/offline/unreachable';

/**
 * The body of a route `ErrorBoundary` that turns "the server cannot be reached"
 * into one calm card, and passes everything else on.
 *
 * IT CATCHES ONE KIND OF ERROR. `isServerUnreachable` is true for a browser that
 * says it is offline, a failed fetch and a 502, 503 or 504. Anything else is
 * rethrown. A route's `ErrorBoundary` that throws while rendering hands the error
 * to the nearest boundary ABOVE it, exactly as if the route had exported none, so
 * a redirect, a 401, a 404 and a real bug never wear an offline face.
 *
 * THE BUTTON RE-RUNS THE LOADERS (`revalidate`) and does not reload the document.
 * A document navigation offline is turned into `/offline` by the service worker,
 * which would trade this card for a second one. When the connection is back the
 * revalidation succeeds and the real screen replaces this card.
 *
 * It is a component and not an `ErrorBoundary` export so two route modules can
 * share one rule. Each route still exports its own `ErrorBoundary` that renders
 * this, because the router finds the export by name.
 */
export function NeedsConnectionBoundary() {
  const error = useRouteError();
  const { t } = useTranslation();
  const revalidator = useRevalidator();

  if (!isServerUnreachable(error)) throw error;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <section className="flex flex-col items-start rounded-lg border bg-muted/40 p-6">
        <h2 className="font-display text-base font-semibold">{t('offline.needsConnection.title')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('offline.needsConnection.body')}</p>
        <Button
          type="button"
          variant="outline"
          className="mt-4"
          pending={revalidator.state !== 'idle'}
          onClick={() => void revalidator.revalidate()}
        >
          {t('offline.retry')}
        </Button>
      </section>
    </div>
  );
}
