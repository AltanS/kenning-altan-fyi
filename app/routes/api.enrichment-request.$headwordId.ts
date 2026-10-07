import type { Route } from './+types/api.enrichment-request.$headwordId';
import { jsonError } from '#app/lib/api-auth.server';
import { isServedLanguage } from '#app/lib/dictionary/detect-language';
import { entryHeadwordQuery, entrySensesQuery } from '#app/lib/dictionary/entry.server';
import { createEntryLookups, resolveEntry } from '#app/lib/dictionary/queries.server';
import { MISSING_ENTRY_PANEL, resolveTriggeredPanel } from '#app/lib/enrichment/trigger.server';
import { requireVoterAccount } from '#app/lib/votes/account-gate.server';
import { authMiddleware } from '#app/middleware/auth';
import { getRawDb } from '#drizzle/db';

/**
 * `POST /api/enrichment-request/:headwordId?to=<code>`, the "Write the
 * explanation" button's half (M209).
 *
 * IT GOES THROUGH THE SAME GUARDED PATH A PAGE LOAD DOES, NOT A BARE JOB SEND.
 *   `resolveTriggeredPanel` reads the cache, then runs the rate limit and the
 *   budget guard and only then enqueues. A direct enqueue here would be a second,
 *   ungoverned way to spend money, reachable by anybody with a session and a
 *   headword id. A cache hit costs nothing and is never counted, exactly as on
 *   the search screen.
 *
 * IT RECEIVES NO WORD. The path holds a headword id the corpus already knows and
 * the query string holds a language code, so a device dictionary hit, which is
 * the reason this button exists, cannot reach the server through it.
 *
 * IT NEVER THROWS ON A REFUSAL. A rate limit or an exhausted budget comes back as
 * the SAME panel with `refusal` set, a 200, and the card draws its refusal line.
 * What does throw is a wrong verb (405) and a missing session (401, from the
 * middleware).
 *
 * THE PATH SITS BESIDE `/api/enrichment/`, NOT UNDER IT, for the reason the vote
 * route does: as `/api/enrichment/request/...` the `:headwordId` segment of the
 * poll route would swallow it.
 *
 * AN ACCOUNT IS REQUIRED, THROUGH THE SAME MIDDLEWARE THE TRANSLATION RETRY USES.
 *   Under `/api/` it answers a missing session with a 401 in JSON, the only
 *   refusal a `fetch` can make sense of.
 */
export const middleware = [authMiddleware];

export async function action({ params, request }: Route.ActionArgs): Promise<Response> {
  // A GET must not start work. The route has no loader, so a GET already 405s;
  // this guard covers the other verbs a form or a client could send.
  if (request.method !== 'POST') throw jsonError(405, 'method not allowed');

  // NO FALLBACK LANGUAGE. The poll route reads a missing `to` as English because
  // it only reads. This one spends, and a lost `to` must not quietly become a
  // paid job in a language nobody asked for.
  const requestedTo = new URL(request.url).searchParams.get('to');
  if (!isServedLanguage(requestedTo)) return Response.json(MISSING_ENTRY_PANEL);

  const db = getRawDb();
  const resolved = await resolveEntry(createEntryLookups(db), params.headwordId);
  if (resolved.kind !== 'found' || resolved.entity !== 'headword') {
    return Response.json(MISSING_ENTRY_PANEL);
  }

  const [headwordRows, senseRows] = await Promise.all([
    entryHeadwordQuery(db, resolved.id),
    entrySensesQuery(db, resolved.id),
  ]);
  const headword = headwordRows[0];
  if (!headword || !isServedLanguage(headword.languageCode)) {
    return Response.json(MISSING_ENTRY_PANEL);
  }

  const panel = await resolveTriggeredPanel({
    db,
    request,
    headwordId: headword.headwordId,
    senseIds: senseRows.map((row) => row.senseId),
    from: headword.languageCode,
    to: requestedTo,
    // The reader whose request this is, so a `ready` answer already carries their
    // own votes. `authMiddleware` above has established that there IS one.
    accountId: await requireVoterAccount(request),
  });
  return Response.json(panel);
}
