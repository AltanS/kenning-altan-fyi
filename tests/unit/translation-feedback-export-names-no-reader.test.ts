/**
 * Guard: the fine-tuning corpus export may never read the fact table, and no
 * record it emits may carry a reader-shaped field.
 *
 * WHY THIS IS A TEST AND NOT A LINE IN A README. One press of the reject button
 * writes two rows: `translation_rejections`, which knows WHO, and
 * `translation_rejection_signals`, which knows WHAT. Nothing joins them, and
 * that split is the whole design of the feature rather than a detail of it. An
 * export that joined the two would collapse it WITH NO BUG AND NO OTHER CHANGE:
 * the file would simply start carrying which named accounts disliked which
 * words, every test would stay green, and the only thing lost would be the
 * product's claim. A rule that lives only in prose is a rule the next feature
 * quietly reopens, so this file reads the export module off disk and fails the
 * build when it grows either door.
 *
 * IT IS THE SIBLING OF `explanation-listing-no-user-filter.test.ts`, which does
 * the same job for the public explanation pages, and it is written in the same
 * shape on purpose: a narrow scope found by name rather than a whole-repo grep,
 * comment stripping before any token detector, and every detector proved
 * against synthetic source that should trip it and synthetic source that should
 * not.
 *
 * THREE DETECTORS.
 *   1. THE FACT TABLE, by either of its names. `translationRejections` is the
 *      Drizzle object and `translation_rejections` is the SQL one, and a `sql`
 *      fragment can reach the table without going through the object.
 *      `translationRejectionSignals` and `translation_rejection_signals` are the
 *      table this module is SUPPOSED to read, and they contain neither banned
 *      string, so no exception is needed for them.
 *   2. A READER-SHAPED FIELD on an exported record type. Every field name
 *      declared in the module's exported interfaces has to be free of `account`,
 *      `user`, `session` and `ip`. It reads the field NAMES only: a `string`
 *      type annotation cannot trip it, and neither can a comment.
 *   3. THE ACCOUNT COLUMNS of the two tables the module does read, anywhere in
 *      its source. `translationVotes.accountId` and the raw `account_id` are the
 *      way a grouped statement stops being grouped.
 *
 * COMMENTS ARE STRIPPED BEFORE EVERY DETECTOR RUNS. Detectors 1 and 3 ban a
 * TOKEN, and the module is REQUIRED by its own brief to name the table it must
 * not touch, in a comment saying why. A whole-file grep would turn that
 * explanation into a failure, which teaches the next author to delete the
 * explanation. `stripComments` is the same heuristic the explanation guard uses,
 * with the same two known directions of error written over it.
 *
 * NO DATABASE. This reads files.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MODULE_PATH = fileURLToPath(
  new URL('../../app/lib/reports/translation-feedback-export.server.ts', import.meta.url),
);

/** The fact table, under both of the names source code can reach it by. */
const FACT_TABLE_TOKENS = ['translationRejections', 'translation_rejections'] as const;

/** The account columns of the two tables this module does read. */
const ACCOUNT_COLUMN_TOKENS = ['accountId', 'account_id'] as const;

/** What a field name may not look like. */
const READER_FIELD_PATTERN = /account|user|session|ip/i;

/**
 * The source with its comments removed.
 *
 * IT IS A HEURISTIC AND NOT A PARSER, AND IT IS WRONG IN TWO DIRECTIONS. A line
 * whose text before the `//` already holds a quote is left whole, because the
 * `//` may be inside a string: a token named in a real comment on such a line is
 * therefore OVER-reported, which is the safe direction for a guard. The other
 * direction is not safe and is written down so nobody has to rediscover it: a
 * `//` that is part of a regex literal truncates its line, so whatever code
 * follows on that line is dropped before the detectors run.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const comment = line.indexOf('//');
      if (comment === -1) return line;
      const before = line.slice(0, comment);
      return /['"`]/.test(before) ? line : before;
    })
    .join('\n');
}

/** Every token out of `tokens` that appears in the code of `source`. */
function bannedTokensIn(source: string, tokens: readonly string[]): string[] {
  const code = stripComments(source);
  return tokens.filter((token) => code.includes(token));
}

/**
 * Every field name declared in the source's exported interfaces.
 *
 * THE INTERFACE BODY IS READ BY BRACE BALANCE, AND A FIELD IS ANY NAME AFTER A
 * SEPARATOR, so a nested object type inside a field's annotation is walked too:
 * a `run: { accountId: number }` written inline is reported, which is where a
 * well-meaning "just the count of distinct people" change would actually land.
 * The separator alternation is what keeps a `Record<RejectionReason, number>`
 * annotation out: neither of its arguments is followed by a colon.
 */
function exportedFieldNames(source: string): string[] {
  const code = stripComments(source);
  const names: string[] = [];

  const header = /export\s+interface\s+\w+\s*\{/g;
  let match = header.exec(code);
  while (match !== null) {
    const openIndex = code.indexOf('{', match.index);
    let depth = 0;
    let end = openIndex;
    for (let index = openIndex; index < code.length; index += 1) {
      if (code[index] === '{') depth += 1;
      if (code[index] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }

    // A newline is prepended so the first field, which has nothing before it,
    // matches the same separator alternation as every other one.
    const body = `\n${code.slice(openIndex + 1, end)}`;
    const field = /[\n{;,]\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/g;
    let fieldMatch = field.exec(body);
    while (fieldMatch !== null) {
      const name = fieldMatch[1];
      if (name !== undefined) names.push(name);
      fieldMatch = field.exec(body);
    }

    match = header.exec(code);
  }

  return names;
}

const source = readFileSync(MODULE_PATH, 'utf8');

describe('the translation feedback export names no reader', () => {
  it('finds the export module it claims to be checking', () => {
    assert.ok(
      source.includes('buildTranslationFeedbackExport'),
      `${MODULE_PATH} does not export buildTranslationFeedbackExport. Either the module moved ` +
        'or it was renamed, and this guard is protecting nothing.',
    );
  });

  it('never reads the rejection fact table', () => {
    assert.deepEqual(
      bannedTokensIn(source, FACT_TABLE_TOKENS),
      [],
      'The export reached translation_rejections. That table carries the account id, and joining ' +
        'it here would put named readers and the words they disliked in one corpus file. Count ' +
        'the signal rows instead: recordRejection writes one per genuinely new fact row.',
    );
  });

  it('never reads an account column', () => {
    assert.deepEqual(
      bannedTokensIn(source, ACCOUNT_COLUMN_TOKENS),
      [],
      'The export named an account column. The vote read must group it away before anything is ' +
        'selected, and the signal read has no such column at all.',
    );
  });

  it('declares no reader-shaped field on any exported record', () => {
    const fields = exportedFieldNames(source);
    assert.ok(fields.length > 0, 'No interface fields were found, so this detector read nothing.');

    const offenders = fields.filter((name) => READER_FIELD_PATTERN.test(name));
    assert.deepEqual(
      offenders,
      [],
      `These exported fields name a reader: ${offenders.join(', ')}. An exported record is corpus ` +
        'data and carries no account id, no session and no IP.',
    );
  });

  it('reads the fields it claims to read', () => {
    const fields = exportedFieldNames(source);
    for (const expected of ['verdict', 'lemma', 'promptVersion', 'reasons', 'targetLemma']) {
      assert.ok(fields.includes(expected), `The field scan missed "${expected}", so it is not reading the records.`);
    }
  });
});

describe('the guard proves itself', () => {
  it('catches the fact table in code and allows it in a comment', () => {
    const inCode = 'import { translationRejections } from "#drizzle/schema";';
    const inComment = '// never read translation_rejections here\nconst x = 1;';
    const signalTable = 'import { translationRejectionSignals } from "#drizzle/schema";';

    assert.deepEqual(bannedTokensIn(inCode, FACT_TABLE_TOKENS), ['translationRejections']);
    assert.deepEqual(bannedTokensIn(inComment, FACT_TABLE_TOKENS), []);
    // The signal table is what this module is supposed to read, and its name
    // holds neither banned string, so no exception is needed for it.
    assert.deepEqual(bannedTokensIn(signalTable, FACT_TABLE_TOKENS), []);
  });

  it('catches an account column in code', () => {
    assert.deepEqual(bannedTokensIn('.groupBy(translationVotes.accountId)', ACCOUNT_COLUMN_TOKENS), ['accountId']);
    assert.deepEqual(bannedTokensIn('sql`select account_id from t`', ACCOUNT_COLUMN_TOKENS), ['account_id']);
    assert.deepEqual(bannedTokensIn('const up = 1;', ACCOUNT_COLUMN_TOKENS), []);
  });

  it('reads field names out of an exported interface and ignores annotations', () => {
    const synthetic = [
      'export interface Good {',
      '  verdict: "rejected";',
      '  lemma: string;',
      '  run: { model: string } | null;',
      '}',
      'interface NotExported {',
      '  accountId: number;',
      '}',
    ].join('\n');

    const fields = exportedFieldNames(synthetic);
    assert.deepEqual(fields, ['verdict', 'lemma', 'run', 'model']);
    assert.deepEqual(
      fields.filter((name) => READER_FIELD_PATTERN.test(name)),
      [],
    );
  });

  it('catches a reader-shaped field nested in an inline type', () => {
    // `rejectedBy` is deliberately NOT reader-shaped by name: the detector has to
    // find the `userId` one level in, which is where a well-meaning "just the
    // count of distinct people" change would actually put it.
    const synthetic = ['export interface Bad {', '  lemma: string;', '  rejectedBy: { userId: number };', '}'].join(
      '\n',
    );

    assert.deepEqual(exportedFieldNames(synthetic), ['lemma', 'rejectedBy', 'userId']);
    assert.deepEqual(
      exportedFieldNames(synthetic).filter((name) => READER_FIELD_PATTERN.test(name)),
      ['userId'],
    );
  });
});
