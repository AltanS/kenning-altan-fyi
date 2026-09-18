/**
 * Two independent fields, one row (M199).
 *
 * WHY THIS IS AN INTEGRATION CASE AND NOT A UNIT ONE. The independence this
 * file proves is an UPSERT's `set` clause and an `UPDATE`'s column list, both
 * of which only Postgres can be asked to actually run. A fake store would
 * answer whatever this file made it answer.
 *
 * THE DEFECT THIS CATCHES. An earlier, single-field version of this table
 * deleted the row on clear. With a second, independent boolean now on the
 * same row, that delete would silently reset a reader's visibility
 * preference back to the public default the moment they cleared an unrelated
 * name. This file asserts the toggle survives a clear, and that clearing is
 * an `UPDATE`, never a `DELETE`: the row itself is read back after the clear
 * and asserted to still exist.
 *
 * ISOLATION. Every user this file creates is deleted in `after()` by id,
 * which cascades to its `user_profiles` row. Nothing else is read or removed.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';

import { closePool, db, poolInitialized } from '../../drizzle/db';
import { userProfiles, users } from '../../drizzle/schema';
import {
  clearPublicName,
  getUserProfile,
  setHideNewExplanationsByDefault,
  setPublicName,
} from '../../app/models/user-profiles.server';

const DB_HOST = process.env.DB_HOST;

const createdUserIds: number[] = [];

/** One user with no profile row, so a write has something fresh to land on. */
async function seedUser(label: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      email: `zzprofile-${label}-${Date.now()}-${createdUserIds.length}@example.invalid`,
      passwordHash: '$2b$10$abcdefghijklmnopqrstuvwxyz012345678901234567890123456789',
    })
    .returning({ id: users.id });
  assert.ok(row, 'could not seed the fixture user');
  createdUserIds.push(row.id);
  return row.id;
}

after(async () => {
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id));
  }
  await poolInitialized;
  await closePool();
});

describe('a profile row before it exists', () => {
  it(
    'answers the all-defaults shape for a fresh user, and creates no row to answer it',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const userId = await seedUser('fresh');

      assert.deepEqual(await getUserProfile(db, userId), { publicName: null, hideNewExplanationsByDefault: false });

      const [row] = await db.select().from(userProfiles).where(eq(userProfiles.userId, userId));
      assert.equal(row, undefined, 'reading a profile that was never written created a row');
    },
  );

  it(
    'is a no-op to clear a name that was never set',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const userId = await seedUser('clear-none');

      await clearPublicName(db, userId);

      const [row] = await db.select().from(userProfiles).where(eq(userProfiles.userId, userId));
      assert.equal(row, undefined, 'clearing a name nobody set created a row');
    },
  );
});

describe('the two fields are independent writes', () => {
  it(
    'setting the public name never touches the hide-default column',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const userId = await seedUser('name-only');

      await setPublicName(db, { userId, publicName: 'Reader One' });

      assert.deepEqual(await getUserProfile(db, userId), {
        publicName: 'Reader One',
        hideNewExplanationsByDefault: false,
      });
    },
  );

  it(
    'setting the hide-default never touches the name columns',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const userId = await seedUser('hide-only');

      await setHideNewExplanationsByDefault(db, { userId, hide: true });

      assert.deepEqual(await getUserProfile(db, userId), {
        publicName: null,
        hideNewExplanationsByDefault: true,
      });
    },
  );

  it(
    "sets a name and the toggle independently, and clearing the name leaves the toggle's value exactly as it was",
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const userId = await seedUser('both');

      await setPublicName(db, { userId, publicName: 'Reader Two' });
      await setHideNewExplanationsByDefault(db, { userId, hide: true });
      assert.deepEqual(
        await getUserProfile(db, userId),
        { publicName: 'Reader Two', hideNewExplanationsByDefault: true },
        'the two writes did not both land',
      );

      await clearPublicName(db, userId);

      assert.deepEqual(
        await getUserProfile(db, userId),
        { publicName: null, hideNewExplanationsByDefault: true },
        "clearing the name changed the toggle's value",
      );

      // THE ROW SURVIVES THE CLEAR. A delete-on-clear would have taken the
      // toggle back to its public default the moment the name was cleared,
      // because both columns live on the one row this reads back.
      const [row] = await db.select().from(userProfiles).where(eq(userProfiles.userId, userId));
      assert.ok(row, 'clearing the name deleted the row instead of updating it');
      assert.equal(row.publicName, null);
      assert.equal(row.publicNameFolded, null);
      assert.equal(row.hideNewExplanationsByDefault, true);
    },
  );

  it(
    'setting a new name after a clear does not disturb an already-set toggle',
    { skip: !DB_HOST ? 'DB_HOST not set' : false },
    async () => {
      const userId = await seedUser('reset-name');

      await setHideNewExplanationsByDefault(db, { userId, hide: true });
      await setPublicName(db, { userId, publicName: 'Reader Three' });
      await clearPublicName(db, userId);
      await setPublicName(db, { userId, publicName: 'Reader Three Again' });

      assert.deepEqual(await getUserProfile(db, userId), {
        publicName: 'Reader Three Again',
        hideNewExplanationsByDefault: true,
      });
    },
  );
});
