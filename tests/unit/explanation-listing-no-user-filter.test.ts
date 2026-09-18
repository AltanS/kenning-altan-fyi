/**
 * Guard: no public explanation listing may ever be filtered by a reader.
 *
 * WHY THIS IS A TEST AND NOT A LINE IN A README. "No per-user public page,
 * ever" is a permanent product rule (M200 binding finding 3), and a rule that
 * lives only in prose is a rule the next feature quietly reopens. This file is
 * the no-user-filter check: it reads the public listing module and the public
 * browse routes off disk and fails the build when either grows a way to ask
 * "what did this person ask".
 *
 * IT INSPECTS TWO PLACES BY NAME, AND THAT NARROWNESS IS DELIBERATE.
 *   `resolveOwnAuthorship`, `setShowName`, `setListed`, `castExplanationVote`
 *   and `readVoteForAccount` all correctly take a reader: they are ownership
 *   checks and mutations, not public listings. A whole-repo grep for "userId"
 *   would flag every one of them and be switched off within a week. So the
 *   scope is the PUBLIC listing module and the PUBLIC route files, found by
 *   walking the tree rather than from a hardcoded list, so a new browse route
 *   is covered the moment somebody adds it.
 *
 * FOUR DETECTORS, EACH CLOSING A DIFFERENT DOOR.
 *   1. A reader-named PARAMETER. There must be no slot to wire one into later.
 *   2. A reader-named FILTER. `explanationAuthorship.userId` and any
 *      `userProfiles` column are banned from `where`, `orderBy`, `groupBy` and
 *      `having`, which is "search by author" arriving through another door with
 *      no parameter for detector 1 to catch. The join condition and the byline
 *      select sit outside those four positions, so the legitimate uses need no
 *      whitelist: only their POSITION is checked.
 *   3. The vote table's account column, anywhere in the listing module. A
 *      listing that reads it is a listing that can be grouped by reader.
 *   4. A browse ROUTE reading a reader-named key out of the URL, or passing
 *      one into the listing model.
 *
 * IT PROVES ITSELF FIRST. Every detector is run over synthetic source that
 * SHOULD trip it and synthetic source that should not, and the walk asserts it
 * actually found the module and the routes. A guard that silently stopped
 * matching would otherwise be indistinguishable from a codebase that is clean.
 *
 * NO DATABASE. This reads files.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The word forms that name a reader. Case-insensitive: `userId`, `AccountId` and `author` all count. */
const READER_NAME_PATTERN = /user|account|author/i;

/** The four clause positions a listing filter can hide in. */
const FILTER_TOKENS = ['.where(', '.orderBy(', '.groupBy(', '.having('] as const;

/**
 * What may never appear in one of those positions.
 *
 * The last two are the raw column names, because a `sql` fragment can name a
 * column without going through the Drizzle object.
 */
const FORBIDDEN_IN_FILTER = ['explanationAuthorship.userId', 'userProfiles.', 'user_id', 'public_name'] as const;

/** The vote table's account column. Selecting or filtering on it turns a tally into a per-reader read. */
const VOTER_COLUMN = 'explanationVotes.accountId';

/** Files that hold generated or vendored code, never authored source. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'build', '.react-router']);

function walk(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      found.push(...walk(full));
      continue;
    }
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
    found.push(relative(REPO_ROOT, full));
  }
  return found;
}

/** The public listing module, found rather than named, so a rename fails loudly here. */
const modelFiles = walk(join(REPO_ROOT, 'app/models'))
  .filter((file) => file.includes('explanation-browse'))
  .toSorted();

/** Every public browse route file. A new one is covered without anybody remembering to add it. */
const browseRouteFiles = walk(join(REPO_ROOT, 'app/routes'))
  .filter((file) => /(^|\/)browse\.[^/]*\.tsx?$/.test(file))
  .toSorted();

function read(file: string): string {
  return readFileSync(join(REPO_ROOT, file), 'utf8');
}

/** The text between the parenthesis at `openIndex` and its matching close. */
function readBalanced(source: string, openIndex: number): string {
  let depth = 0;
  for (let cursor = openIndex; cursor < source.length; cursor += 1) {
    if (source[cursor] === '(') depth += 1;
    else if (source[cursor] === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, cursor);
    }
  }
  return source.slice(openIndex + 1);
}

/**
 * Every argument list following `token`, balanced.
 *
 * A LINE-BASED MATCH WOULD NOT DO. These clauses are written across several
 * lines with nested calls inside them, so the scan has to count parentheses.
 */
function argumentsOf(source: string, token: string): string[] {
  const found: string[] = [];
  let index = source.indexOf(token);
  while (index !== -1) {
    const open = index + token.length - 1;
    found.push(readBalanced(source, open));
    index = source.indexOf(token, open + 1);
  }
  return found;
}

/** The parameter list of every exported function. */
function exportedSignatures(source: string): string[] {
  const signatures: string[] = [];
  for (const match of source.matchAll(/export\s+(?:async\s+)?function\s+\w+\s*\(/g)) {
    signatures.push(readBalanced(source, (match.index ?? 0) + match[0].length - 1));
  }
  return signatures;
}

/** The body of every exported `*Params` interface. */
function paramsInterfaceBodies(source: string): string[] {
  const bodies: string[] = [];
  for (const match of source.matchAll(/export interface \w*Params\s*\{([\s\S]*?)\n\}/g)) {
    bodies.push(match[1] ?? '');
  }
  return bodies;
}

/** Detector 1: a reader-named parameter, or a reader-named field on a parameter object. */
function findReaderNamedDeclarations(source: string): string[] {
  return [...exportedSignatures(source), ...paramsInterfaceBodies(source)]
    .filter((text) => READER_NAME_PATTERN.test(text))
    .map((text) => text.trim());
}

/** Detector 2: an authorship or profile column used to filter, sort or group. */
function findReaderNamedFilters(source: string): string[] {
  const hits: string[] = [];
  for (const token of FILTER_TOKENS) {
    for (const text of argumentsOf(source, token)) {
      for (const needle of FORBIDDEN_IN_FILTER) {
        if (text.includes(needle)) hits.push(`${token} carries ${needle}`);
      }
    }
  }
  return hits;
}

/** Detector 3: the vote table's account column, anywhere at all. */
function findVoterColumn(source: string): string[] {
  return source.includes(VOTER_COLUMN) ? [VOTER_COLUMN] : [];
}

/** The names a file imports from the public listing module. */
function importedListingNames(source: string): string[] {
  const match = /import\s*\{([\s\S]*?)\}\s*from\s*['"][^'"]*explanation-browse\.server['"]/.exec(source);
  if (match === null) return [];
  return (match[1] ?? '')
    .split(',')
    .map(
      (entry) =>
        entry
          .trim()
          .split(/\s+as\s+/)
          .at(-1) ?? '',
    )
    .filter((entry) => entry.length > 0);
}

/** Detector 4: a browse route reading a reader-named key, or handing one to the listing model. */
function findReaderNamedRouteInputs(source: string): string[] {
  const hits: string[] = [];

  for (const match of source.matchAll(/searchParams\.get\(\s*['"`]([^'"`]+)['"`]\s*\)/g)) {
    const key = match[1] ?? '';
    if (READER_NAME_PATTERN.test(key)) hits.push(`reads ?${key}= out of the URL`);
  }
  for (const match of source.matchAll(/\bparams\.(\w+)/g)) {
    const key = match[1] ?? '';
    if (READER_NAME_PATTERN.test(key)) hits.push(`reads params.${key} off the path`);
  }
  for (const name of importedListingNames(source)) {
    for (const text of argumentsOf(source, `${name}(`)) {
      if (READER_NAME_PATTERN.test(text)) hits.push(`passes ${text.trim()} into ${name}`);
    }
  }

  return hits;
}

// ── Synthetic source, so every detector can be shown to work ──────────────

const BAD_DECLARATIONS = `
export interface ListThingsParams {
  accountId: number;
  limit: number;
}
export async function listThings(db: Db, { accountId, limit }: ListThingsParams): Promise<void> {}
`;

const GOOD_DECLARATIONS = `
export interface ListThingsParams {
  from: string | null;
  limit: number;
}
export async function listThings(db: Db, { from, limit }: ListThingsParams): Promise<void> {}
`;

const BAD_FILTERS = `
const rows = db
  .select({ name: userProfiles.publicName })
  .from(latest)
  .where(and(eq(explanationAuthorship.listed, true), eq(explanationAuthorship.userId, readerId)))
  .orderBy(desc(userProfiles.publicName))
  .groupBy(sql\`user_id\`)
  .having(sql\`max(public_name) is not null\`);
`;

const GOOD_FILTERS = `
const rows = db
  .select({
    name: sql\`case when \${explanationAuthorship.showName} then \${userProfiles.publicName} end\`,
  })
  .from(latest)
  .innerJoin(explanationAuthorship, eq(explanationAuthorship.explanationId, latest.id))
  .leftJoin(userProfiles, eq(userProfiles.userId, explanationAuthorship.userId))
  .where(and(eq(explanationAuthorship.listed, true), notExists(hidden)))
  .orderBy(desc(latest.createdAt));
`;

const BAD_VOTER_COLUMN = `
const rows = db.select({ who: explanationVotes.accountId }).from(explanationVotes);
`;

const GOOD_VOTER_COLUMN = `
const rows = db.select({ up: UP }).from(explanationVotes).groupBy(explanationVotes.explanationId);
`;

const BAD_ROUTE = `
import { listPublicExplanations } from '#app/models/explanation-browse.server';
export async function loader({ request }) {
  const url = new URL(request.url);
  const authorId = url.searchParams.get('authorId');
  return listPublicExplanations(db, { authorId, limit: 20, offset: 0 });
}
`;

const GOOD_ROUTE = `
import { listPublicExplanations } from '#app/models/explanation-browse.server';
export async function loader({ request, params }) {
  const url = new URL(request.url);
  const from = url.searchParams.get('from');
  const page = params.id;
  return listPublicExplanations(db, { from, to: null, limit: 20, offset: 0 });
}
`;

describe('the public explanation listing is never filtered by a reader', () => {
  it('found the listing module and the browse routes it is meant to guard', () => {
    assert.equal(
      modelFiles.length,
      1,
      `expected exactly one public listing module under app/models, walked ${modelFiles.length}. This guard ` +
        'covers the module by name fragment, so a rename must be noticed here rather than silently disabling it.',
    );
    assert.ok(
      browseRouteFiles.length >= 2,
      `expected at least two app/routes/browse.* files, walked ${browseRouteFiles.length}. With none found, every ` +
        'route assertion below would pass over an empty list.',
    );
    const signatures = exportedSignatures(read(modelFiles[0] ?? ''));
    assert.ok(
      signatures.length >= 1,
      `parsed ${signatures.length} exported function signatures out of ${modelFiles[0]}. Zero means the parser ` +
        'stopped matching this module, not that the module is clean.',
    );
  });

  it('flags a reader-named parameter and passes a language-shaped one', () => {
    assert.ok(findReaderNamedDeclarations(BAD_DECLARATIONS).length > 0);
    assert.deepEqual(findReaderNamedDeclarations(GOOD_DECLARATIONS), []);
  });

  it('flags an authorship or profile column in a filter, and ignores the join and the byline select', () => {
    assert.ok(findReaderNamedFilters(BAD_FILTERS).length >= 4);
    assert.deepEqual(
      findReaderNamedFilters(GOOD_FILTERS),
      [],
      'the position check has become a whole-file grep: the join condition and the byline select are the two ' +
        'legitimate uses of these columns and must not be flagged.',
    );
  });

  it('flags the vote account column and passes a tally grouped by explanation', () => {
    assert.deepEqual(findVoterColumn(BAD_VOTER_COLUMN), [VOTER_COLUMN]);
    assert.deepEqual(findVoterColumn(GOOD_VOTER_COLUMN), []);
  });

  it('flags a route reading a reader-named key and passes one reading a language', () => {
    assert.ok(findReaderNamedRouteInputs(BAD_ROUTE).length >= 2);
    assert.deepEqual(findReaderNamedRouteInputs(GOOD_ROUTE), []);
  });

  for (const file of modelFiles) {
    it(`${file}: declares no reader-named parameter`, () => {
      const hits = findReaderNamedDeclarations(read(file));
      assert.deepEqual(
        hits,
        [],
        `${file} declares a reader-named parameter:\n${hits.join('\n')}\n` +
          'A public listing must have no slot for a reader id, so no later change can wire one in. An ownership ' +
          'check or a mutation that legitimately takes one belongs in another module.',
      );
    });

    it(`${file}: filters, sorts and groups on nothing that names a reader`, () => {
      const hits = findReaderNamedFilters(read(file));
      assert.deepEqual(
        hits,
        [],
        `${file} uses an authorship or profile column to narrow a listing:\n${hits.join('\n')}\n` +
          'The one allowed use of either is the join condition and the byline in the select list. Filtering on ' +
          'them is "search by author" arriving through another door.',
      );
    });

    it(`${file}: never reads the vote table's account column`, () => {
      const hits = findVoterColumn(read(file));
      assert.deepEqual(
        hits,
        [],
        `${file} reads ${VOTER_COLUMN}. A tally is grouped by explanation and by nothing else: reading the ` +
          'account column here is how a public list becomes a per-reader one.',
      );
    });
  }

  for (const file of browseRouteFiles) {
    it(`${file}: takes no reader-named input from the URL`, () => {
      const hits = findReaderNamedRouteInputs(read(file));
      assert.deepEqual(
        hits,
        [],
        `${file} takes a reader-named value from the request:\n${hits.join('\n')}\n` +
          'A public browse page filters by language and by nothing about a person.',
      );
    });
  }
});
