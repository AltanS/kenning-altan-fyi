/**
 * `user_profiles`: an optional public display name, and whether a reader's
 * own future explanations start out hidden by default (M199).
 *
 * NO FOREIGN KEY ONTO `explanations`, AND NONE IS EVER ADDED HERE. This table
 * is reachable only from the signed-in reader's own settings screen, keyed by
 * their own id. `explanations` is the shared, readerless ledger, see the
 * header comment of the schema file that defines it, and a column here that
 * named one would be the exact thing that ledger exists to avoid: a row that
 * says WHO looked something up.
 *
 * TWO INDEPENDENT FIELDS, ONE ROW, AND THAT SHAPES EVERY WRITE ON IT. "No row"
 * means both fields are at their default: no public name, and the system-wide
 * listing behaviour applies. A row is created the first time EITHER field is
 * set away from its default. Clearing the public name is an `UPDATE` of the
 * two name columns to `NULL`, never a `DELETE`, a delete would silently reset
 * `hide_new_explanations_by_default` back to its public default the moment a
 * reader touched an unrelated field. See `app/models/user-profiles.server.ts`.
 *
 * `public_name_folded` MIRRORS `users.email`'S OWN RULE: exactly one function,
 * `foldPublicName` (`app/lib/authorship/public-name.ts`), is allowed to write
 * this column's form, and the unique index below is over that form. A plain
 * `uniqueIndex` with no `.where()` clause is correct with no partial predicate
 * needed: Postgres never treats two `NULL`s as equal under a standard unique
 * index, so any number of readers may carry no public name at once.
 *
 * EVERY READ OR WRITE GOES THROUGH `getRawDb()`, like `users` itself.
 */
import { relations, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { boolean, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

import { users } from './users';

export const userProfiles = pgTable(
  'user_profiles',
  {
    userId: integer('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** As the reader typed it, trimmed. `null` until they set one. */
    publicName: text('public_name'),
    /**
     * `foldPublicName(publicName)`. The ONLY column the unique index below is
     * over, and the ONLY column `foldPublicName` is allowed to write.
     */
    publicNameFolded: text('public_name_folded'),
    /**
     * Whether every new explanation this reader causes to be generated, from
     * now on, starts out hidden from the public pages instead of the
     * system's usual default of public.
     *
     * STORED HERE, ENFORCED NOWHERE YET. This column exists so M200 has
     * somewhere to read from; nothing in this milestone reads it back on the
     * write path that generates an explanation. See `app/routes/settings.tsx`
     * for the copy that says so.
     */
    hideNewExplanationsByDefault: boolean('hide_new_explanations_by_default').default(false).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [uniqueIndex('user_profiles_public_name_folded_idx').on(table.publicNameFolded)],
);

export const userProfilesRelations = relations(userProfiles, ({ one }) => ({
  user: one(users, { fields: [userProfiles.userId], references: [users.id] }),
}));

export type InsertUserProfile = InferInsertModel<typeof userProfiles>;
export type SelectUserProfile = InferSelectModel<typeof userProfiles>;
