/**
 * Code decides what a reader sees: an item is kept only when BOTH reviewers
 * accepted it, and silence is a no.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { countRoomTerms } from '../../app/lib/rooms/content';
import { decideRoom, identifyDraft } from '../../app/lib/rooms/decide';
import { buildRoomDraft, buildRoomReview, roomItemIds, type RoomDraftCounts } from '../fixtures/rooms';

const COUNTS = { terms: 12, sentences: 6, rules: 2 } satisfies RoomDraftCounts;
const IDS = roomItemIds(COUNTS);

function identified(counts: RoomDraftCounts = COUNTS) {
  return identifyDraft({ draft: buildRoomDraft(counts), termLanguage: 'de' });
}

describe('identifyDraft', () => {
  it('hands out stable ids in document order', () => {
    const content = identified();
    const ids = [
      ...content.groups.flatMap((group) => group.terms.map((term) => term.id)),
      ...content.sentences.map((sentence) => sentence.id),
      ...content.rules.map((rule) => rule.id),
    ];
    assert.deepEqual(ids, IDS);
  });

  it('says the article once when the term repeats it', () => {
    const draft = buildRoomDraft({ terms: 1 });
    const term = draft.groups[0]?.terms[0];
    assert.ok(term);
    term.term = 'Die Sammlung';
    term.article = 'die';

    const content = identifyDraft({ draft, termLanguage: 'de' });

    assert.equal(content.groups[0]?.terms[0]?.term, 'Sammlung');
    assert.equal(content.groups[0]?.terms[0]?.article, 'die');
  });

  it('drops an article for a language that has no gender articles', () => {
    for (const termLanguage of ['en', 'tr'] as const) {
      const content = identifyDraft({ draft: buildRoomDraft({ terms: 1 }), termLanguage });
      assert.equal(content.groups[0]?.terms[0]?.article, null);
    }
  });

  it('reads an empty string as null', () => {
    const draft = buildRoomDraft({ terms: 1, rules: 1 });
    const term = draft.groups[0]?.terms[0];
    const rule = draft.rules[0];
    assert.ok(term && rule);
    term.article = '';
    term.note = '  ';
    rule.example = '';

    const content = identifyDraft({ draft, termLanguage: 'de' });

    assert.equal(content.groups[0]?.terms[0]?.article, null);
    assert.equal(content.groups[0]?.terms[0]?.note, null);
    assert.equal(content.rules[0]?.example, null);
  });
});

describe('decideRoom', () => {
  it('keeps everything both reviewers accept', () => {
    const review = buildRoomReview({ ids: IDS });
    const decision = decideRoom({ draft: identified(), languageReview: review, subjectReview: review });

    assert.equal(decision.kind, 'keep');
    assert.equal(decision.checkedCount, 20);
    assert.equal(decision.removedCount, 0);
  });

  it('drops an item either reviewer rejects', () => {
    const decision = decideRoom({
      draft: identified(),
      languageReview: buildRoomReview({ ids: IDS, rejected: ['t1'] }),
      subjectReview: buildRoomReview({ ids: IDS, rejected: ['r2'] }),
    });

    assert.equal(decision.kind, 'keep');
    assert.equal(decision.removedCount, 2);
    assert.ok(decision.kind === 'keep');
    assert.equal(countRoomTerms(decision.content), 11);
    assert.deepEqual(
      decision.content.rules.map((rule) => rule.id),
      ['r1'],
    );
  });

  it('drops an item a reviewer did not mention', () => {
    const decision = decideRoom({
      draft: identified(),
      languageReview: buildRoomReview({ ids: IDS }),
      subjectReview: buildRoomReview({ ids: IDS.filter((id) => id !== 's1') }),
    });

    assert.ok(decision.kind === 'keep');
    assert.equal(decision.content.sentences.length, 5);
  });

  it('drops an item one reviewer answered both ways', () => {
    const contradictory = buildRoomReview({ ids: IDS });
    contradictory.verdicts.push({ id: 't2', verdict: 'reject', reason: 'on reflection' });

    const decision = decideRoom({
      draft: identified(),
      languageReview: contradictory,
      subjectReview: buildRoomReview({ ids: IDS }),
    });

    assert.equal(decision.removedCount, 1);
  });

  it('reads an id whatever its case and padding', () => {
    const loud = buildRoomReview({ ids: IDS.map((id) => ` ${id.toUpperCase()} `) });
    const decision = decideRoom({ draft: identified(), languageReview: loud, subjectReview: loud });
    assert.equal(decision.removedCount, 0);
  });

  it('removes a group that lost every term', () => {
    const counts = { terms: 16, sentences: 6, rules: 0 } satisfies RoomDraftCounts;
    const ids = roomItemIds(counts);
    const decision = decideRoom({
      draft: identified(counts),
      languageReview: buildRoomReview({ ids, rejected: ['t1', 't2', 't3', 't4'] }),
      subjectReview: buildRoomReview({ ids }),
    });

    assert.ok(decision.kind === 'keep');
    assert.deepEqual(
      decision.content.groups.map((group) => group.name),
      ['Group 2', 'Group 3', 'Group 4'],
    );
  });

  it('keeps a room with no surviving rule', () => {
    const decision = decideRoom({
      draft: identified(),
      languageReview: buildRoomReview({ ids: IDS, rejected: ['r1', 'r2'] }),
      subjectReview: buildRoomReview({ ids: IDS }),
    });

    assert.ok(decision.kind === 'keep');
    assert.equal(decision.content.rules.length, 0);
  });

  it('fails with nine surviving terms', () => {
    const decision = decideRoom({
      draft: identified(),
      languageReview: buildRoomReview({ ids: IDS, rejected: ['t1', 't2', 't3'] }),
      subjectReview: buildRoomReview({ ids: IDS }),
    });

    assert.equal(decision.kind, 'too-few');
    assert.ok(decision.kind === 'too-few');
    assert.equal(decision.keptTerms, 9);
    assert.equal(decision.removedCount, 3);
  });

  it('fails with four surviving sentences', () => {
    const decision = decideRoom({
      draft: identified(),
      languageReview: buildRoomReview({ ids: IDS, rejected: ['s1', 's2'] }),
      subjectReview: buildRoomReview({ ids: IDS }),
    });

    assert.ok(decision.kind === 'too-few');
    assert.equal(decision.keptSentences, 4);
  });
});
