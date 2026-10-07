/**
 * wikdict.ts, turning a WikDict `xx-yy.sqlite3` file into a word index.
 *
 * WHAT A WIKDICT PAIR FILE IS. The upstream project publishes one SQLite file
 * per direction. Its `simple_translation` table holds one row per written form:
 * `written_rep` (the word), `trans_list` (its translations joined by ` | `),
 * `max_score` and `rel_importance`. The file carries NO language metadata, so
 * the direction is known only from the file's NAME, which is why
 * {@link parseWikdictFileName} exists and why the caller states `from`.
 *
 * WHAT THIS BUILDS. A flat list of entries, one per NORMALISED word, ready for
 * the on-device store. The key is `normalizeForLanguage(written_rep, from)`, the
 * one definition of a normalised word that the corpus importers and the search
 * path already share. A typed word and a stored key therefore fold the same way,
 * and `Haus`, `haus` and `HAUS` meet at one key. A second implementation here
 * would not fail; it would quietly move words out of reach.
 *
 * ROWS THAT SHARE A KEY MERGE. `Haus` and `haus` are two rows upstream (and a
 * noun and a verb can share a spelling). They become one entry: the translations
 * of the higher-scoring row come first, a repeat of a word is dropped, and
 * `written` is the spelling of the highest-scoring row, so the entry is labelled
 * with the form people most often mean.
 *
 * WHAT IT REFUSES. A file with no `simple_translation` table (the reader throws
 * `SqliteFormatError`), and a row with fewer than four columns, which would mean
 * the table is not the one this reads.
 *
 * LICENCE NOTE. The data is CC BY-SA 4.0. It is read in the reader's browser from
 * a file the reader chose, and nothing here sends it anywhere. See
 * `device-dictionary-store.ts` for the labelling constants.
 */

import { z } from 'zod';
import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import { isPairLanguage } from '#app/lib/dictionary/language-pair';
import { normalizeForLanguage } from '#app/lib/dictionary/normalize';
import type { DeviceDictionaryEntry } from './device-dictionary-store';
import { readTableRows, SqliteFormatError, type SqliteValue } from './sqlite-table-reader';

/** The table WikDict's reader-facing word list lives in. */
const SIMPLE_TRANSLATION_TABLE = 'simple_translation';

/** `written_rep`, `trans_list`, `max_score`, `rel_importance`. */
const REQUIRED_COLUMNS = 4;

/** The three characters that separate words inside `trans_list`. */
const TRANSLATION_SEPARATOR = ' | ';

/** A WikDict file name: two lowercase codes, a hyphen, `.sqlite3` or `.sqlite`. */
const FILE_NAME_PATTERN = /^(?<from>[a-z]{2})-(?<to>[a-z]{2})\.sqlite3?$/u;

/** A column that must hold text to be usable: a non-empty string. */
const textSchema = z.string().min(1);

/** A score that is not a number (NULL, text) ranks as 0 instead of failing the row. */
const scoreSchema = z.number().catch(0);

/** The direction a WikDict file answers. */
export interface WikdictPair {
  from: LanguageCode;
  to: LanguageCode;
}

/** What {@link buildWikdictIndex} needs besides the bytes. */
export interface BuildWikdictIndexOptions {
  /** The language of the written forms, which decides how a key is folded. */
  from: LanguageCode;
}

/** One usable row, before rows with the same key are merged. */
interface RowCandidate {
  written: string;
  translations: string[];
  score: number;
}

/**
 * Read the direction off a WikDict file name.
 *
 * Both codes must be served languages and they must differ: a file for a
 * language Kenning does not serve could never be looked up, and `en-en` names no
 * translation. Case matters because WikDict publishes lowercase names, and
 * anything else is a file somebody renamed.
 *
 * @param name The file name, such as `en-de.sqlite3`. A path is not a name.
 * @returns The direction, or `null` when the name is not a usable WikDict pair.
 */
export function parseWikdictFileName(name: string): WikdictPair | null {
  const groups = FILE_NAME_PATTERN.exec(name)?.groups;
  if (groups === undefined) return null;
  const { from, to } = groups;
  if (!isPairLanguage(from) || !isPairLanguage(to)) return null;
  if (from === to) return null;
  return { from, to };
}

/**
 * Split one `trans_list` into its words.
 *
 * @param list The cell, such as `Haus | Kammer | Mutter, Vater, Kind`.
 * @returns Trimmed, non-empty, distinct words in the order they were listed.
 */
function splitTranslations(list: string): string[] {
  const words = list
    .split(TRANSLATION_SEPARATOR)
    .map((word) => word.trim())
    .filter((word) => word !== '');
  return [...new Set(words)];
}

/**
 * Read one table row into a candidate, or nothing when the row is unusable.
 *
 * @param row The row's four columns.
 * @param from The language of the written form, which decides how its key is folded.
 * @returns The candidate and its normalised key, or `null` for a skipped row.
 */
function readCandidate(row: SqliteValue[], from: LanguageCode): { key: string; candidate: RowCandidate } | null {
  const written = textSchema.safeParse(row[0]);
  const list = textSchema.safeParse(row[1]);
  if (!written.success || !list.success) return null;
  const key = normalizeForLanguage(written.data, from);
  if (key === '') return null;
  const translations = splitTranslations(list.data);
  if (translations.length === 0) return null;
  return { key, candidate: { written: written.data, translations, score: scoreSchema.parse(row[2]) } };
}

/**
 * Merge the rows that share a key into one entry.
 *
 * `toSorted` is stable, so two rows with the same score keep the order the file
 * listed them in and the result does not depend on how the sort is implemented.
 *
 * @param key The normalised word.
 * @param candidates Every usable row that folds to it.
 */
function mergeCandidates(key: string, candidates: readonly RowCandidate[]): DeviceDictionaryEntry {
  const ranked = candidates.toSorted((left, right) => right.score - left.score);
  const [best] = ranked;
  return {
    key,
    written: best?.written ?? key,
    translations: [...new Set(ranked.flatMap((candidate) => candidate.translations))],
    score: best?.score ?? 0,
  };
}

/**
 * Turn the rows of a `simple_translation` table into entries.
 *
 * This is the whole of the conversion with the file reading taken out, so the
 * merge, the skipping and the splitting can be tested against rows written by
 * hand instead of against a binary fixture.
 *
 * @param rows The table's rows, four columns each.
 * @param options Which language the written forms are in.
 * @throws SqliteFormatError If a row has fewer than four columns.
 */
export function indexWikdictRows(rows: Iterable<SqliteValue[]>, { from }: BuildWikdictIndexOptions): DeviceDictionaryEntry[] {
  const grouped = new Map<string, RowCandidate[]>();
  for (const row of rows) {
    if (row.length < REQUIRED_COLUMNS) {
      throw new SqliteFormatError(`a ${SIMPLE_TRANSLATION_TABLE} row has ${row.length} columns, expected ${REQUIRED_COLUMNS}`);
    }
    const read = readCandidate(row, from);
    if (read === null) continue;
    const existing = grouped.get(read.key);
    if (existing === undefined) grouped.set(read.key, [read.candidate]);
    else existing.push(read.candidate);
  }
  return Array.from(grouped, ([key, candidates]) => mergeCandidates(key, candidates));
}

/**
 * Build the word index from a WikDict file's bytes.
 *
 * @param bytes The whole `xx-yy.sqlite3` file.
 * @param options Which language the written forms are in.
 * @returns One entry per normalised word, in the order the file first met it.
 * @throws SqliteFormatError If this is not a SQLite file this reader can read,
 *   or it has no `simple_translation` table.
 */
export function buildWikdictIndex(bytes: Uint8Array, options: BuildWikdictIndexOptions): DeviceDictionaryEntry[] {
  return indexWikdictRows(readTableRows(bytes, SIMPLE_TRANSLATION_TABLE), options);
}
