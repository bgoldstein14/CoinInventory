 /*
 * sql-denomination-resolution-parity.spec.ts
 * MIGRATION 014 MUST AGREE WITH THIS APP, AND THIS TEST IS WHAT MAKES THAT
 * TRUE
 *
 * WHAT THIS FILE IS FOR
 *
 * `server/migrations/014-resolve-coin-denominations.sql` fills in
 * `Coins.DenominationId` for every coin it can. To do that it has to answer
 * the same question `denomination-resolution.ts` answers — which lookup row
 * is this stored string naming? — and SQL cannot import a TypeScript module.
 * So the alias table and the folding rules are written down a SECOND TIME,
 * in T-SQL, inside that migration.
 *
 * This is the same situation, and the same answer, as
 * `sql-pm-reference-parity.spec.ts`: the duplication is unavoidable and the
 * spec is what makes it safe. Both files are read off disk and compared.
 *
 * THE FOUR LAYERS OF CHECK
 *
 *   1. TRANSCRIPTION. Every row of the SQL's #Alias table matches an entry
 *      of DENOMINATION_ALIASES exactly — same spelling, same key, same
 *      count, nothing extra and nothing missing. The design says "do not
 *      write a second alias table"; this is what stops the T-SQL copy
 *      BECOMING one.
 *
 *   2. FOLDING. The SQL's fold is re-implemented here FROM THE SQL — not
 *      from the TypeScript — and swept across every label in the real
 *      authored seed plus every spelling this collection is known to hold.
 *      Any disagreement with `denominationKey` fails.
 *
 *   3. RESOLUTION. The SQL's country-first-then-any-issuer rule, likewise
 *      re-implemented from the SQL, is swept across the real seed and
 *      compared with `resolveDenomination`. The property asserted is
 *      ONE-SIDED on purpose and is stated in full below.
 *
 *   4. THE PROMISE. `Coins.Denomination` is never written, the UPDATE only
 *      ever fills an id that is currently NULL, and the file is pure ASCII.
 *
 * THE ONE-SIDED PROPERTY, AND WHY IT IS NOT A WEAKER TEST
 *
 * The TypeScript compares countries through `isSameCountry`, which knows
 * that 'GB' and 'Great Britain' are the same place and carries seventy-odd
 * spelling patterns. T-SQL has none of that, so the migration compares the
 * coin's country against the issuer's Name and IsoCode and nothing else.
 *
 * The TypeScript is therefore written so that an EXACT name or code match,
 * when there is one, is the whole answer — which makes the migration's
 * narrower rule a special case of it rather than a different rule. Where the
 * migration finds no exact match it widens to every issuer exactly as the
 * TypeScript does; where the TypeScript's patterns would have found an
 * issuer the migration cannot, the migration leaves the id NULL.
 *
 * So the property is: **the migration never sets an id the application
 * would not have set.** It may set fewer. Null is the recoverable direction
 * — the coin reads `Other (8 Reales)`, the value appears in the migration's
 * report, and a human decides. A WRONG id is invisible and permanent.
  */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { denominationKey } from '../../components/coin-editor-form/denomination-aliases';
import {
  resolveDenomination,
  type ResolverDenomination,
  type ResolverIssuer,
} from './denomination-resolution';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_PATH = resolve(HERE, '../../../../server/migrations/014-resolve-coin-denominations.sql');
const ALIASES_PATH = resolve(HERE, '../../components/coin-editor-form/denomination-aliases.ts');
const SEED_PATH = resolve(HERE, '../../../../server/migrations/seed-data/issuers-denominations.json');

const sql = readFileSync(SQL_PATH, 'utf8');

/** The file split on its batch separators. */
const batches = sql.split(/^\s*GO\s*$/m);

/** A batch with its `--` comments and its string literals removed. */
function executableSql(text: string): string {
  return text.replace(/--[^\n]*/g, '').replace(/'(?:[^']|'')*'/g, "''");
}

 /*
 * READING THE TWO ALIAS TABLES
  */

/**
 * The SQL's `#Alias` rows, read out of the INSERT.
 *
 * Deliberately parsed rather than retyped: a third copy of the table in this
 * spec would be a third thing to keep in step, and it could agree with
 * neither of the other two.
 */
function readSqlAliases(): Map<string, string> {
  const start = sql.indexOf('INSERT INTO #Alias');
  expect(start, 'the #Alias INSERT was not found in 014').toBeGreaterThan(-1);
  const block = sql.slice(start, sql.indexOf(';', start));

  const aliases = new Map<string, string>();
  // The columns in the SQL are padded for readability, so whitespace is
  // allowed on BOTH sides of the comma. Requiring the comma to follow the
  // closing quote directly matched only the longest rows, and a partial
  // parse makes the comparison below pass for the wrong reason.
  for (const row of block.matchAll(/\(N'((?:[^']|'')*)'\s*,\s*N'((?:[^']|'')*)'\)/g)) {
    aliases.set(row[1].replace(/''/g, "'"), row[2].replace(/''/g, "'"));
  }
  return aliases;
}

/**
 * `DENOMINATION_ALIASES` pulled out of denomination-aliases.ts.
 *
 * The map is a plain array-of-pairs literal, so finding its brackets and
 * evaluating it is exact and needs no TypeScript parser — the same technique
 * sql-pm-reference-parity.spec.ts uses on PM_REFERENCE_DATA.
 */
function readTsAliases(): Map<string, string> {
  const source = readFileSync(ALIASES_PATH, 'utf8');
  const declaration = source.indexOf('const DENOMINATION_ALIASES');
  expect(declaration, 'DENOMINATION_ALIASES not found').toBeGreaterThan(-1);

  const open = source.indexOf('[', source.indexOf('new Map(', declaration));
  let depth = 0;
  let close = -1;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '[') depth += 1;
    else if (source[i] === ']') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  expect(close, 'could not bracket-match the alias array').toBeGreaterThan(open);

  // eslint-disable-next-line no-new-func
  const pairs = new Function(`return ${source.slice(open, close + 1)};`)() as [string, string][];
  return new Map(pairs);
}

const sqlAliases = readSqlAliases();
const tsAliases = readTsAliases();

describe('1. the alias table is transcribed, not re-invented', () => {
  it('read both tables, so the comparison below is not vacuous', () => {
    expect(tsAliases.size).toBeGreaterThan(30);
    expect(sqlAliases.size).toBeGreaterThan(30);
  });

  it('has exactly the same entries on both sides', () => {
    // A row the SQL has and the TypeScript does not is a SECOND alias table
    // — the one thing design §5 says not to build. A row the TypeScript has
    // and the SQL does not is a coin the migration silently fails to
    // resolve while the editor resolves it, so the same coin reads two ways
    // depending on which code path looked at it.
    expect(Object.fromEntries([...sqlAliases].sort())).toEqual(
      Object.fromEntries([...tsAliases].sort())
    );
  });

  it('still refuses the spellings the TypeScript refuses', () => {
    // 'trade dollar' IS in migration 007's alias CASE, because 007 is
    // working out an ALLOY and a Trade Dollar is 90% silver like any other
    // dollar. This migration is working out a DENOMINATION, where the Trade
    // Dollar is a distinct issue. Copying 007 wholesale is the obvious
    // mistake and this is the tripwire on it.
    for (const refused of ['trade dollar', 'penny', 'eagle']) {
      expect(sqlAliases.has(refused), refused).toBe(false);
    }
  });
});

/* ===========================================================================
 * 2. THE FOLD, RE-IMPLEMENTED FROM THE SQL
 * ======================================================================== */

/**
 * `foldSymbols`, as migration 014's T-SQL expression computes it.
 *
 * Transcribed from the SQL, NOT from denomination-aliases.ts — which is the
 * whole point. The SQL reads:
 *
 *   - NCHAR(9), NCHAR(10), NCHAR(13) and NCHAR(160) replaced with a space
 *   - NCHAR(162) -> 'c', NCHAR(189) -> 'half', NCHAR(163) -> 'gbp'
 *   - LOWER()
 *   - runs of spaces collapsed with the NCHAR(1)/NCHAR(2) marker trick
 *   - LTRIM(RTRIM())
 */
function sqlFold(text: string): string {
  const spaced = text
    .replace(/\t/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/\r/g, ' ')
    .replace(/ /g, ' ');
  const folded = spaced
    .replace(/¢/g, 'c')
    .replace(/½/g, 'half')
    .replace(/£/g, 'gbp')
    .toLowerCase();
  // The marker trick: ' ' -> \x01\x02, then \x02\x01 -> '', then \x01\x02 -> ' '.
  const collapsed = folded
    .split(' ')
    .join('\u0001\u0002')
    .split('\u0002\u0001')
    .join('')
    .split('\u0001\u0002')
    .join(' ');
  return collapsed.trim();
}

/** `readSpelledFaceValue`, as the migration's CASE expressions compute it. */
function sqlSpelledFaceValue(flat: string): string | null {
  const numeric = (candidate: string): boolean =>
    /^[0-9]/.test(candidate) &&
    !/[^0-9.]/.test(candidate) &&
    !/\..*\./.test(candidate) &&
    !/\.$/.test(candidate);

  for (const [suffix, format] of [
    ['cents', (n: string) => `${n}c`],
    ['cent', (n: string) => `${n}c`],
    ['dollars', (n: string) => `$${n}`],
    ['dollar', (n: string) => `$${n}`],
  ] as [string, (n: string) => string][]) {
    if (flat.endsWith(suffix)) {
      const head = flat.slice(0, flat.length - suffix.length).trim();
      return numeric(head) ? format(head) : null;
    }
  }
  return null;
}

/**
 * `denominationKey`, as the migration computes it.
 *
 * Memoised because the sweep below calls it across the whole seed for every
 * (spelling, country) pair; without it the comparison is quadratic and
 * times out, and a test that has to be skipped for being slow is a test
 * nobody runs.
 */
const keyCache = new Map<string, string>();
function sqlDenominationKey(text: string): string {
  const cached = keyCache.get(text);
  if (cached !== undefined) return cached;

  const flat = sqlFold(String(text ?? ''));
  const key = flat ? sqlAliases.get(flat) ?? sqlSpelledFaceValue(flat) ?? flat : '';
  keyCache.set(text, key);
  return key;
}

/** Every label in the authored seed, plus the spellings this app produces. */
const seed = JSON.parse(readFileSync(SEED_PATH, 'utf8')) as {
  issuers: { key: string; name: string; isoCode: string | null }[];
  denominations: { issuer: string; label: string }[];
};

const EXTRA_SPELLINGS = [
  '', '   ', '\t', 'Dime', 'DIME', 'dime', 'Quarter', 'Quarter Dollar',
  'Half Dollar', 'Half   Dollar', 'half dollar', 'Dollar', 'One Dollar',
  'Silver Dollar', 'Trade Dollar', 'Pillar Dollar', '50 Cents', '50cents',
  '50 Cent', '2.50 Dollars', '20 Dollars', '3 cents', '3cs', '3CS',
  'Three Cent Silver', 'Trime', 'Three Cent Nickel', 'Nickel', 'Half Dime',
  '5s', '1s', '1 Crown', 'Crown', 'Half Crown', 'Halfcrown', 'Florin',
  'Shilling', 'Sovereign', 'Half Sovereign', '½ Sovereign', 'Guinea',
  '8 Reales', '100 Soles', 'Penny', 'Eagle', 'Gold Eagle', 'Denarius',
  '½¢', '1¢', '50¢', '£5', '£1', '1/-',
  '2/- (Florin)', '2/6 (Half Crown)', '5/- (Crown)', '25p (Crown)',
  'Louis d’or', "Louis d'or", '  8 Reales  ', '8  REALES',
];

const ALL_SPELLINGS = [
  ...new Set([
    ...seed.denominations.map((denomination) => denomination.label),
    ...EXTRA_SPELLINGS,
    ...sqlAliases.keys(),
    ...sqlAliases.values(),
  ]),
];

describe('2. the SQL folds exactly as denominationKey does', () => {
  it('has a corpus worth sweeping', () => {
    expect(ALL_SPELLINGS.length).toBeGreaterThan(700);
  });

  it('agrees on every spelling in the authored seed and in this collection', () => {
    const disagreements: string[] = [];
    for (const spelling of ALL_SPELLINGS) {
      const fromSql = sqlDenominationKey(spelling);
      const fromTs = denominationKey(spelling);
      if (fromSql !== fromTs) {
        disagreements.push(`'${spelling}': SQL '${fromSql}' vs app '${fromTs}'`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('agrees on the spelled-out face values, which are a RULE and not a row', () => {
    // These are the ones a transcription gets wrong: the TypeScript reads
    // them with a regex, the SQL with LIKE and a numeric check, and the two
    // have to agree about '3 cents' (which matches nothing, correctly,
    // because the three-cent silver and the three-cent nickel are both real
    // and a bare "3 cent" does not say which).
    for (const spelling of ['50 Cents', '50cents', '1 Cent', '2.50 Dollars', '20 dollars', '3 cents', '.5 cents', '5. cents', '1.2.3 cents', 'cents', 'half dollars']) {
      expect(sqlDenominationKey(spelling), spelling).toBe(denominationKey(spelling));
    }
  });
});

/* ===========================================================================
 * 3. RESOLUTION, RE-IMPLEMENTED FROM THE SQL
 * ======================================================================== */

/** The seed as the resolver sees it, with ids assigned the way IDENTITY will. */
const issuers: ResolverIssuer[] = seed.issuers.map((issuer, index) => ({
  issuerId: index + 1,
  name: issuer.name,
  isoCode: issuer.isoCode,
}));
const issuerIdByKey = new Map(seed.issuers.map((issuer, index) => [issuer.key, index + 1]));
const denominations: ResolverDenomination[] = seed.denominations.map((denomination, index) => ({
  denominationId: index + 1,
  issuerId: issuerIdByKey.get(denomination.issuer) ?? null,
  label: denomination.label,
}));

/**
 * The migration's resolution, transcribed.
 *
 * `MatchCount`, `InCountryCount` and the CASE that reads them, in JavaScript.
 * The country test is the SQL's: `i.Name = t.CountryText OR i.IsoCode =
 * t.CountryText`, compared case-insensitively because SQL Server's default
 * collation is.
 */
const byKey = new Map<string, ResolverDenomination[]>();
for (const row of denominations) {
  const key = sqlDenominationKey(row.label);
  const bucket = byKey.get(key);
  if (bucket) bucket.push(row);
  else byKey.set(key, [row]);
}

function sqlResolve(text: string, country: string): number | null {
  const key = sqlDenominationKey(text);
  if (!key) return null;

  const matches = byKey.get(key) ?? [];
  if (matches.length === 0) return null;

  const folded = country.trim().toLowerCase();
  const inCountry = matches.filter((row) => {
    const issuer = issuers.find((candidate) => candidate.issuerId === row.issuerId);
    if (!issuer) return false;
    return (
      issuer.name.toLowerCase() === folded ||
      (issuer.isoCode ?? '').toLowerCase() === folded && folded.length > 0
    );
  });

  if (inCountry.length === 1) return inCountry[0].denominationId;
  if (inCountry.length > 1) return null;
  return matches.length === 1 ? matches[0].denominationId : null;
}

/** Countries the sweep uses: every issuer spelling, plus what coins hold. */
const COUNTRIES = [
  ...new Set([
    '',
    'United States',
    'US',
    'Great Britain',
    'GB',
    'Mexico',
    'MX',
    'Canada',
    'Australia',
    'Peru',
    'Roman Empire',
    'england',
    'U.S.A.',
    ...seed.issuers.map((issuer) => issuer.name),
  ]),
];

/** A representative slice of spellings; the full cross product is 80,000. */
const SWEEP_SPELLINGS = [
  ...EXTRA_SPELLINGS,
  ...seed.denominations.filter((_denomination, index) => index % 23 === 0).map((d) => d.label),
];

describe('3. the migration never sets an id the application would not', () => {
  it('has a sweep worth running', () => {
    expect(SWEEP_SPELLINGS.length * COUNTRIES.length).toBeGreaterThan(3000);
  });

  it('agrees with resolveDenomination, or answers null', () => {
    const violations: string[] = [];
    let compared = 0;
    for (const spelling of SWEEP_SPELLINGS) {
      for (const country of COUNTRIES) {
        const fromSql = sqlResolve(spelling, country);
        if (fromSql === null) continue;
        compared += 1;
        const fromApp = resolveDenomination(spelling, country, denominations, issuers).denominationId;
        if (fromSql !== fromApp) {
          violations.push(`'${spelling}' / '${country}': SQL ${fromSql}, app ${fromApp}`);
        }
      }
    }
    // Non-vacuity: the loop SKIPS every pair the migration leaves null, so
    // a change that made the SQL resolve nothing at all would pass with
    // zero comparisons. Most of the sweep must actually reach the compare.
    expect(compared).toBeGreaterThan(500);
    expect(violations.slice(0, 20)).toEqual([]);
  });

  it('does NOT guess at 8 Reales, because six issuers struck one', () => {
    /* THE HEADLINE CASE OF THE DESIGN, AND THE ANSWER IS NOT THE OBVIOUS
     * ONE. WORTH READING BEFORE ANYBODY "FIXES" IT.
     *
     * Design §5 offers the 8 Reales as the reason the search must widen
     * beyond the coin's country: Mexican pieces are all stored
     * as 'United States' because the QIF parser never set a country, so a
     * country-scoped-only match would resolve nothing.
     *
     * The widening is implemented and it is right. But the authored seed
     * lists '8 Reales' under SIX issuers -- Mexico, Spain, Peru, Chile,
     * Colombia and Spanish Colonial -- because all six struck one. So
     * widening finds six candidates, not one, and rule 3 applies: the id is
     * left NULL and the value goes in the report.
     *
     * That is the correct outcome, not a shortfall. The migration cannot
     * know whether a given piece is Mexican or Spanish Colonial, and
     * those are different coins. `Other (8 Reales)` with a line in the
     * review report is honest; a guessed Mexico is a wrong issuer nothing
     * in the UI would ever reveal.
     *
     * The case the design describes is still fixed -- it is now fixed by
     * the coin's COUNTRY, which a user can set once in the editor:
     */
    const candidates = denominations.filter((row) => row.label === '8 Reales');
    expect(candidates.length, 'the seed should list 8 Reales under several issuers').toBeGreaterThan(1);

    expect(sqlResolve('8 Reales', 'United States')).toBeNull();

    const mexican = candidates.find((row) => row.issuerId === issuerIdByKey.get('mexico'));
    expect(sqlResolve('8 Reales', 'Mexico')).toBe(mexican?.denominationId);
  });

  it('refuses to guess a Sovereign, which three issuers struck', () => {
    // Great Britain, Australia and South Africa all struck sovereigns. A
    // coin that does not name one of them has no right answer.
    expect(sqlResolve('Sovereign', 'United States')).toBeNull();
    expect(sqlResolve('Sovereign', '')).toBeNull();
    expect(sqlResolve('Sovereign', 'Great Britain')).not.toBeNull();
  });

  it('resolves a term that is ambiguous in general but unique within a country', () => {
    // 'Penny' is a label under Australia, New Zealand and Ireland. Scoped
    // to one of them it is unambiguous and MUST resolve; unscoped it must
    // not. This is the capability the flat model could not have, and it is
    // the reason the country stage comes first and widening comes second.
    expect(sqlResolve('Penny', '')).toBeNull();
    const australia = denominations.find(
      (row) => row.label === 'Penny' && row.issuerId === issuerIdByKey.get('australia')
    );
    expect(australia, 'the seed has no Australian Penny').toBeTruthy();
    expect(sqlResolve('Penny', 'Australia')).toBe(australia?.denominationId);
  });
});

/* ===========================================================================
 * 4. WHAT THE MIGRATION PROMISES
 * ======================================================================== */

describe('4. the promises the whole change rests on', () => {
  it('is pure ASCII, so no code page can mangle it', () => {
    // The fold has to recognise the cent sign, the vulgar one-half and the
    // pound sign. Written literally, whether it does would depend on sqlcmd
    // reading this file in the right code page. NCHAR(n) names them by code
    // point instead. Migration 007 makes the same argument.
    expect([...sql].filter((character) => character.charCodeAt(0) > 127)).toEqual([]);
    for (const codePoint of [162, 189, 163]) {
      expect(sql).toContain(`NCHAR(${codePoint})`);
    }
  });

  it('never writes Coins.Denomination', () => {
    // Design §5, and the single rule that makes every step of this change
    // recoverable. A migration that "tidied" the text would destroy the only
    // evidence of what the source said, irreversibly, for 105 coins and
    // years of imports.
    const assigned: string[] = [];
    for (const update of executableSql(sql).matchAll(
      /\bUPDATE\b[\s\S]*?\bSET\b([\s\S]*?)(?:\bFROM\b|\bWHERE\b|\bOUTPUT\b|;)/gi
    )) {
      for (const assignment of update[1].matchAll(/([A-Za-z_][\w.]*)\s*=/g)) {
        assigned.push(assignment[1].split('.').pop() as string);
      }
    }
    expect(assigned.length, 'found no UPDATE at all — the parse must be broken').toBeGreaterThan(0);
    expect(assigned).not.toContain('Denomination');
  });

  it('writes nothing on Coins except DenominationId', () => {
    const code = executableSql(sql);
    expect(code).not.toMatch(/\bINSERT\s+INTO\s+Coins\b/i);
    expect(code).not.toMatch(/\bDELETE\s+FROM\s+Coins\b/i);
    // The one UPDATE that touches Coins, and the only column it sets.
    expect(sql).toMatch(/UPDATE c\s+SET DenominationId = t\.ResolvedId\s+FROM Coins c/);
  });

  it('only ever fills an id that is currently null', () => {
    // Re-running must not overwrite a link the user made by hand in the
    // editor, and must not thrash a link an earlier run established.
    //
    // Against EXECUTABLE sql, not the raw file. The header of step 5 quotes
    // this very clause while explaining it, so a check against the raw text
    // stayed green when the clause was deleted from the UPDATE — found by
    // deliberately deleting it.
    expect(executableSql(sql)).toMatch(/WHERE c\.DenominationId IS NULL/);
  });

  it('reports every distinct value it could not resolve, with a count', () => {
    // This report is the review artefact that is read before anything
    // else is built on top of the migration. Without it, "it resolved 83 of
    // 105" is a number with no way to act on it.
    expect(sql).toMatch(/#Unresolved/);
    expect(sql).toMatch(/coin\(s\)/);
    expect(sql).toMatch(/WHILE/);
    expect(sql).toMatch(/could not be resolved/i);
  });

  it('distinguishes "no match" from "ambiguous" in that report', () => {
    // They need different actions: one means the seed is missing something,
    // the other means the coin's country is missing something. Reporting
    // both as "unresolved" makes the list unusable.
    expect(sql).toMatch(/no denomination matches/i);
    expect(sql).toMatch(/ambiguous/i);
  });

  it('refuses to run before migration 011 has', () => {
    expect(sql).toMatch(/011-add-issuers-and-denomination-links\.sql/);
    expect(sql).toMatch(/RAISERROR/);
  });

  it('parsed into several batches, so the batching test below is not vacuous', () => {
    expect(batches.length).toBeGreaterThan(3);
  });

  it('folds the coin text and the labels with ONE expression, not two', () => {
    // Two copies of the fold is two things to keep in step inside a single
    // file, and the one that drifts is the one nobody reads. The migration
    // puts both sources in #Raw and folds once.
    const folds = executableSql(sql).match(/NCHAR\(189\)/g) ?? [];
    expect(folds).toHaveLength(1);
  });
});

/* ===========================================================================
 * 5. THE TRANSCRIPTION ABOVE IS HELD TO THE SQL
 * ---------------------------------------------------------------------------
 * EVERYTHING IN SECTIONS 2 AND 3 DEPENDS ON THESE ASSERTIONS AND WOULD BE
 * DECORATIVE WITHOUT THEM.
 *
 * `sqlFold`, `sqlSpelledFaceValue` and `sqlResolve` are JavaScript written
 * from reading the T-SQL. That is the only way to compare the two languages
 * — but it means the sweeps above test the TRANSCRIPTION, and the
 * transcription does not change when the SQL does. Three deliberate
 * mutations of 014 (dropping the 'dollars' clause from the spelled-value
 * rule, widening `MatchCount = 1` to `>= 1`, deleting the
 * `DenominationId IS NULL` guard) were made during development and all
 * THREE left the suite green. These are the tripwires that were missing.
 *
 * Every clause the transcription models is asserted here as literal text.
 * Change the SQL without changing the JavaScript above and this goes red.
 * ======================================================================== */

describe('5. every clause the transcription models is really in the SQL', () => {
  const code = executableSql(sql);

  it.each([
    ['tab to space', 'NCHAR(9),   N\' \')'],
    ['newline to space', 'NCHAR(10),  N\' \')'],
    ['carriage return to space', 'NCHAR(13),  N\' \')'],
    ['non-breaking space to space', 'NCHAR(160), N\' \')'],
    ['cent sign to c', "NCHAR(162), N'c')"],
    ['vulgar one-half to half', "NCHAR(189), N'half')"],
    ['pound sign to gbp', "NCHAR(163), N'gbp')"],
    ['lower case', 'LOWER('],
    ['space runs collapsed', "N' ', NCHAR(1) + NCHAR(2))"],
    ['the marker pairs removed', "NCHAR(2) + NCHAR(1), N'')"],
    ['the markers restored to one space', "NCHAR(1) + NCHAR(2), N' ')"],
    ['trimmed', 'LTRIM(RTRIM('],
  ])('the fold does: %s', (_what, clause) => {
    expect(sql).toContain(clause);
  });

  it.each([
    ["'cents' strips five characters", "WHEN f.Flat LIKE N'%cents'   THEN LTRIM(RTRIM(LEFT(f.Flat, LEN(f.Flat) - 5)))"],
    ["'cent' strips four", "WHEN f.Flat LIKE N'%cent'    THEN LTRIM(RTRIM(LEFT(f.Flat, LEN(f.Flat) - 4)))"],
    ["'dollars' strips seven", "WHEN f.Flat LIKE N'%dollars' THEN LTRIM(RTRIM(LEFT(f.Flat, LEN(f.Flat) - 7)))"],
    ["'dollar' strips six", "WHEN f.Flat LIKE N'%dollar'  THEN LTRIM(RTRIM(LEFT(f.Flat, LEN(f.Flat) - 6)))"],
    ['it must start with a digit', "WHEN h.Head NOT LIKE N'[0-9]%'   THEN NULL"],
    ['only digits and dots', "WHEN h.Head LIKE N'%[^0-9.]%'    THEN NULL"],
    ['at most one dot', "WHEN h.Head LIKE N'%.%.%'        THEN NULL"],
    ['not ending on a dot', "WHEN h.Head LIKE N'%.'           THEN NULL"],
    ['cents pick the c unit', "WHEN f.Flat LIKE N'%cent' OR f.Flat LIKE N'%cents'     THEN N'c'"],
    ['dollars pick the $ unit', "WHEN f.Flat LIKE N'%dollar' OR f.Flat LIKE N'%dollars' THEN N'$'"],
    ['cents become a c suffix', "WHEN h.Unit = N'c'               THEN h.Head + N'c'"],
    ['dollars become a $ prefix', "ELSE N'$' + h.Head"],
  ])('the spelled-face-value rule does: %s', (_what, clause) => {
    expect(sql).toContain(clause);
  });

  it.each([
    ['the alias table is consulted on the folded text', 'LEFT JOIN #Alias a ON a.Folded = f.Flat'],
    ['alias first, then the spelled rule, then the folded text itself', 'COALESCE(a.DenomKey, sp.Spelled, f.Flat)'],
  ])('the key is built by: %s', (_what, clause) => {
    expect(sql).toContain(clause);
  });

  it.each([
    ['exactly one row in the country scope resolves', 'WHEN s.ScopedCount = 1 THEN s.ScopedId'],
    ['none in the country and exactly one anywhere resolves', 'WHEN s.ScopedCount = 0 AND m.MatchCount = 1 THEN m.MatchId'],
    ['anything else is null', 'ELSE NULL'],
  ])('the decision does: %s', (_what, clause) => {
    expect(sql).toContain(clause);
  });

  it('counts the country scope by exact Name or IsoCode, as the transcription assumes', () => {
    // The transcription compares `issuer.name` and `issuer.isoCode` to the
    // coin's country and nothing else. If the SQL ever grew a LIKE, or
    // dropped one of the two columns, section 3's one-sided property would
    // no longer be the property being tested.
    expect(sql).toContain('(i.Name = t.CountryText OR i.IsoCode = t.CountryText)');
  });

  it('counts candidates over ACTIVE denominations only', () => {
    expect(sql).toContain('WHERE d.IsActive = 1');
  });

  it('left no clause in the SQL that the transcription does not model', () => {
    // A blunt guard on the shape of the thing: if somebody adds a fifth
    // WHEN to the spelled-value suffix list or a fourth branch to the
    // decision CASE, the counts move and this asks them to teach the
    // transcription about it.
    // Twelve: four suffix tests choosing the Head, four choosing the Unit,
    // and the four refusals.
    expect((code.match(/LIKE N''/g) ?? []).length).toBe(12);
    expect((code.match(/WHEN s\.ScopedCount/g) ?? []).length).toBe(2);
  });
});
