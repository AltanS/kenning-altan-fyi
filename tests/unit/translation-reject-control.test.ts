/**
 * The answer-level rejection control, driven without a browser.
 *
 * WHY THIS FILE EXISTS. The control makes three promises a reader can be held
 * to, and none of them is a piece of markup:
 *
 *   1. Every reason code has a button with words on it. A code with no locale
 *      key renders an empty button, which is a control nobody can use and which
 *      nothing else in this repo would catch.
 *   2. Every sentence the control can print exists in the catalog. A missing key
 *      renders its own dotted path on screen, and a typecheck is blind to it.
 *   3. Each of the route's outcomes leads to exactly one of: a line, a panel for
 *      the pane to adopt, and whether the control is spent. That mapping is what
 *      decides whether a reader can press the thing twice.
 *
 * There is no DOM library in this repo, so the mapping is a pure function over
 * the route's own union and this file calls it directly, exactly as
 * `translation-pane-state.test.ts` calls `translationBudgetKey`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { REJECTION_REASON_KEYS, rejectResolution } from '#app/components/translation-pane';
import { REJECTION_REASONS } from '#app/lib/translation/rejection';
import type { TranslationPanel } from '#app/lib/translation/panel.server';
import type { RejectOutcome, RejectRerun } from '#app/routes/api.translation.$headwordId.reject';
import enCommon from '#app/locales/en/common.json';

/** The panel a bought re-run hands back, which is what moves the pane. */
const TRANSLATING: TranslationPanel = { state: 'translating' };

/** The panel a refused re-run hands back, which the pane's budget branch speaks for. */
const REFUSAL: TranslationPanel = { state: 'budget', reason: 'daily-cap' };

/** The key the ROUTE sends a signed-out reader, as a literal, because it is a contract between the two files. */
const SIGN_IN_KEY = 'translation.rejectSignIn';

/** A catalog branch, decoded rather than inspected, the way `i18n-locales.test.ts` reads one. */
const BranchSchema = z.record(z.string(), z.unknown());

/** A catalog leaf. An empty string is a missing key: it renders as nothing. */
const LeafSchema = z.string().trim().min(1);

/**
 * Whether a dotted i18next key resolves to a non-empty string in the reference
 * catalog.
 *
 * It walks the decoded JSON tree one segment at a time. A segment that lands on
 * a leaf, or on nothing at all, is reported as missing, which is the same answer
 * i18next gives the screen when it prints the dotted path instead of a sentence.
 */
function catalogHas(key: string): boolean {
  let cursor: unknown = enCommon;
  for (const part of key.split('.')) {
    const branch = BranchSchema.safeParse(cursor);
    if (!branch.success) return false;
    cursor = branch.data[part];
  }
  return LeafSchema.safeParse(cursor).success;
}

/** One rejection outcome per member of the route's union, so nothing is asserted twice over. */
const RERUNS: RejectRerun[] = ['queued', 'cooldown', 'already', 'refused'];

function recorded(rerun: RejectRerun, panel: TranslationPanel | null): RejectOutcome {
  return { state: 'recorded', rerun, panel };
}

describe('the reason codes and their buttons', () => {
  it('has a distinct, non-empty locale key for every reason the route accepts', () => {
    const keys = REJECTION_REASONS.map((reason) => REJECTION_REASON_KEYS[reason]);
    assert.equal(keys.length, REJECTION_REASONS.length);
    assert.equal(new Set(keys).size, keys.length, `two reasons share one button: ${keys.join(', ')}`);
    for (const key of keys) assert.notEqual(key.trim(), '');
  });

  it('covers the tuple the database constraint is built from, in full', () => {
    // The lookup is `satisfies Record<RejectionReason, string>`, so a FIFTH code
    // already fails the typecheck. This case is the other direction: a key left
    // in the table for a code that was removed.
    assert.deepEqual(Object.keys(REJECTION_REASON_KEYS).toSorted(), [...REJECTION_REASONS].toSorted());
  });
});

describe('every sentence the control can print', () => {
  it('resolves in the reference catalog', () => {
    const spoken = [
      'translation.reportAction',
      'translation.reportPrompt',
      'translation.reportCancel',
      SIGN_IN_KEY,
      ...Object.values(REJECTION_REASON_KEYS),
      ...RERUNS.map((rerun) => rejectResolution(recorded(rerun, null)).noticeKey),
      rejectResolution({ state: 'no-run' }).noticeKey,
      rejectResolution({ state: 'invalid' }).noticeKey,
      rejectResolution(null).noticeKey,
      // A null notice is the `refused` case, which the pane speaks for. It is
      // dropped rather than filtered so the list stays a list of real keys.
    ].flatMap((key) => (key === null ? [] : [key]));

    const missing = spoken.filter((key) => !catalogHas(key));
    assert.deepEqual(missing, [], `keys with no English copy: ${missing.join(', ')}`);
  });

  it('reports a key that is not there (guards the lookup itself)', () => {
    // Without this the case above passes on a lookup that answers `true` for
    // everything, which is the usual way a key-existence check rots.
    assert.equal(catalogHas('translation.reportAction'), true);
    assert.equal(catalogHas('translation.thereIsNoSuchKey'), false);
    assert.equal(catalogHas('noSuchNamespace.at.all'), false);
  });
});

describe('what one rejection leaves on screen', () => {
  it('hands the re-run panel to the pane and says work started', () => {
    const resolved = rejectResolution(recorded('queued', TRANSLATING));
    assert.equal(resolved.panel, TRANSLATING);
    assert.equal(resolved.noticeKey, 'translation.rejectRerunning');
    assert.equal(resolved.isDone, true);
  });

  it('hands a refusal panel over and says nothing itself, so the budget branch speaks once', () => {
    const resolved = rejectResolution(recorded('refused', REFUSAL));
    assert.equal(resolved.panel, REFUSAL);
    assert.equal(resolved.noticeKey, null);
    assert.equal(resolved.isDone, true);
  });

  it('keeps the answer on screen when the pair is inside its cooldown', () => {
    const resolved = rejectResolution(recorded('cooldown', null));
    assert.equal(resolved.panel, null, 'a withheld re-run must not move the pane');
    assert.equal(resolved.noticeKey, 'translation.rejectCooldown');
    assert.equal(resolved.isDone, true);
  });

  it('tells a reader who already reported this answer, and buys nothing', () => {
    const resolved = rejectResolution(recorded('already', null));
    assert.equal(resolved.panel, null);
    assert.equal(resolved.noticeKey, 'translation.rejectAlready');
    assert.equal(resolved.isDone, true);
  });

  it('points an imported answer at the per-word thumbs instead', () => {
    const resolved = rejectResolution({ state: 'no-run' });
    assert.equal(resolved.noticeKey, 'translation.rejectNoRun');
    assert.equal(resolved.isDone, true);
  });
});

describe('the outcomes that record nothing, and therefore leave the control open', () => {
  it('prints the sign-in key the route sent, rather than a sentence of its own', () => {
    const resolved = rejectResolution({ state: 'unauthenticated', messageKey: SIGN_IN_KEY });
    assert.equal(resolved.noticeKey, SIGN_IN_KEY);
    assert.equal(resolved.panel, null);
    // Nothing was recorded, so a reader who signs in elsewhere and comes back
    // must still be able to report this answer.
    assert.equal(resolved.isDone, false);
  });

  it('reports a body the route refused, and lets the reader try again', () => {
    const resolved = rejectResolution({ state: 'invalid' });
    assert.equal(resolved.noticeKey, 'translation.rejectFailed');
    assert.equal(resolved.isDone, false);
  });

  it('reads a POST that settled with nothing as a failure, never as a success', () => {
    // A proxy error page or a dropped connection. Treating it as recorded would
    // collapse the control over a rejection nobody holds.
    const resolved = rejectResolution(null);
    assert.equal(resolved.noticeKey, 'translation.rejectFailed');
    assert.equal(resolved.panel, null);
    assert.equal(resolved.isDone, false);
  });

  it('is spent by exactly the outcomes that reached the database', () => {
    const done = [
      ...RERUNS.map((rerun) => [rerun, rejectResolution(recorded(rerun, null)).isDone] as const),
      ['no-run', rejectResolution({ state: 'no-run' }).isDone] as const,
      ['invalid', rejectResolution({ state: 'invalid' }).isDone] as const,
      ['unauthenticated', rejectResolution({ state: 'unauthenticated', messageKey: SIGN_IN_KEY }).isDone] as const,
      ['unreadable', rejectResolution(null).isDone] as const,
    ];
    assert.deepEqual(done, [
      ['queued', true],
      ['cooldown', true],
      ['already', true],
      ['refused', true],
      ['no-run', true],
      ['invalid', false],
      ['unauthenticated', false],
      ['unreadable', false],
    ]);
  });
});
