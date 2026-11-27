/**
 * The data migration that moves the seeded `llm.active` model.
 *
 * Every case runs inside a transaction that is rolled back, so the shared
 * setting row of the database under test is never changed.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eq, TransactionRollbackError } from 'drizzle-orm';

import { db, pool } from '#drizzle/db';
import { appSettings, appSettingsAudit } from '#drizzle/schema';
import type { DataMigrationDb } from '#drizzle/data-migrations/runner';
import migrate from '#drizzle/data-migrations/migrations/2026-11-27-llm-active-gemini-3-8';
import { ACTIVE_MODEL_SETTING_KEY } from '#app/lib/llm/catalog';

const DB_HOST = process.env.DB_HOST;

const SEEDED = { provider: 'gemini', model: 'google/gemini-3.7-flash', options: {} };
const MOVED = { provider: 'gemini', model: 'google/gemini-3.8-flash', options: {} };

async function inRolledBackTransaction(run: (tx: DataMigrationDb) => Promise<void>): Promise<void> {
  await assert.rejects(
    db.transaction(async (tx) => {
      await run(tx);
      tx.rollback();
    }),
    TransactionRollbackError,
  );
}

type SettingFixture = Pick<typeof appSettings.$inferInsert, 'value' | 'updatedBy'>;

async function storeSetting(tx: DataMigrationDb, fixture: SettingFixture): Promise<void> {
  await tx.delete(appSettings).where(eq(appSettings.key, ACTIVE_MODEL_SETTING_KEY));
  await tx.delete(appSettingsAudit).where(eq(appSettingsAudit.key, ACTIVE_MODEL_SETTING_KEY));
  await tx.insert(appSettings).values({ key: ACTIVE_MODEL_SETTING_KEY, ...fixture });
}

async function readSetting(tx: DataMigrationDb): Promise<SettingFixture[]> {
  return tx
    .select({ value: appSettings.value, updatedBy: appSettings.updatedBy })
    .from(appSettings)
    .where(eq(appSettings.key, ACTIVE_MODEL_SETTING_KEY));
}

async function readAudit(tx: DataMigrationDb): Promise<(typeof appSettingsAudit.$inferSelect)[]> {
  return tx.select().from(appSettingsAudit).where(eq(appSettingsAudit.key, ACTIVE_MODEL_SETTING_KEY));
}

describe('data migration: the seeded active model', () => {
  after(async () => {
    await pool.end();
  });

  it('moves an untouched seed to 3.8 and records the change', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    await inRolledBackTransaction(async (tx) => {
      await storeSetting(tx, { value: SEEDED, updatedBy: null });

      await migrate(tx);

      assert.deepEqual(await readSetting(tx), [{ value: MOVED, updatedBy: null }]);
      const audit = await readAudit(tx);
      assert.equal(audit.length, 1);
      assert.deepEqual(audit[0]?.before, SEEDED);
      assert.deepEqual(audit[0]?.after, MOVED);
      assert.equal(audit[0]?.actorUserId, null);
    });
  });

  it('writes nothing on a second run', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    await inRolledBackTransaction(async (tx) => {
      await storeSetting(tx, { value: SEEDED, updatedBy: null });

      await migrate(tx);
      await migrate(tx);

      assert.deepEqual(await readSetting(tx), [{ value: MOVED, updatedBy: null }]);
      assert.equal((await readAudit(tx)).length, 1);
    });
  });

  it("leaves an operator's own choice of 3.7 alone", { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    await inRolledBackTransaction(async (tx) => {
      await storeSetting(tx, { value: SEEDED, updatedBy: '42' });

      await migrate(tx);

      assert.deepEqual(await readSetting(tx), [{ value: SEEDED, updatedBy: '42' }]);
      assert.equal((await readAudit(tx)).length, 0);
    });
  });

  it('leaves another model alone, even with no author', { skip: !DB_HOST ? 'DB_HOST not set' : false }, async () => {
    await inRolledBackTransaction(async (tx) => {
      const other = { provider: 'openai', model: 'openai/gpt-5.6-luna', options: {} };
      await storeSetting(tx, { value: other, updatedBy: null });

      await migrate(tx);

      assert.deepEqual(await readSetting(tx), [{ value: other, updatedBy: null }]);
      assert.equal((await readAudit(tx)).length, 0);
    });
  });
});
