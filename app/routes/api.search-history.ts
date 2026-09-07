import type { Route } from './+types/api.search-history';
import { z } from 'zod';

import { jsonError } from '#app/lib/api-auth.server';
import { clearSearchHistory, recordSearch, HISTORY_MAX_ENTRIES } from '#app/models/search-history.server';
import { resolveUser } from '#app/middleware/auth';

/**
 * `POST /api/search-history` writes one search into the reader's log, and
 * `DELETE` empties it.
 *
 * AN ACTION ONLY, AND IT ALWAYS ANSWERS JSON. There is no loader: a log is read
 * by the two screens that render it, through their own loaders, and a GET here
 * would serve a second shape of the same rows for somebody to start depending
 * on. Every outcome is a JSON body, never a redirect, because the caller is a
 * fetcher inside an already-rendered page.
 *
 * THE ACCOUNT IS RESOLVED FIRST, BEFORE THE BODY IS READ. A signed-out post
 * therefore learns nothing from a well-formed one, and no row can be written
 * under an id the cookie cannot name. The row IS the reader's, so there is no
 * version of this route that works without one.
 *
 * NOTHING HERE IS LOGGED. This file holds an account and a typed word in one
 * scope. A debug line pairing the two is a search log, whatever it is called,
 * and the model behind it writes none either.
 *
 * IT IS SEPARATE FROM THE SEARCH LOADER ON PURPOSE. The loader knows the query
 * and the reader, so it could write the row itself in one fewer round trip.
 * What it does not know is the ANSWER: the translation pane resolves that after
 * the response has gone, and the row a reader wants to read back carries the
 * word AND what it meant. One recorder that runs twice, on the client, where
 * both facts exist, beats two recorders that each hold half of the row.
 */

/** One posted row, decoded at the boundary. */
const rowSchema = z.object({
  query: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  headwordId: z.string().nullable(),
  /** `null` means "no answer had arrived when this was recorded", which the model never overwrites a real answer with. */
  translation: z.string().nullable(),
  /**
   * When the search ran, in epoch milliseconds. Absent means now, which is the
   * ordinary case: the screen posts as the search happens. It is present only
   * when a device hands over a log it recorded earlier, where taking "now" for
   * every row would flatten a month of searching into one instant.
   */
  at: z.number().int().positive().optional(),
});

/**
 * The body: a batch, even when it holds one row.
 *
 * ONE SHAPE FOR BOTH CALLERS. The search screen posts a single row as it
 * happens, and a device carrying an old local log posts the whole thing once.
 * A separate bulk path would be a second decoder and a second set of guards for
 * the same write.
 *
 * THE CEILING IS THE CAP. Nothing may post more rows than the log is allowed to
 * hold, so a batch cannot be used to make the server do unbounded work.
 */
const recordSchema = z.object({ entries: z.array(rowSchema).min(1).max(HISTORY_MAX_ENTRIES) });

export async function action({ request }: Route.ActionArgs): Promise<Response> {
  const user = await resolveUser(request);
  if (user === null) throw jsonError(401, 'auth.signInRequired');

  if (request.method === 'DELETE') {
    const cleared = await clearSearchHistory(user.id);
    return Response.json({ state: 'cleared', cleared });
  }

  if (request.method !== 'POST') throw jsonError(405, 'api.methodNotAllowed');

  const parsed = recordSchema.safeParse(await request.json());
  if (!parsed.success) throw jsonError(400, 'api.invalidBody');

  // OLDEST FIRST, so a batch that carries its own instants lands in the order it
  // happened. Two rows of one batch can share a search identity only if the
  // device let them, and the upsert behind this leaves the newest instant
  // standing either way.
  const entries = parsed.data.entries.toSorted((a, b) => (a.at ?? 0) - (b.at ?? 0));
  for (const entry of entries) {
    await recordSearch({
      userId: user.id,
      query: entry.query,
      fromLanguage: entry.from,
      toLanguage: entry.to,
      headwordId: entry.headwordId,
      translation: entry.translation,
      at: entry.at === undefined ? undefined : new Date(entry.at),
    });
  }

  return Response.json({ state: 'recorded', recorded: entries.length });
}
