/**
 * The fine-tuning corpus, built against a real database.
 *
 * WHAT THIS FILE HOLDS IN PLACE
 *   `buildTranslationFeedbackExport` is the artefact a model is later trained
 *   on, so every one of its records has to be right in a way nothing else
 *   notices. Five things can make it wrong.
 *
 *   1. THE REJECTION COUNT IS A COUNT OF SIGNAL ROWS. The table that knows WHO
 *      rejected is out of reach on purpose, so the number has to come from the
 *      table that knows WHAT was wrong. A count read off the wrong table would
 *      produce the same figure today and a per-reader join tomorrow.
 *   2. THE REASON BREAKDOWN CARRIES EVERY CODE, ZEROS INCLUDED, so one JSONL
 *      line has the same keys as the next and "nobody said this" is never
 *      confused with "this file predates the code".
 *   3. THE ENDORSEMENT MARGIN IS `VOTE_MARGIN_THRESHOLD`. An edge one vote
 *      short is not in the corpus, and the case is asserted rather than assumed:
 *      a second literal in the export module would be invisible until the
 *      threshold changed and only one of the two places followed.
 *   4. AN IMPORTED EDGE CARRIES `run: null`. The provenance join goes through
 *      `translation_runs.written`, which lists the ids a run INSERTED, so an
 *      edge no run claims has no model and no prompt version to name. Guessing
 *      one would attribute a curated fact to a model that never wrote it.
 *   5. NO RECORD CARRIES A READER. `tests/unit/translation-feedback-export-names-no-reader.test.ts`
 *      reads the SOURCE for that; this file asserts the KEYS of real records
 *      built from real rows, which is the half a text scan cannot do.
 *
 * NO PROVIDER AND NO QUEUE ARE INVOLVED. Every row here is inserted directly and
 * every assertion is a record built from it.
 *
 * THE PRECONDITION IS A REACHABLE DATABASE
 *   `DB_HOST` and the other `DB_*` variables, nothing else. Every case gates on
 *   `DB_HOST` alone, which `tests/unit/integration-tests-self-skip.test.ts`
 *   enforces.
 *
 * ISOLATION
 *   Every row this file reads is created by this file: its own source, four
 *   headwords, four senses, three edges, one run, its signals, two users and
 *   their votes, all under ids that exist nowhere else, and all deleted in
 *   `after()` in foreign-key-safe order. The export reads the whole table, so
 *   every assertion picks this file's own ids out of the result rather than
 *   asserting on its length.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';

import { getRawDb, pool, poolInitialized } from '../../drizzle/db';
import {
  headwords,
  senses,
  sources,
  translationRejectionSignals,
  translationRuns,
  translationVotes,
  translations,
  users,
} from '../../drizzle/schema';
import {
  buildTranslationFeedbackExport,
  type EndorsedTranslationRecord,
  type RejectedTranslationRecord,
} from '../../app/lib/reports/translation-feedback-export.server';
import { VOTE_MARGIN_THRESHOLD } from '../../app/lib/translation/rank';

const DB_HOST = process.env.DB_HOST;

const db = getRawDb();

/** Every row this file creates, under ids that exist nowhere else. */
const SOURCE_ID = randomUUID();
const FROM_HEADWORD_ID = randomUUID();
const FROM_SENSE_ID = randomUUID();
const GENERATED_HEADWORD_ID = randomUUID();
const GENERATED_SENSE_ID = randomUUID();
const IMPORTED_HEADWORD_ID = randomUUID();
const IMPORTED_SENSE_ID = randomUUID();
const QUIET_HEADWORD_ID = randomUUID();
const QUIET_SENSE_ID = randomUUID();
const GENERATED_EDGE_ID = randomUUID();
const IMPORTED_EDGE_ID = randomUUID();
const QUIET_EDGE_ID = randomUUID();
const RUN_ID = randomUUID();

const EDGE_IDS = [GENERATED_EDGE_ID, IMPORTED_EDGE_ID, QUIET_EDGE_ID];
const SENSE_IDS = [FROM_SENSE_ID, GENERATED_SENSE_ID, IMPORTED_SENSE_ID, QUIET_SENSE_ID];
const HEADWORD_IDS = [FROM_HEADWORD_ID, GENERATED_HEADWORD_ID, IMPORTED_HEADWORD_ID, QUIET_HEADWORD_ID];

/** The direction the fixture is written for. Both codes are served. */
const FROM = 'de';
const TO = 'en';

/** The word the run was about, so the rejected record can be found by name. */
const SOURCE_LEMMA = `zz-rejected-${randomUUID().slice(0, 8)}`;

/** The model and prompt version the run records, which the corpus has to carry through. */
const RUN_MODEL = 'zz-test/model-1';
const RUN_PROMPT_VERSION = 7;

/** The run's stored answer. It goes into the corpus verbatim, so it is asserted verbatim. */
const RUN_OUTPUT = { senses: [{ gloss: 'the fixture answer', translations: ['one'] }] };

/** The readers whose votes push an edge over the margin. One per vote: the primary key is per reader. */
const voterAccountIds: number[] = [];

/** One throwaway user, so a vote has something to point its foreign key at. */
async function seedAccount(): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      email: `zz-feedback-voter-${randomUUID()}@example.invalid`,
      // A fixed non-secret string of the right shape. This file never
      // authenticates; it only needs a row the foreign key can resolve.
      passwordHash: '$2b$10$abcdefghijklmnopqrstuvwxyz012345678901234567890123456789',
      emailVerifiedAt: new Date(),
    })
    .returning({ id: users.id });
  if (!row) throw new Error('failed to seed the fixture user');
  return row.id;
}

/** This file's own rejected record, found by run id rather than by position. */
function rejectedRecord(records: Awaited<ReturnType<typeof buildTranslationFeedbackExport>>): RejectedTranslationRecord {
  const found = records.find((record) => record.verdict === 'rejected' && record.runId === RUN_ID);
  if (found === undefined || found.verdict !== 'rejected') throw new Error('the fixture run is not in the export');
  return found;
}

/** One endorsed record of this file's, or `undefined` when the edge did not qualify. */
function endorsedRecord(
  records: Awaited<ReturnType<typeof buildTranslationFeedbackExport>>,
  translationId: string,
): EndorsedTranslationRecord | undefined {
  return records.find(
    (record): record is EndorsedTranslationRecord =>
      record.verdict === 'endorsed' && record.translationId === translationId,
  );
}

before(async () => {
  if (!DB_HOST) return;
  await poolInitialized;

  await db.insert(sources).values({
    id: SOURCE_ID,
    slug: `translation-feedback-export-test-${SOURCE_ID}`,
    name: 'Translation feedback export test fixture',
    licence: 'CC0-1.0',
    attribution: 'test fixture, deleted by this file',
  });

  await db.insert(headwords).values([
    {
      id: FROM_HEADWORD_ID,
      languageCode: FROM,
      lemma: SOURCE_LEMMA,
      lemmaNormalized: SOURCE_LEMMA,
      pos: 'noun',
      sourceId: SOURCE_ID,
    },
    ...[GENERATED_HEADWORD_ID, IMPORTED_HEADWORD_ID, QUIET_HEADWORD_ID].map((id) => ({
      id,
      languageCode: TO,
      lemma: `zz-target-${id}`,
      lemmaNormalized: `zz-target-${id}`,
      sourceId: SOURCE_ID,
    })),
  ]);

  await db.insert(senses).values([
    { id: FROM_SENSE_ID, headwordId: FROM_HEADWORD_ID, sourceId: SOURCE_ID },
    { id: GENERATED_SENSE_ID, headwordId: GENERATED_HEADWORD_ID, sourceId: SOURCE_ID },
    { id: IMPORTED_SENSE_ID, headwordId: IMPORTED_HEADWORD_ID, sourceId: SOURCE_ID },
    { id: QUIET_SENSE_ID, headwordId: QUIET_HEADWORD_ID, sourceId: SOURCE_ID },
  ]);

  await db.insert(translations).values([
    { id: GENERATED_EDGE_ID, fromSenseId: FROM_SENSE_ID, toSenseId: GENERATED_SENSE_ID, sourceId: SOURCE_ID },
    { id: IMPORTED_EDGE_ID, fromSenseId: FROM_SENSE_ID, toSenseId: IMPORTED_SENSE_ID, sourceId: SOURCE_ID },
    { id: QUIET_EDGE_ID, fromSenseId: FROM_SENSE_ID, toSenseId: QUIET_SENSE_ID, sourceId: SOURCE_ID },
  ]);

  // The run claims ONE of the three edges. The other two are what an imported
  // edge looks like: nothing in `written` names them.
  await db.insert(translationRuns).values({
    id: RUN_ID,
    headwordId: FROM_HEADWORD_ID,
    fromLanguageCode: FROM,
    toLanguageCode: TO,
    promptVersion: RUN_PROMPT_VERSION,
    provider: 'zz-test',
    model: RUN_MODEL,
    status: 'ok',
    output: RUN_OUTPUT,
    written: { headwords: [], senses: [], senseVersions: [], translations: [GENERATED_EDGE_ID] },
  });

  // Three complaints, two of one code and one of another, so the breakdown is
  // an actual breakdown rather than a single number in a different shape.
  await db.insert(translationRejectionSignals).values([
    { runId: RUN_ID, reason: 'wrong' },
    { runId: RUN_ID, reason: 'wrong' },
    { runId: RUN_ID, reason: 'register' },
  ]);

  for (let index = 0; index < VOTE_MARGIN_THRESHOLD; index += 1) {
    voterAccountIds.push(await seedAccount());
  }

  // Two edges reach the margin and one falls one vote short of it.
  await db.insert(translationVotes).values([
    ...voterAccountIds.map((accountId) => ({ translationId: GENERATED_EDGE_ID, accountId, value: 1 })),
    ...voterAccountIds.map((accountId) => ({ translationId: IMPORTED_EDGE_ID, accountId, value: 1 })),
    ...voterAccountIds.slice(0, VOTE_MARGIN_THRESHOLD - 1).map((accountId) => ({
      translationId: QUIET_EDGE_ID,
      accountId,
      value: 1,
    })),
  ]);
});

after(async () => {
  if (!DB_HOST) {
    await pool.end();
    return;
  }

  // Foreign-key-safe order, innermost first. Every predicate names a row this
  // file created and nothing else.
  await db.delete(translationVotes).where(inArray(translationVotes.translationId, EDGE_IDS));
  await db.delete(translationRejectionSignals).where(eq(translationRejectionSignals.runId, RUN_ID));
  await db.delete(translationRuns).where(eq(translationRuns.id, RUN_ID));
  await db.delete(translations).where(inArray(translations.id, EDGE_IDS));
  await db.delete(senses).where(inArray(senses.id, SENSE_IDS));
  await db.delete(headwords).where(inArray(headwords.id, HEADWORD_IDS));
  await db.delete(sources).where(eq(sources.id, SOURCE_ID));
  // Last, and after the votes: the vote foreign key cascades, but deleting the
  // accounts first would silently take rows this file wanted to assert on.
  for (const accountId of voterAccountIds) {
    await db.delete(users).where(eq(users.id, accountId));
  }

  await pool.end();
});

describe('the rejected half of the corpus', () => {
  it(
    'carries the word, the direction, the model, the prompt version and the run output verbatim',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const record = rejectedRecord(await buildTranslationFeedbackExport({ db }));

      assert.equal(record.lemma, SOURCE_LEMMA);
      assert.equal(record.pos, 'noun');
      assert.equal(record.from, FROM);
      assert.equal(record.to, TO);
      assert.equal(record.model, RUN_MODEL);
      assert.equal(record.promptVersion, RUN_PROMPT_VERSION);
      assert.deepEqual(record.output, RUN_OUTPUT);
    },
  );

  it(
    'counts the signal rows and breaks them down by code, zeros included',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const record = rejectedRecord(await buildTranslationFeedbackExport({ db }));

      assert.equal(record.rejections, 3);
      assert.deepEqual(record.reasons, { missing: 0, wrong: 2, register: 1, other: 0 });
    },
  );

  it('names no reader on any record it emits', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const records = await buildTranslationFeedbackExport({ db });
    // ASSERTED ON THE KEYS, NOT ON ONE ROW'S VALUES. Checking that this
    // fixture's record carries no account id would pass the day somebody adds
    // the field and forgets to populate it here.
    const offenders = records.flatMap((record) => Object.keys(record).filter((key) => /account|user|session|ip/i.test(key)));

    assert.deepEqual(offenders, []);
  });
});

describe('the endorsed half of the corpus', () => {
  it(
    'names the run that wrote a generated edge',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const record = endorsedRecord(await buildTranslationFeedbackExport({ db }), GENERATED_EDGE_ID);

      assert.ok(record, 'the generated edge met the margin and is missing from the export');
      assert.equal(record.sourceLemma, SOURCE_LEMMA);
      assert.equal(record.up, VOTE_MARGIN_THRESHOLD);
      assert.equal(record.down, 0);
      assert.deepEqual(record.run, { model: RUN_MODEL, promptVersion: RUN_PROMPT_VERSION });
    },
  );

  it(
    'carries a null run for an edge no run claims',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const record = endorsedRecord(await buildTranslationFeedbackExport({ db }), IMPORTED_EDGE_ID);

      assert.ok(record, 'the imported edge met the margin and is missing from the export');
      assert.equal(record.run, null);
    },
  );

  it(
    'leaves out an edge one vote short of the margin',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const records = await buildTranslationFeedbackExport({ db });

      assert.equal(endorsedRecord(records, QUIET_EDGE_ID), undefined);
    },
  );
});

describe('the verdict filter', () => {
  it('builds only the rejected half', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const records = await buildTranslationFeedbackExport({ db, verdict: 'rejected' });

    assert.ok(records.every((record) => record.verdict === 'rejected'));
    assert.ok(records.some((record) => record.verdict === 'rejected' && record.runId === RUN_ID));
  });

  it('builds only the endorsed half', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    const records = await buildTranslationFeedbackExport({ db, verdict: 'endorsed' });

    assert.ok(records.every((record) => record.verdict === 'endorsed'));
    assert.ok(endorsedRecord(records, GENERATED_EDGE_ID));
  });
});
