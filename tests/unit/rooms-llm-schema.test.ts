/**
 * The two answer shapes of a room build. They are the only thing between a
 * model's answer and a stored room, so a missing field and an answer past a
 * ceiling must both fail the parse.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { MAX_DRAFT_TERMS, roomDraftSchema, roomReviewSchema } from '../../app/lib/rooms/llm-schema';
import { buildRoomDraft, buildRoomReview } from '../fixtures/rooms';

describe('roomDraftSchema', () => {
  it('accepts a draft whose absent values are null', () => {
    assert.equal(roomDraftSchema.safeParse(buildRoomDraft()).success, true);
  });

  it('accepts a draft with no rules', () => {
    assert.equal(roomDraftSchema.safeParse(buildRoomDraft({ rules: 0 })).success, true);
  });

  it('refuses a term that leaves a nullable field out', () => {
    const draft = buildRoomDraft({ terms: 1 });
    const [group] = draft.groups;
    assert.ok(group);
    const withoutArticle = group.terms.map(({ article: _article, ...term }) => term);
    const parsed = roomDraftSchema.safeParse({ ...draft, groups: [{ ...group, terms: withoutArticle }] });
    assert.equal(parsed.success, false);
  });

  it('refuses more terms in total than the ceiling, even when each group fits', () => {
    const parsed = roomDraftSchema.safeParse(buildRoomDraft({ terms: MAX_DRAFT_TERMS + 1 }));
    // Groups of four, so this many terms also passes the group ceiling.
    assert.equal(parsed.success, false);
  });

  it('refuses more sentences than the ceiling rather than trimming them', () => {
    assert.equal(roomDraftSchema.safeParse(buildRoomDraft({ sentences: 17 })).success, false);
  });

  it('requires every property in the JSON schema a strict provider is handed', () => {
    const objectSchema = z.object({
      required: z.array(z.string()),
      properties: z.record(z.string(), z.json()),
    });
    const json = objectSchema.parse(z.toJSONSchema(roomDraftSchema));
    assert.deepEqual(json.required.toSorted(), Object.keys(json.properties).toSorted());
  });

  it('refuses more groups, terms in one group, or rules than the ceiling', () => {
    const draft = buildRoomDraft({ terms: 1, rules: 1 });
    const [group] = draft.groups;
    const [rule] = draft.rules;
    assert.ok(group);
    assert.ok(rule);
    const [term] = group.terms;
    assert.ok(term);
    const overfull = [
      { ...draft, groups: Array.from({ length: 7 }, () => group) },
      { ...draft, groups: [{ ...group, terms: Array.from({ length: 17 }, () => term) }] },
      { ...draft, rules: Array.from({ length: 10 }, () => rule) },
    ];
    for (const candidate of overfull) assert.equal(roomDraftSchema.safeParse(candidate).success, false);
  });
});

describe('the JSON schema a provider is handed', () => {
  // Gemini answers 400 "too many states for serving" when these two schemas carry
  // `maxItems`, so a `.max()` on any array here breaks every room build.
  it('carries no list ceiling', () => {
    for (const schema of [roomDraftSchema, roomReviewSchema]) {
      assert.doesNotMatch(JSON.stringify(z.toJSONSchema(schema)), /"maxItems"/);
    }
  });
});

describe('roomReviewSchema', () => {
  it('accepts a verdict for each id', () => {
    const review = buildRoomReview({ ids: ['t1', 's1'], rejected: ['s1'] });
    assert.equal(roomReviewSchema.safeParse(review).success, true);
  });

  it('refuses more verdicts than the ceiling', () => {
    const ids = Array.from({ length: 121 }, (_, index) => `t${index + 1}`);
    assert.equal(roomReviewSchema.safeParse(buildRoomReview({ ids, rejected: [] })).success, false);
  });

  it('refuses a verdict outside ok and reject', () => {
    const parsed = roomReviewSchema.safeParse({ verdicts: [{ id: 't1', verdict: 'maybe', reason: null }] });
    assert.equal(parsed.success, false);
  });
});
