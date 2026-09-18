import type { Route } from './+types/explanations';
import { Form, useNavigation } from 'react-router';
import { parseWithZod } from '@conform-to/zod/v4';
import { z } from 'zod';

import { Button } from '#app/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#app/components/ui/table';
import { getUser } from '#app/middleware/helpers';
import {
  hideQuestion,
  listModerationQueue,
  resolveModerationKey,
  unhideQuestion,
} from '#app/models/explanation-moderation.server';
import { REPORT_REASON_MAX_CHARS } from '#app/models/explanation-reports.server';
import { getRawDb } from '#drizzle/db';

export const handle = {
  title: 'Public explanations',
};

// =============================================================================
// The moderation queue
// =============================================================================
// Superadmin only. The `_super` layout already runs `authMiddleware` then
// `superadminMiddleware`, so this route neither re-checks the role nor exports
// a middleware of its own.
//
// ENTRIES ARE QUESTIONS, NOT ROWS. The ledger is append only, so one question
// can carry several answered rows over its life. A hide is written against the
// question's own key and therefore survives a newer answered row opening under
// it; a per-row flag would republish the same question the moment one did.
//
// IT NAMES THE QUESTION AND NEVER A PERSON. The read behind this screen joins
// the ledger, the reports and the votes, and joins neither the authorship table
// nor the profile table. No reporter's account is selected. An operator
// triaging a complaint must not also learn who complained or who asked.
//
// ENGLISH INLINE, LIKE EVERY OTHER `/super/` SCREEN. The operator area has no
// locale catalogue, by convention.
// =============================================================================

/** How many questions the queue shows. A page a person scans, not a report nobody opens. */
const QUEUE_LIMIT = 50;

const INTENT = { HIDE: 'hide', UNHIDE: 'unhide' } as const;

/**
 * The hide and unhide forms.
 *
 * BOTH CARRY A ROW ID AND NEITHER CARRIES A KEY. The action resolves the id back
 * to its question server side, so a hand-edited body cannot name a question the
 * operator never looked at.
 */
const moderationFormSchema = z.discriminatedUnion('intent', [
  z.object({
    intent: z.literal(INTENT.HIDE),
    explanationId: z.uuid(),
    // An empty box is "the operator wrote nothing", never "the operator wrote an
    // empty sentence". A text input always submits, so without this the column
    // fills with `''` and the queue cannot tell the two apart.
    reason: z
      .string()
      .trim()
      .max(REPORT_REASON_MAX_CHARS)
      .optional()
      .transform((value) => (value === undefined || value.length === 0 ? null : value)),
  }),
  z.object({ intent: z.literal(INTENT.UNHIDE), explanationId: z.uuid() }),
]);

export async function loader() {
  return { entries: await listModerationQueue(getRawDb(), QUEUE_LIMIT) };
}

export async function action({ request, context }: Route.ActionArgs) {
  const user = getUser(context);
  const submission = parseWithZod(await request.formData(), { schema: moderationFormSchema });

  if (submission.status !== 'success') {
    return { result: submission.reply(), error: 'That submission could not be read.' };
  }

  const db = getRawDb();
  const key = await resolveModerationKey(db, submission.value.explanationId);
  if (key === null) {
    return { result: submission.reply(), error: 'That row no longer exists, so there is no question to act on.' };
  }

  if (submission.value.intent === INTENT.HIDE) {
    await hideQuestion(db, { ...key, hiddenByUserId: user.id, reason: submission.value.reason });
  } else {
    await unhideQuestion(db, key);
  }

  return { result: submission.reply(), error: null };
}

const CARD_CLASS = 'rounded-lg border bg-card p-4 shadow-sm';
const SECTION_LABEL_CLASS = 'text-[11px] font-semibold uppercase tracking-[0.11em] text-brand-ink';
const CONTROL_CLASS =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

/** One queue row, as the loader hands it over. */
type QueueEntry = Route.ComponentProps['loaderData']['entries'][number];

/**
 * The hide or unhide control for one question.
 *
 * ONE FORM PER ROW, AND THE HIDE FORM CARRIES A REASON FIELD. The reason is the
 * operator's own note about why a question came down, and it is never shown to
 * a reader.
 */
function ModerationControl({ entry, isBusy }: { entry: QueueEntry; isBusy: boolean }) {
  if (entry.hidden) {
    return (
      <Form method="post" className="flex items-center gap-2">
        <input type="hidden" name="intent" value={INTENT.UNHIDE} />
        <input type="hidden" name="explanationId" value={entry.explanationId} />
        <Button type="submit" variant="outline" size="sm" pending={isBusy}>
          Show again
        </Button>
      </Form>
    );
  }

  return (
    <Form method="post" className="flex flex-col gap-2">
      <input type="hidden" name="intent" value={INTENT.HIDE} />
      <input type="hidden" name="explanationId" value={entry.explanationId} />
      <label className="sr-only" htmlFor={`reason-${entry.explanationId}`}>
        {`Why hide "${entry.question}"?`}
      </label>
      <input
        id={`reason-${entry.explanationId}`}
        name="reason"
        type="text"
        className={CONTROL_CLASS}
        maxLength={REPORT_REASON_MAX_CHARS}
        placeholder="Reason (optional)"
      />
      <Button type="submit" variant="outline" size="sm" pending={isBusy}>
        Hide
      </Button>
    </Form>
  );
}

export default function SuperExplanations({ loaderData, actionData }: Route.ComponentProps) {
  const { entries } = loaderData;
  const navigation = useNavigation();
  const isBusy = navigation.state !== 'idle';

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Public explanations</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Questions readers have reported, and questions already taken off the public pages. Hiding writes nothing to
          the ledger row itself: the answer stays, the question stops being public.
        </p>
      </div>

      {actionData?.error !== undefined && actionData.error !== null && (
        <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{actionData.error}</p>
      )}

      <section className={CARD_CLASS}>
        <h2 className={SECTION_LABEL_CLASS}>Reported and hidden</h2>
        {/* WHAT THIS LIST DELIBERATELY CANNOT SHOW: who reported a question, and
            who asked it. The read behind it joins neither the authorship table
            nor the profile table, and never selects the reporter's account. Do
            not add a reporter column, a per-reader filter or an export. */}
        <p className="mt-2 text-sm text-muted-foreground">
          Newest complaint first. The score is the latest answered row&apos;s; the report count covers every row this
          question has ever opened. Reporting hides nothing by itself.
        </p>

        {entries.length === 0 && <p className="mt-3 text-sm text-muted-foreground">Nothing reported or hidden.</p>}

        {entries.length > 0 && (
          <div className="mt-3">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Question</TableHead>
                  <TableHead>Pair</TableHead>
                  <TableHead>Up</TableHead>
                  <TableHead>Down</TableHead>
                  <TableHead>Reports</TableHead>
                  <TableHead>Newest reason</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => (
                  <TableRow key={entry.explanationId}>
                    <TableCell>{entry.question}</TableCell>
                    <TableCell className="font-mono">
                      {entry.from} to {entry.to}
                    </TableCell>
                    <TableCell className="tabular-nums">{entry.up}</TableCell>
                    <TableCell className="tabular-nums">{entry.down}</TableCell>
                    <TableCell className="tabular-nums">{entry.reportCount}</TableCell>
                    <TableCell>{entry.lastReportReason ?? 'No reason given'}</TableCell>
                    <TableCell>{entry.hidden ? 'Hidden' : 'Public'}</TableCell>
                    <TableCell>
                      <ModerationControl entry={entry} isBusy={isBusy} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}
