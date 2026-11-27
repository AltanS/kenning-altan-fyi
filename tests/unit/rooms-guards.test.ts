/**
 * The guards a room build passes: what a request must look like, the order of the
 * three spend guards, the retry rule and the job payload.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { refuseRoomBuild } from '../../app/lib/rooms/guards';
import { roomJobPayloadSchema, roomSingletonKey } from '../../app/lib/rooms/job-payload';
import { MAX_ROOM_BUILDS_PER_DAY, ROOM_STALE_MS, ROOM_TOPIC_MAX_CHARS } from '../../app/lib/rooms/limits';
import {
  checkRoomRequest,
  defaultRoomLanguages,
  findHeldRoom,
  holdsRoomTopic,
  normalizeRoomTopic,
} from '../../app/lib/rooms/request';
import { isRoomRetryable } from '../../app/lib/rooms/view';
import { DETECT, PAIR_LANGUAGES } from '../../app/lib/dictionary/language-pair';

const PAIR = { termLanguage: 'de', glossLanguage: 'en' };

describe('checkRoomRequest', () => {
  it('trims the topic and accepts the bounds themselves', () => {
    for (const topic of ['  ab  ', 'a'.repeat(ROOM_TOPIC_MAX_CHARS)]) {
      const checked = checkRoomRequest({ ...PAIR, topic });
      assert.ok(checked.ok);
      assert.equal(checked.request.topic, topic.trim());
    }
  });

  it('refuses a topic outside the bounds instead of cutting it', () => {
    assert.deepEqual(checkRoomRequest({ ...PAIR, topic: ' a ' }), { ok: false, reason: 'topic-too-short' });
    assert.deepEqual(checkRoomRequest({ ...PAIR, topic: 'a'.repeat(ROOM_TOPIC_MAX_CHARS + 1) }), {
      ok: false,
      reason: 'topic-too-long',
    });
  });

  it('refuses one language twice and a language the dictionary does not serve', () => {
    assert.deepEqual(checkRoomRequest({ topic: 'copper', termLanguage: 'de', glossLanguage: 'de' }), {
      ok: false,
      reason: 'same-language',
    });
    assert.deepEqual(checkRoomRequest({ topic: 'copper', termLanguage: 'fr', glossLanguage: 'de' }), {
      ok: false,
      reason: 'unsupported-language',
    });
  });
});

describe('normalizeRoomTopic', () => {
  it('folds case and whitespace, so one topic is one room', () => {
    assert.equal(normalizeRoomTopic('  Copper \n  RECYCLING '), 'copper recycling');
  });
});

describe('defaultRoomLanguages', () => {
  const noRoom = { newestRoom: null, cookiePair: null };

  it('starts on the newest room the reader holds, whatever the cookie says', () => {
    const defaults = defaultRoomLanguages({
      newestRoom: { termLanguage: 'tr', glossLanguage: 'es' },
      cookiePair: { source: 'en', target: 'de' },
      uiLanguage: 'de',
    });

    assert.deepEqual(defaults, { termLanguage: 'tr', glossLanguage: 'es' });
  });

  it('ignores a newest room whose language is no longer served', () => {
    const defaults = defaultRoomLanguages({
      newestRoom: { termLanguage: 'fr', glossLanguage: 'en' },
      cookiePair: null,
      uiLanguage: 'en',
    });

    assert.deepEqual(defaults, { termLanguage: 'de', glossLanguage: 'en' });
  });

  it('explains in the interface language and takes the first other language of the pair', () => {
    const cases = [
      { cookiePair: { source: 'en', target: 'tr' }, uiLanguage: 'en', termLanguage: 'tr' },
      { cookiePair: { source: 'es', target: 'tr' }, uiLanguage: 'de', termLanguage: 'es' },
      { cookiePair: { source: 'de', target: 'en' }, uiLanguage: 'de', termLanguage: 'en' },
      { cookiePair: { source: DETECT, target: 'es' }, uiLanguage: 'en', termLanguage: 'es' },
    ] as const;

    for (const { cookiePair, uiLanguage, termLanguage } of cases) {
      assert.deepEqual(defaultRoomLanguages({ newestRoom: null, cookiePair, uiLanguage }), {
        termLanguage,
        glossLanguage: uiLanguage,
      });
    }
  });

  it('falls back to German for an English interface and English for a German one', () => {
    assert.deepEqual(defaultRoomLanguages({ ...noRoom, uiLanguage: 'en' }), {
      termLanguage: 'de',
      glossLanguage: 'en',
    });
    assert.deepEqual(defaultRoomLanguages({ ...noRoom, uiLanguage: 'de' }), {
      termLanguage: 'en',
      glossLanguage: 'de',
    });
  });

  it('never starts on one language twice', () => {
    for (const target of PAIR_LANGUAGES) {
      for (const uiLanguage of ['en', 'de']) {
        const defaults = defaultRoomLanguages({
          newestRoom: null,
          cookiePair: { source: DETECT, target },
          uiLanguage,
        });
        assert.notEqual(defaults.termLanguage, defaults.glossLanguage);
      }
    }
  });
});

describe('a room the reader already holds', () => {
  const rooms = [{ id: 'one', topic: 'Copper  Recycling', termLanguage: 'de', glossLanguage: 'en' }];

  it('is found by the folded topic and both languages', () => {
    const held = findHeldRoom(rooms, { topic: '  copper recycling ', termLanguage: 'de', glossLanguage: 'en' });

    assert.equal(held?.id, 'one');
  });

  it('is not found for another topic, another pair or the pair swapped', () => {
    const others = [
      { topic: 'copper', termLanguage: 'de', glossLanguage: 'en' },
      { topic: '', termLanguage: 'de', glossLanguage: 'en' },
      { topic: 'copper recycling', termLanguage: 'tr', glossLanguage: 'en' },
      { topic: 'copper recycling', termLanguage: 'de', glossLanguage: 'es' },
      { topic: 'copper recycling', termLanguage: 'en', glossLanguage: 'de' },
    ];

    for (const request of others) assert.equal(findHeldRoom(rooms, request), null);
  });

  it('holds its topic in whatever pair it was built', () => {
    assert.equal(holdsRoomTopic(rooms, 'copper recycling'), true);
    assert.equal(holdsRoomTopic(rooms, 'coffee roasting'), false);
  });
});

/** The three guards with a call log, each answering what the case says. */
function probes({ allowed = true, builds = 0, isOverBudget = false } = {}) {
  const calls: string[] = [];
  return {
    calls,
    probes: {
      checkRateLimit: async () => {
        calls.push('rate');
        return { allowed };
      },
      countBuildsToday: async () => {
        calls.push('cap');
        return builds;
      },
      isBudgetExhausted: async () => {
        calls.push('budget');
        return isOverBudget;
      },
    },
  };
}

describe('refuseRoomBuild', () => {
  it('asks the rate limit, then the daily cap, then the budget', async () => {
    const run = probes();
    assert.equal(await refuseRoomBuild(run.probes), null);
    assert.deepEqual(run.calls, ['rate', 'cap', 'budget']);
  });

  it('stops at the rate limit', async () => {
    const run = probes({ allowed: false, builds: 99, isOverBudget: true });
    assert.equal(await refuseRoomBuild(run.probes), 'rate-limited');
    assert.deepEqual(run.calls, ['rate']);
  });

  it('refuses the build after the last one of the day, and does not ask the budget', async () => {
    const run = probes({ builds: MAX_ROOM_BUILDS_PER_DAY, isOverBudget: true });
    assert.equal(await refuseRoomBuild(run.probes), 'daily-cap');
    assert.deepEqual(run.calls, ['rate', 'cap']);
  });

  it('allows the last build of the day', async () => {
    assert.equal(await refuseRoomBuild(probes({ builds: MAX_ROOM_BUILDS_PER_DAY - 1 }).probes), null);
  });

  it('refuses when the budget is used up', async () => {
    assert.equal(await refuseRoomBuild(probes({ isOverBudget: true }).probes), 'budget');
  });
});

describe('isRoomRetryable', () => {
  const now = new Date('2026-11-27T12:00:00Z');
  const aged = (ms: number) => new Date(now.getTime() - ms);

  it('offers a retry after failed and budget', () => {
    assert.equal(isRoomRetryable({ status: 'failed', updatedAt: now }, now), true);
    assert.equal(isRoomRetryable({ status: 'budget', updatedAt: now }, now), true);
  });

  it('never offers one for a finished room', () => {
    assert.equal(isRoomRetryable({ status: 'ok', updatedAt: aged(ROOM_STALE_MS * 10) }, now), false);
  });

  it('offers one for a pending room only once it is older than the stale threshold', () => {
    assert.equal(isRoomRetryable({ status: 'pending', updatedAt: aged(ROOM_STALE_MS) }, now), false);
    assert.equal(isRoomRetryable({ status: 'pending', updatedAt: aged(ROOM_STALE_MS + 1) }, now), true);
  });
});

describe('the room job payload', () => {
  const payload = { roomId: '8f14e45f-ceea-467f-a5e1-3b1f0a2c9d11', attempt: 2 };

  it('is one job per room and attempt', () => {
    assert.equal(roomSingletonKey(payload), `room:${payload.roomId}:2`);
  });

  it('refuses a field that would pair a reader or a topic with the queue row', () => {
    assert.equal(roomJobPayloadSchema.safeParse({ ...payload, userId: 1 }).success, false);
    assert.equal(roomJobPayloadSchema.safeParse({ ...payload, topic: 'copper' }).success, false);
  });
});
