/**
 * The reader's own profile: an optional public display name, and whether
 * their own future explanations start out hidden by default (M199).
 *
 * THE DATABASE IS A PARAMETER, NEVER AN IMPORT. The same rule
 * `app/models/votes.server.ts` follows, for the same reason: `drizzle/db.ts`
 * opens a connection pool at module load, and this module is reached from a
 * route action holding `getRawDb()`. Only the TYPE is imported, so importing
 * this file opens nothing.
 *
 * ROW-EXISTENCE SEMANTICS. "No row" means both fields sit at their defaults:
 * no public name, and the system-wide listing behaviour applies. A row is
 * created the first time EITHER field is set away from its default.
 * `getUserProfile` is THE ONE FUNCTION EVERY FUTURE READER OF THIS
 * PREFERENCE CALLS, M200's authorship write reads it through here, not
 * through a second, narrower query. See the header of
 * `drizzle/schema/user-profiles.ts` for why the row is never deleted.
 */
import { eq } from 'drizzle-orm';

import type { DictionaryDb } from '#app/lib/dictionary/queries.server';
import { foldPublicName } from '#app/lib/authorship/public-name';
import { userProfiles } from '#drizzle/schema';

/** What every reader of this preference gets, whether or not a row exists yet. */
export interface UserProfileView {
  publicName: string | null;
  hideNewExplanationsByDefault: boolean;
}

/** The all-defaults shape a reader with no row gets. Both fields at their column default. */
const DEFAULT_PROFILE: UserProfileView = { publicName: null, hideNewExplanationsByDefault: false };

/**
 * This reader's profile.
 *
 * @param db The database handle.
 * @param userId The reader.
 * @returns the stored row, or {@link DEFAULT_PROFILE} when no row exists yet.
 */
export async function getUserProfile(db: DictionaryDb, userId: number): Promise<UserProfileView> {
  const [row] = await db
    .select({
      publicName: userProfiles.publicName,
      hideNewExplanationsByDefault: userProfiles.hideNewExplanationsByDefault,
    })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);

  return row ?? DEFAULT_PROFILE;
}

export interface SetPublicNameParams {
  userId: number;
  /** Already validated by `parsePublicName` (`#app/lib/authorship/public-name`). */
  publicName: string;
}

/**
 * Sets this reader's public name, creating the row if it does not exist yet.
 *
 * ONLY THE TWO NAME COLUMNS ARE TOUCHED. `hideNewExplanationsByDefault` is
 * left at its column default on a freshly-created row, and untouched on an
 * existing one, the independence this table exists to keep between its two
 * fields.
 *
 * THE FOLDED FORM IS COMPUTED HERE, AND ONLY HERE. This is the one call site
 * allowed to write `publicNameFolded`, the same rule `normalizeEmail` states
 * for `users.email`.
 *
 * A UNIQUE-VIOLATION ON THE FOLDED NAME IS THE CALLER'S TO CATCH. This
 * function does not swallow it; `app/routes/settings.tsx` turns it into a
 * field error naming the field, not a 500.
 *
 * @param db The database handle.
 * @param params The reader, and the name they chose.
 */
export async function setPublicName(db: DictionaryDb, params: SetPublicNameParams): Promise<void> {
  const publicNameFolded = foldPublicName(params.publicName);
  await db
    .insert(userProfiles)
    .values({ userId: params.userId, publicName: params.publicName, publicNameFolded })
    .onConflictDoUpdate({
      target: userProfiles.userId,
      set: { publicName: params.publicName, publicNameFolded, updatedAt: new Date() },
    });
}

/**
 * Clears this reader's public name.
 *
 * AN `UPDATE`, NEVER A `DELETE`. Deleting the row would silently reset
 * `hideNewExplanationsByDefault` back to its public default the moment a
 * reader cleared an unrelated field, because both columns live on the one
 * row. A no-op when no row exists yet: there is nothing to clear from a row
 * that was never created.
 *
 * @param db The database handle.
 * @param userId The reader.
 */
export async function clearPublicName(db: DictionaryDb, userId: number): Promise<void> {
  await db
    .update(userProfiles)
    .set({ publicName: null, publicNameFolded: null, updatedAt: new Date() })
    .where(eq(userProfiles.userId, userId));
}

export interface SetHideNewExplanationsByDefaultParams {
  userId: number;
  hide: boolean;
}

/**
 * Sets whether this reader's future explanations start out hidden by
 * default, creating the row if it does not exist yet.
 *
 * ONLY THE BOOLEAN IS TOUCHED. The two name columns are left at their column
 * default (`NULL`) on a freshly-created row, and untouched on an existing
 * one, setting this never changes a public name already on file.
 *
 * @param db The database handle.
 * @param params The reader, and their new choice.
 */
export async function setHideNewExplanationsByDefault(
  db: DictionaryDb,
  params: SetHideNewExplanationsByDefaultParams,
): Promise<void> {
  await db
    .insert(userProfiles)
    .values({ userId: params.userId, hideNewExplanationsByDefault: params.hide })
    .onConflictDoUpdate({
      target: userProfiles.userId,
      set: { hideNewExplanationsByDefault: params.hide, updatedAt: new Date() },
    });
}
