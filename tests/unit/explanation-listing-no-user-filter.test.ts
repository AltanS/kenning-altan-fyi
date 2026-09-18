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
 * IT IS AN ALLOW-LIST, AND THAT CHANGED AFTER A REVIEW. The first version of
 * this guard banned a list of reader-shaped NAMES, and a deny-list only ever
 * knows the doors somebody already thought of. The review's own counter-example
 * is kept below as a synthetic case: a `byline` parameter, a helper matching
 * `userProfiles.publicNameFolded` handed in as the `extra` condition, and a
 * route reading `?byline=`. Not one of those names matches `/user|account|author/i`
 * and the column never appears in a filter position, so every name-shaped
 * detector passes it, and it is a per-person public page. So the listing module
 * may now declare only the keys it is supposed to have, and the routes may read
 * only the keys they are supposed to read: anything new has to be added HERE,
 * deliberately, before it can be added there.
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
 * SEVEN DETECTORS, EACH CLOSING A DIFFERENT DOOR.
 *   1. An ALLOWED SET OF PARAMETER KEYS. Every key an exported `*Params`
 *      declaration holds, an `interface` and a `type` alias alike, and every key
 *      an exported function destructures, has to be one of `from`, `to`,
 *      `limit`, `offset`, `id`. An `extends` clause fails on sight: its
 *      inherited keys are declared somewhere else and a text scan of this module
 *      will never see them, so the scan must not pretend it read them.
 *   2. A reader-named PARAMETER, still checked by name, because detector 1 sees
 *      only destructured keys and a positional `userId: number` is neither.
 *   3. TWO BANNED TOKENS in the listing module: `publicNameFolded` and
 *      `foldPublicName`. That column exists to match a person by the name they
 *      chose, which is the one lookup a public list must never offer.
 *   4. The PROFILE COLUMNS the module may name at all: `userProfiles.userId`
 *      (the join) and `userProfiles.publicName` (the byline select), and no
 *      third one anywhere in the file.
 *   5. A reader-named FILTER. `explanationAuthorship.userId` and any
 *      `userProfiles` column are banned from `where`, `orderBy`, `groupBy` and
 *      `having`. The join condition and the byline select sit outside those four
 *      positions, so the legitimate uses need no whitelist: only their POSITION
 *      is checked.
 *   6. The vote table's account column, anywhere in the listing module. A
 *      listing that reads it is a listing that can be grouped by reader.
 *   7. An ALLOWED SET OF ROUTE KEYS. Every key a browse route reads with
 *      `searchParams.get`, `.getAll` or `.has` has to be one of `from`, `to`,
 *      `page`, and every `params.<name>` it reads has to be one of those three
 *      or `id`. `Object.fromEntries(url.searchParams)` is banned outright,
 *      because it hands every key over at once and leaves no key for an
 *      allow-list to read.
 *
 * COMMENTS ARE STRIPPED BEFORE DETECTORS 1, 3, 4 AND 7 RUN. Those four ban a
 * TOKEN rather than a position, and a module is encouraged to name the thing it
 * must not do in a comment saying why. A whole-file grep would turn that
 * explanation into a failure, which teaches the next author to delete the
 * explanation. `stripComments` removes block comments and end-of-line ones, and
 * leaves a line holding a quote before the `//` alone rather than guessing. It
 * is a heuristic and not a parser, and both directions it can be wrong in are
 * written over the function itself.
 *
 * IT PROVES ITSELF FIRST. Every detector is run over synthetic source that
 * SHOULD trip it and synthetic source that should not, and the walk asserts it
 * actually found the module, the routes, the signatures, the parameter keys and
 * the URL keys it claims to be checking. A guard that silently stopped matching
 * would otherwise be indistinguishable from a codebase that is clean.
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

/**
 * Every key the public listing module may take, and nothing else.
 *
 * `from` and `to` are the language filter, `limit` and `offset` are the window,
 * `id` addresses one row. A new one belongs here first, with a reason.
 */
const ALLOWED_PARAM_KEYS = new Set(['from', 'to', 'limit', 'offset', 'id']);

/**
 * Every key a browse route may read off a `params` object. `id` addresses the detail page.
 *
 * THE THREE QUERY KEYS ARE ON THIS SET TOO, and that is not slack. The scan
 * behind it is `\bparams\.(\w+)`, which also reads a local helper's own options
 * object, and the list route has one that carries `from`, `to` and `page`.
 */
const ALLOWED_ROUTE_KEYS = new Set(['from', 'to', 'page', 'id']);

/** Every key a browse route may read out of the query string. `page` is the window, and it never reaches the model. */
const ALLOWED_QUERY_KEYS = new Set(['from', 'to', 'page']);

/**
 * Names the listing module may not carry at all.
 *
 * `publicNameFolded` is the case-folded profile name, and `foldPublicName` is
 * what writes it. The column exists so a person can be found by the name they
 * chose, which is the single lookup these pages must never offer.
 */
const BANNED_TOKENS = ['publicNameFolded', 'foldPublicName'] as const;

/** The only two profile columns the listing module may name: the join key, and the byline. */
const ALLOWED_PROFILE_COLUMNS = new Set(['userId', 'publicName']);

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

/**
 * The source with its comments removed.
 *
 * IT IS A HEURISTIC AND NOT A PARSER, AND IT IS WRONG IN TWO DIRECTIONS. A line
 * whose text before the `//` already holds a quote is left whole, because the
 * `//` may be inside a string: a token named in a real comment on such a line is
 * therefore OVER-reported, which is the safe direction for a guard.
 * The other direction is not safe and is written down so nobody has to
 * rediscover it: a `//` that is part of a regex literal truncates its line, so
 * whatever code follows on that line is dropped before detectors 1, 3, 4 and 7
 * ever run.
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

/** The bracket pairs the balanced reader below can walk. */
const BRACKETS = {
  paren: { open: '(', close: ')' },
  brace: { open: '{', close: '}' },
} as const;

/** The text between the bracket at `openIndex` and its matching close. */
function readBalanced(source: string, openIndex: number, bracket: keyof typeof BRACKETS = 'paren'): string {
  const { open, close } = BRACKETS[bracket];
  let depth = 0;
  for (let cursor = openIndex; cursor < source.length; cursor += 1) {
    if (source[cursor] === open) depth += 1;
    else if (source[cursor] === close) {
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

/** One exported `*Params` declaration, split at the brace that opens its object body. */
interface ParamsDeclaration {
  /** What stands between the name and the body: ` = ` for a `type` alias, ` extends Base ` for an interface. */
  head: string;
  /** The object body, between the braces. */
  body: string;
}

/**
 * Every exported `*Params` declaration, an `interface` and a `type` alias alike.
 *
 * THE FIRST VERSION MATCHED `export interface \w*Params {` AND NOTHING ELSE. A
 * review showed what that costs: a `type` alias and an `extends` clause each
 * dropped the whole declaration, and the self-check below stayed green because
 * the module still had one interface and five keys, just not the one that had
 * changed. So the keyword is a group, `(interface|type)`, and everything up to
 * the opening brace is captured rather than skipped.
 *
 * The body is read by COUNTING BRACES rather than by looking for a `}` in the
 * first column, because a one-line alias has neither.
 *
 * A `*Params` alias with no object body at all, `= SomeOtherType;`, makes
 * `[^{]*` run forward to the next brace in the file and report that block's
 * keys. That is loud and wrong rather than silent and wrong, which is the
 * direction this guard is built to fail in.
 */
function paramsDeclarations(source: string): ParamsDeclaration[] {
  const declarations: ParamsDeclaration[] = [];
  for (const match of source.matchAll(/export\s+(interface|type)\s+\w*Params\b([^{]*)\{/g)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    declarations.push({ head: match[2] ?? '', body: readBalanced(source, open, 'brace') });
  }
  return declarations;
}

/** The body of every exported `*Params` declaration. */
function paramsDeclarationBodies(source: string): string[] {
  return paramsDeclarations(source).map((declaration) => declaration.body);
}

/**
 * Detector 1's other half: a declaration whose keys are not written where it stands.
 *
 * `interface ListPublicExplanationsParams extends ReaderScope` declares its
 * inherited keys in another file, and no scan of this one can read them. The
 * clause itself is therefore the failure, not any key: a public listing's
 * parameter list has to be readable in the place it is declared.
 */
function inheritedParamsClauses(source: string): string[] {
  return paramsDeclarations(source)
    .filter((declaration) => /\bextends\b/.test(declaration.head))
    .map((declaration) => declaration.head.trim());
}

/**
 * The property names a declaration body holds.
 *
 * A KEY CAN FOLLOW A SEPARATOR RATHER THAN A LINE BREAK. A one-line alias writes
 * `{ from: string | null; byline: string | null }`, and a line-anchored match
 * reads the first key off it and misses every later one.
 */
function declaredKeys(body: string): string[] {
  return [...body.matchAll(/(?:^|[;,])\s*(?:readonly\s+)?(\w+)\s*\??\s*:/gm)].map((match) => match[1] ?? '');
}

/**
 * The keys one signature destructures, or none when it takes its object whole.
 *
 * A SIGNATURE THAT NAMES ITS OBJECT IS NOT A FAILURE. `(db, params: ListParams)`
 * destructures nothing, and the interface check covers it: a guard that demanded
 * inline destructuring would reject a correct implementation for its shape.
 */
function destructuredKeys(signature: string): string[] {
  const open = signature.indexOf('{');
  if (open === -1) return [];
  const close = signature.indexOf('}', open);
  if (close === -1) return [];
  return signature
    .slice(open + 1, close)
    .split(',')
    .map((entry) => (entry.split(':')[0] ?? '').trim())
    .filter((entry) => entry.length > 0);
}

/** Every parameter key the listing module declares, from both places one can be written. */
function listingParamKeys(source: string): string[] {
  const stripped = stripComments(source);
  return [
    ...paramsDeclarationBodies(stripped).flatMap((body) => declaredKeys(body)),
    ...exportedSignatures(stripped).flatMap((signature) => destructuredKeys(signature)),
  ];
}

/** Detector 1: a parameter key that is not on the allow-list, or a declaration whose keys cannot be read here. */
function findDisallowedParamKeys(source: string): string[] {
  return [
    ...listingParamKeys(source).filter((key) => !ALLOWED_PARAM_KEYS.has(key)),
    ...inheritedParamsClauses(stripComments(source)),
  ];
}

/** Detector 2: a reader-named parameter, or a reader-named field on a parameter object. */
function findReaderNamedDeclarations(source: string): string[] {
  return [...exportedSignatures(source), ...paramsDeclarationBodies(source)]
    .filter((text) => READER_NAME_PATTERN.test(text))
    .map((text) => text.trim());
}

/** Detector 3: one of the banned name-matching tokens, in code rather than in a comment. */
function findBannedTokens(source: string): string[] {
  const stripped = stripComments(source);
  return BANNED_TOKENS.filter((token) => stripped.includes(token));
}

/** Every profile column the source names, in code rather than in a comment. */
function profileColumns(source: string): string[] {
  return [...stripComments(source).matchAll(/userProfiles\.(\w+)/g)].map((match) => match[1] ?? '');
}

/** Detector 4: a profile column that is neither the join key nor the byline. */
function findDisallowedProfileColumns(source: string): string[] {
  return profileColumns(source).filter((column) => !ALLOWED_PROFILE_COLUMNS.has(column));
}

/** Detector 5: an authorship or profile column used to filter, sort or group. */
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

/** Detector 6: the vote table's account column, anywhere at all. */
function findVoterColumn(source: string): string[] {
  return source.includes(VOTER_COLUMN) ? [VOTER_COLUMN] : [];
}

/**
 * Every key a route reads out of the query string.
 *
 * ALL THREE READERS, NOT ONLY `get`. The first version matched
 * `searchParams.get('literal')` alone, and `searchParams.getAll('byline')` and
 * `searchParams.has('author')` read the same query string straight past it.
 */
function searchParamKeys(source: string): string[] {
  return [...stripComments(source).matchAll(/searchParams\.(get|getAll|has)\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map(
    (match) => match[2] ?? '',
  );
}

/**
 * Every read that takes the WHOLE query string rather than a named key.
 *
 * `Object.fromEntries(url.searchParams)` hands over every key at once, so an
 * allow-list of key names has nothing left to read: the route can then be given
 * a new filter with no change this guard can see. The same goes for any other
 * `fromEntries` over a `URLSearchParams`.
 */
function findWholeQueryStringReads(source: string): string[] {
  return argumentsOf(stripComments(source), 'fromEntries(')
    .filter((text) => /searchParams|URLSearchParams/.test(text))
    .map((text) => `reads the whole query string: fromEntries(${text.trim()})`);
}

/** Every key a route reads off a `params` object, the path's own and any other. */
function pathParamKeys(source: string): string[] {
  return [...stripComments(source).matchAll(/\bparams\.(\w+)/g)].map((match) => match[1] ?? '');
}

/** Detector 7: a browse route reading a key that is not on the allow-list, or reading the query string whole. */
function findDisallowedRouteKeys(source: string): string[] {
  const hits: string[] = [];
  for (const key of searchParamKeys(source)) {
    if (!ALLOWED_QUERY_KEYS.has(key)) hits.push(`reads ?${key}= out of the URL`);
  }
  for (const key of pathParamKeys(source)) {
    if (!ALLOWED_ROUTE_KEYS.has(key)) hits.push(`reads params.${key}`);
  }
  hits.push(...findWholeQueryStringReads(source));
  return hits;
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

/** Detector 8: a browse route reading a reader-named key, or handing one to the listing model. */
function findReaderNamedRouteInputs(source: string): string[] {
  const hits: string[] = [];

  for (const key of searchParamKeys(source)) {
    if (READER_NAME_PATTERN.test(key)) hits.push(`reads ?${key}= out of the URL`);
  }
  for (const key of pathParamKeys(source)) {
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

/** A signature that takes its object whole. It destructures nothing, and that is correct. */
const GOOD_UNDESTRUCTURED = `
export interface ListThingsParams {
  from: string | null;
  to: string | null;
  limit: number;
  offset: number;
}
export async function listThings(db: Db, params: ListThingsParams): Promise<void> {}
`;

/** A `type` alias. The first version of detector 1 matched `export interface` only and read nothing here. */
const BAD_TYPE_ALIAS = `
export type ListPublicExplanationsParams = { from: string | null; byline: string | null };
`;

/** The same alias with only allowed keys, and on one line, so the brace-counting body read is exercised both ways. */
const GOOD_TYPE_ALIAS = `
export type ListPublicExplanationsParams = { from: string | null; to: string | null; limit: number };
`;

/** An `extends` clause. `ReaderScope` may declare anything at all, and nothing in this file can read it. */
const BAD_EXTENDS = `
export interface ListPublicExplanationsParams extends ReaderScope {
  from: string | null;
}
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

/** `getAll` reads the same query string `get` does, and the first version of detector 7 matched `get` alone. */
const BAD_GET_ALL_ROUTE = `
export async function loader({ request }) {
  const url = new URL(request.url);
  const bylines = url.searchParams.getAll('byline');
  return bylines;
}
`;

/** `has` never reads a value, and narrowing a list by whether a key is present is still narrowing it. */
const BAD_HAS_ROUTE = `
export async function loader({ request }) {
  const url = new URL(request.url);
  if (url.searchParams.has('author')) return null;
  return {};
}
`;

/** The whole query string at once, which leaves an allow-list of key names nothing to read. */
const BAD_FROM_ENTRIES_ROUTE = `
export async function loader({ request }) {
  const url = new URL(request.url);
  const query = Object.fromEntries(url.searchParams);
  return query;
}
`;

/** The three keys a browse page is allowed to read, each by name. */
const GOOD_QUERY_ROUTE = `
export async function loader({ request }) {
  const url = new URL(request.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const page = url.searchParams.get('page');
  return { from, to, page };
}
`;

/**
 * The review's own counter-example, which every name-shaped detector passes.
 *
 * A `byline` parameter matches nothing in `/user|account|author/i`, and the
 * profile column sits inside a helper handed in as the `extra` condition rather
 * than in a `where` position. This is a per-person public page, and the
 * allow-list is the only thing that stops it.
 */
const BAD_BYLINE_MODEL = `
export interface ListPublicExplanationsParams {
  from: string | null;
  to: string | null;
  byline: string | null;
  limit: number;
  offset: number;
}

function byName(name: string) {
  return eq(userProfiles.publicNameFolded, foldPublicName(name));
}

export async function listPublicExplanations(
  db: DictionaryDb,
  { from, to, byline, limit, offset }: ListPublicExplanationsParams,
): Promise<PublicExplanationPage> {
  const latest = latestAnsweredPerKey(db, { from, to, questionNormalized: null });
  return visibleExplanations(db, latest, byline === null ? undefined : byName(byline)).query;
}
`;

const BAD_BYLINE_ROUTE = `
import { listPublicExplanations } from '#app/models/explanation-browse.server';
export async function loader({ request }) {
  const url = new URL(request.url);
  const byline = url.searchParams.get('byline');
  return listPublicExplanations(db, { from: null, to: null, byline, limit: 20, offset: 0 });
}
`;

/** A module that names a banned token only where it says why it must not use it. */
const GOOD_BANNED_TOKENS = `
// The profile's folded name column exists to match a person by name. This list
// never reads publicNameFolded, and never calls foldPublicName.
const rows = db.select({ name: userProfiles.publicName }).from(userProfiles);
`;

/** A module naming a third profile column, which is neither the join key nor the byline. */
const BAD_PROFILE_COLUMNS = `
const rows = db.select({ folded: userProfiles.publicNameFolded, bio: userProfiles.bio }).from(userProfiles);
`;

describe('the public explanation listing is never filtered by a reader', () => {
  it('found the listing module, the browse routes and everything it claims to parse', () => {
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

    const model = read(modelFiles[0] ?? '');
    assert.ok(
      exportedSignatures(model).length >= 1,
      `parsed no exported function signatures out of ${modelFiles[0]}. Zero means the parser stopped matching ` +
        'this module, not that the module is clean.',
    );
    assert.ok(
      paramsDeclarationBodies(model).length >= 1,
      `parsed no exported *Params declaration out of ${modelFiles[0]}, so the allow-list would run over nothing.`,
    );
    assert.ok(
      listingParamKeys(model).length >= 5,
      `parsed ${listingParamKeys(model).length} parameter keys out of ${modelFiles[0]}. The module declares a ` +
        'language filter, a window and a row id, so a smaller number means the parser is missing declarations.',
    );
    assert.ok(
      profileColumns(model).length >= 2,
      `parsed ${profileColumns(model).length} profile column references out of ${modelFiles[0]}. The join and the ` +
        'byline are two, so fewer means detector 4 is looking at nothing.',
    );

    const routeSources = browseRouteFiles.map((file) => read(file));
    assert.ok(
      routeSources.flatMap((source) => searchParamKeys(source)).length >= 1,
      'parsed no searchParams.get key out of the browse routes, so the URL allow-list would run over nothing.',
    );
    assert.ok(
      routeSources.flatMap((source) => pathParamKeys(source)).length >= 1,
      'parsed no params.<name> read out of the browse routes, so half the URL allow-list would run over nothing.',
    );
  });

  it('allows only the five parameter keys a public listing needs', () => {
    // Twice: the interface declares it and the signature destructures it.
    assert.deepEqual(findDisallowedParamKeys(BAD_DECLARATIONS), ['accountId', 'accountId']);
    assert.deepEqual(findDisallowedParamKeys(GOOD_DECLARATIONS), []);
    assert.deepEqual(
      findDisallowedParamKeys(GOOD_UNDESTRUCTURED),
      [],
      'a signature that takes its params object whole was flagged. The interface check already covers it, and ' +
        'demanding inline destructuring would reject a correct implementation for its shape.',
    );
  });

  it('reads a `type` alias, and fails an `extends` clause rather than pretending to read it', () => {
    assert.deepEqual(
      findDisallowedParamKeys(BAD_TYPE_ALIAS),
      ['byline'],
      'a `type` alias declaring a byline parameter was not read at all. The declaration shape must not decide ' +
        'whether the allow-list runs.',
    );
    assert.deepEqual(
      findDisallowedParamKeys(BAD_EXTENDS),
      ['extends ReaderScope'],
      'a Params declaration inheriting from another type passed. Its keys are written somewhere else, so this ' +
        'scan cannot say what they are and must not report that it found none.',
    );
    assert.deepEqual(findDisallowedParamKeys(GOOD_TYPE_ALIAS), []);
  });

  it('flags a reader-named parameter and passes a language-shaped one', () => {
    assert.ok(findReaderNamedDeclarations(BAD_DECLARATIONS).length > 0);
    assert.deepEqual(findReaderNamedDeclarations(GOOD_DECLARATIONS), []);
  });

  it('flags the folded-name column and the function that writes it, but not a comment about them', () => {
    assert.deepEqual(findBannedTokens(BAD_BYLINE_MODEL), ['publicNameFolded', 'foldPublicName']);
    assert.deepEqual(
      findBannedTokens(GOOD_BANNED_TOKENS),
      [],
      'a comment explaining why the module must not match people by name was read as the module doing it. That ' +
        'teaches the next author to delete the explanation.',
    );
  });

  it('allows the join key and the byline column, and no third profile column', () => {
    assert.deepEqual(findDisallowedProfileColumns(BAD_PROFILE_COLUMNS), ['publicNameFolded', 'bio']);
    assert.deepEqual(findDisallowedProfileColumns(GOOD_FILTERS), []);
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

  it('allows only the four URL keys a browse page reads', () => {
    assert.deepEqual(findDisallowedRouteKeys(BAD_ROUTE), ['reads ?authorId= out of the URL']);
    assert.deepEqual(findDisallowedRouteKeys(GOOD_ROUTE), []);
  });

  it('reads getAll, has and a whole-query-string read, not only get', () => {
    assert.deepEqual(
      findDisallowedRouteKeys(BAD_GET_ALL_ROUTE),
      ['reads ?byline= out of the URL'],
      '`searchParams.getAll` walked past the URL allow-list. It reads the same query string `get` reads.',
    );
    assert.deepEqual(
      findDisallowedRouteKeys(BAD_HAS_ROUTE),
      ['reads ?author= out of the URL'],
      '`searchParams.has` walked past the URL allow-list. A branch on whether a key is present narrows the page ' +
        'just as a value does.',
    );
    assert.deepEqual(
      findDisallowedRouteKeys(BAD_FROM_ENTRIES_ROUTE),
      ['reads the whole query string: fromEntries(url.searchParams)'],
      'a route took the whole query string at once. No allow-list of key names can see what it then reads.',
    );
    assert.deepEqual(findDisallowedRouteKeys(GOOD_QUERY_ROUTE), []);
  });

  it('flags a route reading a reader-named key and passes one reading a language', () => {
    assert.ok(findReaderNamedRouteInputs(BAD_ROUTE).length >= 2);
    assert.deepEqual(findReaderNamedRouteInputs(GOOD_ROUTE), []);
  });

  it('catches the search-by-name door that every reader-NAMED detector lets through', () => {
    // First, the reason this guard is an allow-list at all: the name-shaped
    // detectors are green on a per-person public page.
    assert.deepEqual(findReaderNamedDeclarations(BAD_BYLINE_MODEL), []);
    assert.deepEqual(findReaderNamedFilters(BAD_BYLINE_MODEL), []);
    assert.deepEqual(findReaderNamedRouteInputs(BAD_BYLINE_ROUTE), []);

    // And the three allow-list detectors that do catch it.
    assert.deepEqual(findDisallowedParamKeys(BAD_BYLINE_MODEL), ['byline', 'byline']);
    assert.deepEqual(findBannedTokens(BAD_BYLINE_MODEL), ['publicNameFolded', 'foldPublicName']);
    assert.deepEqual(findDisallowedProfileColumns(BAD_BYLINE_MODEL), ['publicNameFolded']);
    assert.deepEqual(findDisallowedRouteKeys(BAD_BYLINE_ROUTE), ['reads ?byline= out of the URL']);
  });

  for (const file of modelFiles) {
    it(`${file}: declares only the parameter keys a public listing needs`, () => {
      const hits = findDisallowedParamKeys(read(file));
      assert.deepEqual(
        hits,
        [],
        `${file} declares the parameter key(s) ${hits.join(', ')}, which are not on the allow-list ` +
          `[${[...ALLOWED_PARAM_KEYS].join(', ')}].\nA public listing filters by language and pages by a window. ` +
          'Anything else is a new way to narrow a public page, and it belongs in this allow-list first, with a ' +
          'reason, before it belongs in the module.',
      );
    });

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

    it(`${file}: never matches a person by the name they chose`, () => {
      const hits = findBannedTokens(read(file));
      assert.deepEqual(
        hits,
        [],
        `${file} names ${hits.join(' and ')}. The folded profile name exists to find a person by their public ` +
          'name, which is the one lookup these pages must never offer. Naming it in a comment is fine; using it ' +
          'is not.',
      );
    });

    it(`${file}: names only the profile join key and the byline column`, () => {
      const hits = findDisallowedProfileColumns(read(file));
      assert.deepEqual(
        hits,
        [],
        `${file} names the profile column(s) ${hits.join(', ')}. The module joins the profile table for ONE ` +
          'thing, a name to write beside a row. A third column is a listing that knows more about the author ' +
          'than the byline needs.',
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
    it(`${file}: reads only the URL keys a browse page needs`, () => {
      const hits = findDisallowedRouteKeys(read(file));
      assert.deepEqual(
        hits,
        [],
        `${file} ${hits.join(', ')}. The query string may carry [${[...ALLOWED_QUERY_KEYS].join(', ')}] and a ` +
          `params object may carry [${[...ALLOWED_ROUTE_KEYS].join(', ')}].\n` +
          'A public browse page is addressed by a language pair, a window and a row id. A new key belongs in this ' +
          'allow-list first, with a reason.',
      );
    });

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
