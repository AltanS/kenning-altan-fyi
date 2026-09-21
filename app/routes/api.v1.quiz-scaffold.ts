/**
 * DELETE /api/v1/quiz-scaffold?from=<code>&to=<code> — delete one language
 * pair's quiz scaffold pool (superadmin only).
 *
 * THE OPERATOR ESCAPE HATCH FOR A SHARED, MODEL-WRITTEN POOL (M203/04,
 * ADR-0012). `quiz_scaffold_cards` and `quiz_scaffold_runs` are the only
 * write surface this feature has for a bad or wrong scaffold word: there is
 * no per-card edit and no moderation queue, deliberately minimal. Deleting
 * both tables' rows for the pair, not just the cards, matters:
 * `claimScaffoldRun` (`app/models/quiz.server.ts`) would otherwise still see
 * the pair's `ok` run row and refuse to ever queue a fresh backfill.
 *
 * SUPERADMIN, NOT AN ORDINARY KEY, modelled on `DELETE /api/v1/api-keys/:id`
 * (`api.v1.api-keys.$id.ts`): this deletes shared, generated content every
 * reader of the pair sees, the same class of action as revoking a key.
 */

import type { Route } from './+types/api.v1.quiz-scaffold';
import { jsonError, requireSuperadminApiKey } from '#app/lib/api-auth.server';
import { isServedLanguage } from '#app/lib/dictionary/detect-language';
import { deleteScaffoldPool } from '#app/models/quiz.server';
import { getRawDb } from '#drizzle/db';

export async function action({ request }: Route.ActionArgs): Promise<Response> {
  if (request.method !== 'DELETE') {
    throw jsonError(405, 'method not allowed');
  }

  await requireSuperadminApiKey(request);

  const url = new URL(request.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (!isServedLanguage(from) || !isServedLanguage(to)) {
    throw jsonError(400, 'from and to must both be served languages');
  }

  const result = await deleteScaffoldPool(getRawDb(), { from, to });

  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' },
  });
}
