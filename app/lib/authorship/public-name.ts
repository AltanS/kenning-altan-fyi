/**
 * The one normal form of a public display name, and the one check on its
 * shape (M199).
 *
 * MIRRORS `app/lib/auth/email.ts` EXACTLY, INCLUDING THE RULE IT STATES FOR
 * ITSELF. `foldPublicName` is the ONLY function allowed to write
 * `user_profiles.public_name_folded`, and the unique index on that column is
 * over its output. A hand-rolled `.toLowerCase()` at one call site is how two
 * readers end up sharing one folded identity by accident, so the form is
 * defined once here and nowhere else.
 *
 * THE RESERVED LIST IS FOLDED THE SAME WAY THE INPUT IS, and it is keyed off
 * `APP_NAME` rather than a second hand-typed copy of the product's own name:
 * a rename of the product renames the reserved word with it.
 *
 * Pure: no database, no request, no clock, no import beyond `zod` and
 * `#app/lib/app-name`. Unit tested.
 */
import { z } from 'zod';

import { APP_NAME } from '#app/lib/app-name';

/** The shortest and longest a public name may be, measured after trimming. */
export const PUBLIC_NAME_MIN_CHARS = 2;
export const PUBLIC_NAME_MAX_CHARS = 32;

/**
 * Letters, digits, spaces, and the small set of punctuation a display name
 * needs. No control characters.
 *
 * `\p{L}` AND `\p{N}` ARE UNICODE-WIDE, NOT ASCII-ONLY (M199 follow-up). A
 * real name like "Jörg" or "Müller" is a letter by any reasonable definition,
 * and an ASCII-only pattern refused both. The operator was asked and chose to
 * widen this rather than ask readers to spell their own name differently.
 */
const ALLOWED_CHARACTERS = /^[\p{L}\p{N} _.-]+$/u;

/**
 * Words nobody may take as their own display name, because each one reads as
 * an authority this product does not hand out. Folded once, below, alongside
 * the product's own name.
 */
const RESERVED_WORDS = [
  'admin',
  'administrator',
  'moderator',
  'operator',
  'support',
  'staff',
  'system',
  'official',
  'anonymous',
  'unknown',
  'null',
  'undefined',
  'root',
  'owner',
] as const;

/**
 * The stored form of a public name: trimmed and lower-cased.
 *
 * CASE IS FOLDED, DIACRITICS ARE NOT: "Jörg" and "Joerg" fold to two
 * different keys, "jörg" and "joerg", and both names may be taken at once.
 * `.toLowerCase()` normalizes case only, so widening the character set to
 * admit accented letters (above) changes nothing here on purpose, a name
 * that spells a sound with an umlaut is not the same string as one that
 * spells it with an extra letter, and folding them together would be a
 * second, silent rule about German transliteration this module has no
 * business making.
 *
 * @param raw whatever the form field carried.
 * @returns the folded form. This is what the unique index is over.
 */
export function foldPublicName(raw: string): string {
  return raw.trim().toLowerCase();
}

/** The reserved list, folded once at module load so every check is a single lookup. */
const RESERVED_FOLDED = new Set<string>([...RESERVED_WORDS.map(foldPublicName), foldPublicName(APP_NAME)]);

/** The shape check: trimmed, within bounds, and drawn from the allowed character set. */
const publicNameSchema = z
  .string()
  .trim()
  .min(PUBLIC_NAME_MIN_CHARS)
  .max(PUBLIC_NAME_MAX_CHARS)
  .regex(ALLOWED_CHARACTERS);

/**
 * The trimmed, validated name, or `null` when it is not one.
 *
 * `null` IS NOT AN ERROR CHANNEL TO THE READER HERE. This module only says
 * whether a candidate is acceptable; turning a refusal into a form error the
 * reader can act on is `app/routes/settings.tsx`'s job, not this one's.
 *
 * @param raw whatever the form field carried.
 * @returns the trimmed (never folded) form on success, or `null` when the
 *   shape is wrong or the folded form is reserved.
 */
export function parsePublicName(raw: string): string | null {
  const parsed = publicNameSchema.safeParse(raw);
  if (!parsed.success) return null;
  if (RESERVED_FOLDED.has(foldPublicName(parsed.data))) return null;
  return parsed.data;
}
