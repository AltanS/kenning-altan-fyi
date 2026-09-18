import type { Route } from './+types/api.explain';
import { explainKeyFromRequest, resolveExplainPanel, type ExplainPanel } from '#app/lib/translation/explain-panel.server';
import { authMiddleware } from '#app/middleware/auth';
import { getUser } from '#app/middleware/helpers';
import { getRawDb } from '#drizzle/db';

/**
 * `GET /api/explain?q=<question>&from=<code>&to=<code>`, where one typed
 * question stands, as JSON.
 *
 * IT NEVER ENQUEUES. THAT IS THE WHOLE POINT.
 *   The pane polls this route every three seconds while a run is open. A read
 *   that also queued work would charge a reader who waited a minute for twenty
 *   runs of one question. The queueing decision is taken once, in the `/explain`
 *   loader, and `resolveExplainPanel` is deliberately free of it so both callers
 *   share one answer. The retry POST beside this one is the only other place an
 *   explain run is ever started.
 *
 * IT NEEDS AN ACCOUNT, exactly as the phrase poll does and for the same reason.
 *   There is no public surface that serves an explanation, so an ungated read
 *   here would be a way to reach this installation's paid answers by typing the
 *   same question and never signing in. `authMiddleware` under `/api/` refuses
 *   with a 401 in JSON rather than a redirect a `fetch` could not act on.
 *
 * A QUERY THIS ROUTE CANNOT READ IS AN ORDINARY 200 CARRYING `no-entry`. A
 * polled URL can go stale, and a 404 would put an error in a browser console for
 * what is really "there is nothing at this address".
 */
export const middleware = [authMiddleware];

/** The answer for every request whose query names no question this route can fold. */
const NO_ENTRY_PANEL: ExplainPanel = { state: 'no-entry' };

export async function loader({ context, request }: Route.LoaderArgs): Promise<Response> {
  const key = explainKeyFromRequest(new URL(request.url));
  if (key === null) return Response.json(NO_ENTRY_PANEL);

  // THE READER IS NAMED SO THE POLL CAN REPORT THEIR OWN VOTE. The pane replaces
  // its whole panel with whatever this route answers, so an anonymous read here
  // would un-press the vote button three seconds after the page loaded it
  // pressed. `authMiddleware` above guarantees the context holds a user.
  const user = getUser(context);

  const panel = await resolveExplainPanel(getRawDb(), { ...key, accountId: user.id });
  return Response.json(panel);
}
