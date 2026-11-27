/**
 * `rooms` and `room_build_days`, the topic rooms one reader has asked for.
 *
 * A ROOM BELONGS TO ONE READER, AND IT IS NOT A SHARED CACHE.
 *   `explanations` is a ledger that serves every reader who asks the same
 *   question. A room is the opposite: it is on one reader's own list, it can be
 *   deleted by that reader, and nobody else may read it. Every query in
 *   `app/models/rooms.server.ts` that serves a reader filters on `user_id`, and
 *   another reader's room id answers 404.
 *
 * ONE ROW PER ROOM, REWRITTEN BY EACH ATTEMPT. `attempt` counts the builds of
 * this row. The job payload carries the attempt it was queued for, and every
 * write the job makes is conditional on it, so an older run that is still going
 * can never overwrite a newer one.
 *
 * `onDelete: 'cascade'` on both tables is the erasure mechanism: deleting an
 * account takes the rooms and the day counts with it in the same statement.
 *
 * WHY THE DAY COUNT IS A SECOND TABLE. The cap on paid builds per reader per UTC
 * day must survive the deletion of a room, or deleting would hand the quota
 * back. A count over `rooms` cannot do that, and it cannot count retries either,
 * because a retry rewrites the same row.
 *
 * NOTHING HERE IS LOGGED WITH A READER. The topic is free text a person typed,
 * beside their account id. No log line pairs the two.
 */
import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import type { JsonValue } from '#app/lib/json';

import { languages } from './dictionary';
import { users } from './users';

export const rooms = pgTable(
  'rooms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The topic as the reader typed it, trimmed and nothing else. It is what the model is shown. */
    topic: text('topic').notNull(),
    /** The folded topic, `normalizeRoomTopic(topic)`. Part of the row's identity. */
    topicNormalized: text('topic_normalized').notNull(),
    /** The language being learned: the words, the sentences and the examples. */
    termLanguageCode: text('term_language_code')
      .notNull()
      .references(() => languages.code),
    /** The language the room is explained in: translations, notes and rules. */
    glossLanguageCode: text('gloss_language_code')
      .notNull()
      .references(() => languages.code),
    /** `pending`, `ok`, `failed` or `budget`, pinned by a check constraint. */
    status: text('status').notNull().default('pending'),
    /** `writing` or `checking` while a job holds the row, null otherwise. */
    stage: text('stage'),
    /** Which build of this row is current. The first is 1, and every retry adds one. */
    attempt: integer('attempt').notNull().default(1),
    /** The UTC day the current attempt was counted on in `room_build_days`. */
    buildDay: date('build_day').notNull(),
    /** The filtered room document. Only ever set on an `ok` row. */
    content: jsonb('content').$type<JsonValue>(),
    /** How many items the two reviewers were shown. */
    checkedCount: integer('checked_count'),
    /** How many of those items were dropped. */
    removedCount: integer('removed_count'),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    promptVersion: integer('prompt_version').notNull(),
    /** The sum of every provider call of the current attempt. An unknown cost counts at its estimate. */
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }),
    /** The failure text, for an operator. Only ever set on a `failed` or `budget` row. */
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    /** Moves on every write, the job's stage changes included. The stale rule reads it. */
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    check('rooms_status_check', sql`status in ('pending', 'ok', 'failed', 'budget')`),
    check('rooms_stage_check', sql`stage is null or stage in ('writing', 'checking')`),
    check('rooms_languages_differ_check', sql`term_language_code <> gloss_language_code`),
    // Asking for the same room again opens the existing one and spends nothing.
    uniqueIndex('rooms_identity_idx').on(
      table.userId,
      table.topicNormalized,
      table.termLanguageCode,
      table.glossLanguageCode,
    ),
    // The one list read: this reader's rooms, newest first.
    index('rooms_user_created_idx').on(table.userId, table.createdAt.desc()),
  ],
);

export const roomBuildDays = pgTable(
  'room_build_days',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The UTC day, `YYYY-MM-DD`, matching `daily_budget.day`. */
    day: date('day').notNull(),
    /** Room builds counted against this reader on this day, retries included. */
    builds: integer('builds').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.userId, table.day] })],
);

export type SelectRoom = InferSelectModel<typeof rooms>;
export type InsertRoom = InferInsertModel<typeof rooms>;
