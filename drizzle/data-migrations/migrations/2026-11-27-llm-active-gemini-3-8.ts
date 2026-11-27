import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DataMigrationDb } from '../runner';
import { ACTIVE_MODEL_SETTING_KEY } from '#app/lib/llm/catalog';
import { appSettings, appSettingsAudit } from '#drizzle/schema';

// Both ids are literals on purpose. A data migration records one change at one
// date, so it must not follow `DEFAULT_ACTIVE_MODEL` when that moves again.
const SEEDED_MODEL = 'google/gemini-3.7-flash';
const NEXT_MODEL = 'google/gemini-3.8-flash';

/**
 * Move the seeded `llm.active` setting from Gemini 3.7 Flash to 3.8 Flash.
 *
 * WHY THIS EXISTS
 *   Migration `0006` stores the active model, and the stored row wins over
 *   `DEFAULT_ACTIVE_MODEL`. Without this rewrite every installation keeps
 *   calling 3.7 after the code moved to 3.8.
 *
 * WHICH ROW
 *   Only the seed: the stored model is still 3.7 AND `updated_by` is NULL. A
 *   switch on `/super/llm` always writes the acting user into `updated_by`, so
 *   an operator's own choice is left alone, including a deliberate 3.7.
 *
 * Only the `model` key changes. `updated_by` stays NULL, because there is still
 * no actor. The change gets an audit row, as every other change to this setting
 * does, so the history on `/super/llm` explains why the model moved.
 *
 * IDEMPOTENT
 *   A second run finds no row that still says 3.7, and writes nothing.
 */
export default async function (db: DataMigrationDb): Promise<void> {
  const isUntouchedSeed = and(
    eq(appSettings.key, ACTIVE_MODEL_SETTING_KEY),
    isNull(appSettings.updatedBy),
    sql`${appSettings.value} ->> 'model' = ${SEEDED_MODEL}`,
  );

  const [seed] = await db.select().from(appSettings).where(isUntouchedSeed).for('update').limit(1);
  if (!seed) return;

  const [written] = await db
    .update(appSettings)
    .set({
      value: sql`jsonb_set(${appSettings.value}, '{model}', to_jsonb(${NEXT_MODEL}::text))`,
      updatedAt: new Date(),
    })
    .where(isUntouchedSeed)
    .returning();
  if (!written) throw new Error('Failed to rewrite the seeded active model');

  await db.insert(appSettingsAudit).values({
    key: ACTIVE_MODEL_SETTING_KEY,
    before: seed.value,
    after: written.value,
    actorUserId: null,
    actorEmail: null,
  });
  console.log(`[2026-11-27-llm-active-gemini-3-8] moved the seeded model to ${NEXT_MODEL}`);
}
