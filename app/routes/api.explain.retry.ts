import type { Route } from './+types/api.explain.retry';
import { jsonError } from '#app/lib/api-auth.server';
import {
  explainKeyFromRequest,
  resolveTriggeredExplainPanel,
  type ExplainPanel,
} from '#app/lib/translation/explain-panel.server';
import { authMiddleware } from '#app/middleware/auth';
import { getUser } from '#app/middleware/helpers';
import { getRawDb } from '#drizzle/db';

/**
 * `POST /api/explain/retry?q=<question>&from=<code>&to=<code>`, the retry
 * button's half.
 *
 * IT GOES THROUGH THE SAME GATE THE PAGE DOES, NOT A BARE JOB SEND.
 *   `resolveTriggeredExplainPanel` runs the same four guards in the same order,
 *   and `retry: true` is the only difference: it steps over the failure the
 *   reader is looking at instead of returning it unchanged. A direct enqueue
 *   here would be a second, ungoverned way to spend money, reachable by anybody
 *   with a session and a question.
 *
 * THE RETRY WRITES A NEW ROW, IT DOES NOT REWRITE THE FAILED ONE.
 *   `explanations` is append-only and the pane reads the LATEST row, so a reader
 *   who retries twice before the first retry settles still reads a correct state
 *   rather than an ambiguous shared row. pg-boss does not block the re-enqueue
 *   either: the queue's `stately` policy indexes
 *   `(name, state, singleton_key) WHERE state <= 'active'`, and a job that has
 *   failed or completed is past `active`, so the app-level gate above is what
 *   stops a reader queueing two jobs for one failure.
 *
 * AN ACCOUNT IS REQUIRED, THROUGH THE SAME MIDDLEWARE THE GATED SCREENS USE. It
 * starts a billed run, so there is no reading of this route on which a
 * signed-out caller belongs.
 */
export const middleware = [authMiddleware];

/** The answer for every request whose query names no question this route can fold. */
const NO_ENTRY_PANEL: ExplainPanel = { state: 'no-entry' };

export async function action({ request, context }: Route.ActionArgs): Promise<Response> {
  // A GET must not start work. The route has no loader, so a GET already 405s;
  // this guard covers the other verbs a form or a client could send.
  if (request.method !== 'POST') throw jsonError(405, 'method not allowed');

  const key = explainKeyFromRequest(new URL(request.url));
  if (key === null) return Response.json(NO_ENTRY_PANEL);

  // WHO IS RETRYING, FROM THE MIDDLEWARE THAT ALREADY RESOLVED THEM. A retry may
  // open a fresh row, and every row this app opens is written with its author in
  // the same transaction, so the resolver below needs the reader. It cannot fail
  // here: the route carries `authMiddleware`.
  const user = getUser(context);

  const panel = await resolveTriggeredExplainPanel(getRawDb(), {
    ...key,
    request,
    retry: true,
    userId: user.id,
  });
  return Response.json(panel);
}
