import { z } from 'zod';

import type { Route } from './+types/api.translation.$headwordId.reject';
import { isServedLanguage, type LanguageCode } from '#app/lib/dictionary/detect-language';
import { entryHeadwordQuery } from '#app/lib/dictionary/entry.server';
import { jsonError } from '#app/lib/api-auth.server';
import { createComponentLogger } from '#app/lib/logger';
import { createEntryLookups, resolveEntry } from '#app/lib/dictionary/queries.server';
import { REJECTION_REASONS } from '#app/lib/translation/rejection';
import { resolveTriggeredTranslationPanel, type TranslationPanel } from '#app/lib/translation/panel.server';
import { requireVoterAccount } from '#app/lib/votes/account-gate.server';
import { authMiddleware } from '#app/middleware/auth';
import {
  isRetranslationCooldownActive,
  readRetranslationCooldown,
  recordRejection,
  touchRetranslationCooldown,
} from '#app/models/translation-rejections.server';
import { latestRun } from '#app/models/translation-runs.server';
import { getRawDb } from '#drizzle/db';

/**
 * `POST /api/translation/:headwordId/reject?to=<code>`, where a reader says the
 * generated answer in front of them is wrong.
 *
 * IT IS THE TRANSLATION COUNTERPART OF `api.enrichment-vote.ts`, AND IT BORROWS
 * THAT ROUTE'S SHAPE DELIBERATELY. A down-vote there buys a paid re-run behind a
 * cooldown; a rejection here buys a paid re-translation behind a cooldown. Same
 * guard order, same JSON union behind a `state` discriminant, same rule that a
 * refusal must never be a redirect: the caller is a fetcher inside an
 * already-rendered pane, and a redirect is not something it can act on.
 *
 * THE RE-RUN GOES THROUGH THE SAME GATE THE SEARCH DOES, NOT A BARE JOB SEND.
 *   `resolveTriggeredTranslationPanel` runs the three guards in their one order,
 *   and `rerun` is the only difference: it steps over the `ready` answer the
 *   reader is complaining about instead of returning it unchanged. A direct
 *   enqueue here would be a second, ungoverned way to spend money, reachable by
 *   anybody with a session and a headword id.
 *
 * THE COOLDOWN WITHHOLDS THE SPEND, NEVER THE SIGNAL. This is the thing a reader
 * of this file will get wrong. A rejection inside the window is recorded in full,
 * with its reason, and only the paid re-run is skipped. Swallowing the rejection
 * as well would mean the second, third and fourth reader to complain about one
 * bad answer left no trace at all, and the corpus tally that triages bad answers
 * would systematically under-count exactly the answers most people disagree with.
 *
 * THE PRIVACY RULE GOVERNS THIS FILE.
 *   This route holds an account id and a dictionary object in the same scope, so
 *   it is one of the few places this product's claim can be lost. No lemma, no
 *   headword text and no query text is logged here, at any level. The log lines
 *   below carry ids and outcomes only. A debug line pairing a reader with a word
 *   is a search log, whatever it is called.
 *
 * NO ENGLISH PROSE REACHES THE BROWSER FROM HERE.
 *   The one refusal that carries a sentence carries a wordsmith key instead, and
 *   the client resolves it. Writing the sentence here would put one untranslated
 *   string in the middle of a translated page, and no gate catches that.
 *
 * AN ACCOUNT IS REQUIRED, THROUGH THE SAME MIDDLEWARE THE RETRY ROUTE USES.
 *   `authMiddleware` answers a path under `/api/` with a 401 in JSON rather than
 *   a redirect to a sign-in page.
 */
export const middleware = [authMiddleware];

const log = createComponentLogger('TranslationReject');

/**
 * The form body, decoded at the boundary.
 *
 * ONE FIELD, AND IT IS A CODE. `REJECTION_REASONS` is the same tuple the check
 * constraint on `translation_rejection_signals.reason` is built from, so a body
 * this schema accepts is a body Postgres accepts. There is deliberately no free
 * text field: see the header of `app/lib/translation/rejection.ts`.
 */
const rejectSubmissionSchema = z.object({
  reason: z.enum(REJECTION_REASONS),
});

/**
 * What became of the re-run a rejection may buy.
 *
 * `queued` work started, `refused` a guard turned it away, `cooldown` the pair
 * was re-run too recently, `already` this reader had rejected this run before.
 */
export type RejectRerun = 'queued' | 'cooldown' | 'already' | 'refused';

/** Every way this route can answer, as one union the pane switches on. */
export type RejectOutcome =
  | { state: 'unauthenticated'; messageKey: string }
  | { state: 'invalid' }
  | { state: 'no-run' }
  | { state: 'recorded'; rerun: RejectRerun; panel: TranslationPanel | null };

export async function action({ params, request }: Route.ActionArgs): Promise<Response> {
  // A GET must not record anything. The route has no loader, so a GET already
  // 405s; this guard covers the other verbs a form or a client could send.
  if (request.method !== 'POST') throw jsonError(405, 'method not allowed');

  // THE GATE FIRST, BEFORE THE BODY IS READ, for the reason
  // `api.enrichment-vote.ts` states: a signed-out visitor gets the same answer
  // whatever they posted, so there is nothing to learn by posting a well-formed
  // body versus a broken one.
  const accountId = await requireVoterAccount(request);
  if (accountId === null) {
    return Response.json({ state: 'unauthenticated', messageKey: 'translation.rejectSignIn' }, { status: 401 });
  }

  const form = await request.formData();
  const parsed = rejectSubmissionSchema.safeParse({ reason: form.get('reason') });
  if (!parsed.success) return Response.json({ state: 'invalid' }, { status: 400 });
  const { reason } = parsed.data;

  const db = getRawDb();
  const url = new URL(request.url);
  const requestedTo = url.searchParams.get('to');
  const to: LanguageCode = isServedLanguage(requestedTo) ? requestedTo : 'en';

  const headword = await resolveServableHeadword(db, params.headwordId);
  if (headword === null) return Response.json({ state: 'no-run' });
  const from = headword.languageCode;
  const headwordId = headword.headwordId;

  // THERE HAS TO BE A MODEL ANSWER TO REJECT, AND A RUN ROW IS WHAT SAYS THERE
  // IS ONE. An answer built entirely from IMPORTED edges has no run behind it,
  // and a rejection row pointing at no run would fill the fine-tuning corpus
  // with complaints naming no model output, which is the one thing that corpus
  // is for. An imported edge is judged with the per-edge thumbs down instead,
  // which already exists and posts somewhere else entirely. A run that is
  // `pending`, `failed` or `budget` is not an answer either: there is nothing on
  // screen to have been wrong.
  const run = await latestRun(db, { headwordId, from, to });
  if (run === null || run.status !== 'ok') return Response.json({ state: 'no-run' });

  const { firstTime } = await recordRejection(db, { runId: run.id, accountId, reason });

  // A SECOND PRESS BY THE SAME READER RECORDS NOTHING AND BUYS NOTHING.
  // `recordRejection` has already declined to append a second signal row, and
  // ordering a re-run here would let one reader spend an installation's money
  // once per click.
  if (!firstTime) {
    log.info('Translation rejection repeated', { runId: run.id, rerun: 'already' });
    return Response.json({ state: 'recorded', rerun: 'already', panel: null } satisfies RejectOutcome);
  }

  const cooldownKey = { headwordId, from, to };
  const lastQueuedAt = await readRetranslationCooldown(db, cooldownKey);
  if (isRetranslationCooldownActive(lastQueuedAt, new Date())) {
    // The rejection above is already written, and it stays written. Only the
    // paid call is withheld.
    log.info('Translation rejection recorded', { runId: run.id, rerun: 'cooldown' });
    return Response.json({ state: 'recorded', rerun: 'cooldown', panel: null } satisfies RejectOutcome);
  }

  const panel = await resolveTriggeredTranslationPanel(db, {
    headwordId,
    from,
    to,
    request,
    rerun: { reason },
    // The reader whose rejection this is, so the rows a later read returns
    // already carry their own votes. `authMiddleware` above has established that
    // there IS an account, and this is the id it resolved to.
    accountId,
  });

  // THE COOLDOWN IS STAMPED ONLY WHEN WORK ACTUALLY STARTED. `translating` is
  // the only panel that means a job is on the queue. Stamping on a budget or
  // rate-limit refusal would lock this headword out for a day in exchange for a
  // run that never happened, and every later rejection of the same bad answer
  // would be silently declined a re-run because of a refusal no reader can see.
  const rerun: RejectRerun = panel.state === 'translating' ? 'queued' : 'refused';
  if (rerun === 'queued') await touchRetranslationCooldown(db, cooldownKey);

  log.info('Translation rejection recorded', { runId: run.id, rerun, panel: panel.state });
  return Response.json({ state: 'recorded', rerun, panel } satisfies RejectOutcome);
}

/** The headword and its language, or `null` for an id this installation cannot serve. */
async function resolveServableHeadword(
  db: ReturnType<typeof getRawDb>,
  id: string,
): Promise<{ headwordId: string; languageCode: LanguageCode } | null> {
  const resolved = await resolveEntry(createEntryLookups(db), id);
  if (resolved.kind !== 'found' || resolved.entity !== 'headword') return null;

  const [headword] = await entryHeadwordQuery(db, resolved.id);
  if (!headword || !isServedLanguage(headword.languageCode)) return null;
  return { headwordId: headword.headwordId, languageCode: headword.languageCode };
}
