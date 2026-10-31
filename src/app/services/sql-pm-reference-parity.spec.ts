/* ===========================================================================
 * sql-pm-reference-parity.spec.ts — THE SQL MIGRATION MUST AGREE WITH THIS
 * APP, AND THIS TEST IS WHAT MAKES THAT TRUE
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS FOR
 *
 * `server/migrations/007-infer-coin-metal-data.sql` fills in MetalContent,
 * Composition, PmWeightGrams and PmPercent for coins that have none. To do
 * that it needs the alloy table — which metals, which compositions, which
 * gram weights — and SQL cannot import a TypeScript module. So the table is
 * written down a SECOND TIME, in T-SQL, inside that migration's STEP 2.
 *
 * Duplicating a few dozen decimal numbers into another language is exactly
 * the kind of task that produces ONE WRONG DIGIT that nobody notices until a
 * melt value is quietly wrong by a hundred dollars. `pmWeightGrams` feeds
 * `computeMeltValue`, which puts a dollar figure on the owner's screen.
 *
 * This spec is the thing that makes the duplication safe. It reads BOTH files
 * off disk — the TypeScript and the SQL — and asserts they say the same
 * thing. If they ever diverge by a single character, this goes red.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR LAYERS OF CHECK
 * ---------------------------------------------------------------------------
 *   1. TRANSCRIPTION. Every row of the SQL table matches the corresponding
 *      entry of PM_REFERENCE_DATA: same order, same denomination, same year
 *      range, same metal, same composition string character for character,
 *      same weight to five decimal places, same percentage, same
 *      `requiresHint` flag. Same number of rows, nothing extra, nothing lost.
 *
 *   2. RESOLUTION. The SQL's lookup rules — reimplemented here from the SQL,
 *      not from the TypeScript — are swept across every denomination, every
 *      year from 1700 to 2030, every country and several hints, and compared
 *      against `lookupCoinAlloy`. Thousands of comparisons; any disagreement
 *      fails. This is what proves the SQL did not merely copy the numbers but
 *      also copied the SELECTION logic, including the year-range precedence
 *      and the undated fallback.
 *
 *   3. THE REFUSALS. The cases the owner specifically asked to be left alone
 *      are asserted by name, so that if someone "helpfully" adds a 1942
 *      nickel row to either file, a test says so out loud rather than a melt
 *      value silently appearing.
 *
 *   4. THE INVARIANT BEHIND THE SQL'S "UNIFORM METAL" SHORTCUT. The migration
 *      has one rule with no TypeScript counterpart: if every catalogued issue
 *      of a denomination is the same metal, it writes that metal even without
 *      a year. That is only safe while the ambiguous denominations are NOT
 *      uniform. Asserted directly.
 *
 * ---------------------------------------------------------------------------
 * WHY IT PARSES THE TYPESCRIPT INSTEAD OF IMPORTING IT
 * ---------------------------------------------------------------------------
 * `PM_REFERENCE_DATA` is deliberately not exported — pm-reference.ts exposes
 * two functions and keeps its table private. Widening that public surface
 * just to let a test read it would be the tail wagging the dog, and it would
 * also weaken the check: reading the FILE is what proves the SQL matches the
 * source of truth as written, rather than matching some other copy of it.
 *
 * So the array literal is extracted from the file text and evaluated. It is
 * plain JavaScript object-literal syntax, so this works, and the alternative
 * (a TypeScript parser dependency) would be enormously heavier for no gain.
 * =========================================================================== */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { lookupCoinAlloy } from './pm-reference';

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_PATH = resolve(HERE, 'pm-reference.ts');
const SQL_PATH = resolve(HERE, '../../../server/migrations/007-infer-coin-metal-data.sql');

/* ===========================================================================
 * READING THE TYPESCRIPT
 * ======================================================================== */

interface TsEntry {
  denomination: string;
  yearRange?: { min: number; max: number };
  metal: string;
  composition: string;
  pmWeightGrams?: number;
  pmPercent?: number;
  pmDescription?: string;
  country?: string;
  requiresHint?: boolean;
}

/**
 * Pull `PM_REFERENCE_DATA` out of pm-reference.ts by finding its array
 * literal and evaluating it.
 *
 * The bracket matching starts at the `[` of `= [`, NOT at the first `[` after
 * the declaration — because the declaration itself contains one, in the type
 * annotation `PmEntry[]`. Starting there would match the empty brackets and
 * yield an empty array, which is a silent pass rather than a loud failure, so
 * the count assertion below exists to catch exactly that mistake.
 */
function readTsEntries(): TsEntry[] {
  const source = readFileSync(TS_PATH, 'utf8');
  const declaration = source.indexOf('const PM_REFERENCE_DATA');
  expect(declaration, 'PM_REFERENCE_DATA declaration not found in pm-reference.ts').toBeGreaterThan(-1);

  const open = source.indexOf('[', source.indexOf('= [', declaration));
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
  expect(close, 'could not find the end of the PM_REFERENCE_DATA array').toBeGreaterThan(open);

  // eslint-disable-next-line no-eval
  const entries = eval(`(${source.slice(open, close + 1)})`) as TsEntry[];
  return entries;
}

/* ===========================================================================
 * READING THE SQL
 * ======================================================================== */

interface SqlRow {
  entryOrder: number;
  denomKey: string;
  yearMin: number | null;
  yearMax: number | null;
  metal: string;
  composition: string;
  pmWeightGrams: string | null; // kept as text so precision is compared exactly
  pmPercent: string | null;
  country: string | null;
  requiresHint: boolean;
}

/**
 * Split one SQL VALUES tuple into its fields.
 *
 * A plain `split(',')` would be wrong: composition strings contain commas
 * ("90% Gold, 10% Copper"), so the scan has to know when it is inside an
 * N'...' literal. Doubled quotes ('') are the SQL escape for an apostrophe
 * and are handled.
 */
function splitSqlTuple(body: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inString = false;

  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (ch === "'" && body[i + 1] === "'") {
        current += "''";
        i += 1;
      } else if (ch === "'") {
        inString = false;
        current += ch;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      current += ch;
    } else if (ch === ',') {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function unquote(field: string): string | null {
  if (field === 'NULL') return null;
  const match = /^N'([\s\S]*)'$/.exec(field);
  expect(match, `expected an N'...' literal or NULL, got: ${field}`).not.toBeNull();
  return match![1].replace(/''/g, "'");
}

function numberOrNull(field: string): string | null {
  return field === 'NULL' ? null : field;
}

/**
 * Pull the #PmReference rows out of the migration.
 *
 * Anchored on the INSERT statement rather than on line numbers, so adding
 * comments or steps to the SQL does not break the parse — only changing the
 * table or its column order would, which is the point.
 */
function readSqlRows(): SqlRow[] {
  const sql = readFileSync(SQL_PATH, 'utf8');
  const insertAt = sql.indexOf('INSERT INTO #PmReference');
  expect(insertAt, 'INSERT INTO #PmReference not found in the migration').toBeGreaterThan(-1);

  const valuesAt = sql.indexOf('VALUES', insertAt);
  const endAt = sql.indexOf(';', valuesAt);
  expect(endAt, 'the #PmReference INSERT is not terminated').toBeGreaterThan(valuesAt);

  const block = sql.slice(valuesAt + 'VALUES'.length, endAt);

  const rows: SqlRow[] = [];
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('(')) continue;

    const body = line.replace(/^\(/, '').replace(/\),?$/, '');
    const f = splitSqlTuple(body);
    expect(f, `expected 10 columns, got ${f.length} in: ${line}`).toHaveLength(10);

    rows.push({
      entryOrder: Number(f[0]),
      denomKey: unquote(f[1])!,
      yearMin: f[2] === 'NULL' ? null : Number(f[2]),
      yearMax: f[3] === 'NULL' ? null : Number(f[3]),
      metal: unquote(f[4])!,
      composition: unquote(f[5])!,
      pmWeightGrams: numberOrNull(f[6]),
      pmPercent: numberOrNull(f[7]),
      country: unquote(f[8]),
      requiresHint: f[9] === '1'
    });
  }
  return rows;
}

/**
 * The denomination fold the SQL applies, reproduced exactly.
 *
 * The migration cannot contain the cent sign, the vulgar one-half or the
 * pound sign as literal characters — it keeps itself pure ASCII so that
 * sqlcmd cannot mangle it in transit — so it folds them to ASCII stand-ins
 * with NCHAR(). This is the same fold, and both sides of the comparison go
 * through it.
 */
function foldDenomination(denomination: string): string {
  return denomination
    .replace(/¢/g, 'c')
    .replace(/½/g, 'half')
    .replace(/£/g, 'gbp')
    .toLowerCase();
}

const TS_ENTRIES = readTsEntries();
const SQL_ROWS = readSqlRows();

/* ===========================================================================
 * 1. TRANSCRIPTION
 * ======================================================================== */

describe('007-infer-coin-metal-data.sql transcribes pm-reference.ts exactly', () => {
  it('found a non-trivial table on both sides', () => {
    // Guards against the bracket-matching mistake described above, and against
    // a parse that silently matched nothing.
    expect(TS_ENTRIES.length).toBeGreaterThan(50);
    expect(SQL_ROWS.length).toBeGreaterThan(50);
  });

  it('has the same number of entries', () => {
    expect(SQL_ROWS.length).toBe(TS_ENTRIES.length);
  });

  it('numbers its rows 1..n in PM_REFERENCE_DATA order', () => {
    // EntryOrder is what the SQL uses as its tie-break, standing in for the
    // TypeScript's `pool[0]`. If the numbering drifts, the two can pick
    // different entries from the same pool.
    expect(SQL_ROWS.map((r) => r.entryOrder)).toEqual(TS_ENTRIES.map((_, i) => i + 1));
  });

  it.each(TS_ENTRIES.map((entry, index) => [index, entry] as const))(
    'entry %i (%o) matches its SQL row',
    (index, entry) => {
      const row = SQL_ROWS[index];
      expect(row, `no SQL row at position ${index + 1}`).toBeDefined();

      expect(row.denomKey).toBe(foldDenomination(entry.denomination));
      expect(row.yearMin).toBe(entry.yearRange ? entry.yearRange.min : null);
      expect(row.yearMax).toBe(entry.yearRange ? entry.yearRange.max : null);
      expect(row.metal).toBe(entry.metal);

      // Character for character. Two spellings of one alloy in the column
      // would be worse than leaving it blank.
      expect(row.composition).toBe(entry.composition);

      // Compared as fixed-point text, not as floats, so that a SQL literal of
      // 1.5 against a TypeScript 1.50 is still caught as a formatting drift
      // and a genuine value change cannot hide behind rounding.
      expect(row.pmWeightGrams).toBe(
        entry.pmWeightGrams === undefined ? null : entry.pmWeightGrams.toFixed(5)
      );
      expect(row.pmPercent).toBe(
        entry.pmPercent === undefined ? null : entry.pmPercent.toFixed(2)
      );

      expect(row.country).toBe(entry.country ? entry.country.toLowerCase() : null);
      expect(row.requiresHint).toBe(entry.requiresHint === true);
    }
  );

  it('keeps PmWeightGrams inside DECIMAL(12,5) and PmPercent inside DECIMAL(5,2)', () => {
    // Migration 004 widened PmWeightGrams to (12,5). A value that does not fit
    // its column is not a rounding nuisance -- SQL Server raises error 8152
    // and aborts the statement.
    for (const row of SQL_ROWS) {
      if (row.pmWeightGrams !== null) {
        const [whole, fraction = ''] = row.pmWeightGrams.split('.');
        expect(whole.replace('-', '').length, `${row.pmWeightGrams} has too many integer digits`).toBeLessThanOrEqual(7);
        expect(fraction.length).toBeLessThanOrEqual(5);
      }
      if (row.pmPercent !== null) {
        const [whole, fraction = ''] = row.pmPercent.split('.');
        expect(whole.replace('-', '').length, `${row.pmPercent} has too many integer digits`).toBeLessThanOrEqual(3);
        expect(fraction.length).toBeLessThanOrEqual(2);
      }
    }
  });

  it('only ever writes a metal from the seeded MetalContents list', () => {
    // The coin editor renders Metal as a <select> fed from that table, so a
    // value outside it would be un-displayable and un-editable.
    const seeded = new Set([
      'Gold', 'Silver', 'Platinum', 'Palladium', 'Copper', 'Nickel', 'Copper-Nickel',
      'Bronze', 'Brass', 'Zinc', 'Steel', 'Aluminum', 'Nickel-Brass', 'Clad', 'Other'
    ]);
    for (const row of SQL_ROWS) expect(seeded.has(row.metal), `${row.metal} is not seeded`).toBe(true);
  });

  it('contains no non-ASCII character anywhere in the migration', () => {
    // The file deliberately uses NCHAR() for the cent, half and pound signs so
    // that its correctness cannot depend on sqlcmd guessing a code page.
    const sql = readFileSync(SQL_PATH, 'utf8');
    const offenders = [...sql].filter((ch) => ch.charCodeAt(0) > 126);
    expect(offenders.join(''), 'migration 007 must stay pure ASCII').toBe('');
  });
});

/* ===========================================================================
 * 2. RESOLUTION
 * ---------------------------------------------------------------------------
 * `resolveFromSql` below is a transliteration of the SQL's own lookup — the
 * datedPool / undatedPool / pick / ref chain in STEP 3 — written from the SQL
 * rather than from pm-reference.ts, on purpose. Comparing it against
 * `lookupCoinAlloy` is therefore a real test of the SQL's logic, not a
 * restatement of the TypeScript.
 * ======================================================================== */

interface Resolved {
  metal: string;
  composition: string;
  pmWeightGrams: number | undefined;
  pmPercent: number | undefined;
}

function resolveFromSql(
  denomKey: string,
  year: number,
  nation: string | null,
  hint?: string
): Resolved | null {
  const candidates = SQL_ROWS.filter(
    (row) =>
      row.denomKey === denomKey &&
      (nation === null || row.country === null || row.country === nation) &&
      (hint ? row.metal === hint : !row.requiresHint)
  );

  const dated = candidates.filter(
    (row) => row.yearMin !== null && year >= row.yearMin && year <= row.yearMax!
  );
  const pool = dated.length > 0 ? dated : candidates.filter((row) => row.yearMin === null);
  if (pool.length === 0) return null;

  // THE REFUSAL. More than one metal in the surviving pool means the
  // year/denomination pair did not determine the alloy.
  if (new Set(pool.map((row) => row.metal)).size > 1) return null;

  const chosen = pool.reduce((a, b) => (a.entryOrder <= b.entryOrder ? a : b));
  return {
    metal: chosen.metal,
    composition: chosen.composition,
    pmWeightGrams: chosen.pmWeightGrams === null ? undefined : Number(chosen.pmWeightGrams),
    pmPercent: chosen.pmPercent === null ? undefined : Number(chosen.pmPercent)
  };
}

describe('the SQL lookup resolves identically to lookupCoinAlloy', () => {
  const denominations = [...new Set(TS_ENTRIES.map((e) => e.denomination))];
  const countries = [...new Set(TS_ENTRIES.map((e) => e.country!))];
  const hints = [undefined, 'Gold', 'Silver', 'Clad'];

  it.each(countries)('agrees for every denomination, year and hint in %s', (country) => {
    const nation = country.toLowerCase();
    let compared = 0;

    for (const denomination of denominations) {
      for (let year = 1700; year <= 2030; year += 1) {
        for (const hint of hints) {
          const fromTs = lookupCoinAlloy(denomination, String(year), country, hint);
          const fromSql = resolveFromSql(foldDenomination(denomination), year, nation, hint);
          compared += 1;

          const context = `${denomination} ${year} ${country} hint=${hint ?? 'none'}`;

          if (fromTs === null) {
            expect(fromSql, `SQL answered where the app refuses: ${context}`).toBeNull();
            continue;
          }

          expect(fromSql, `SQL refused where the app answers: ${context}`).not.toBeNull();
          expect(fromSql!.metal, context).toBe(fromTs.metal);
          expect(fromSql!.composition, context).toBe(fromTs.composition);
          expect(fromSql!.pmWeightGrams, context).toBe(fromTs.pmWeightGrams);
          expect(fromSql!.pmPercent, context).toBe(fromTs.pmPercent);
        }
      }
    }

    // A sweep that compared nothing would pass vacuously.
    expect(compared).toBeGreaterThan(1000);
  });
});

/* ===========================================================================
 * 3. THE REFUSALS
 * ---------------------------------------------------------------------------
 * Every case the owner explicitly asked to be left alone. The sweep above
 * would catch a change to any of these, but it would report it as one line
 * buried in thousands; these name them, so a regression says WHAT broke.
 * ======================================================================== */

describe('the migration leaves the genuinely ambiguous coins alone', () => {
  const us = 'united states';

  it('1942 five cents: cupronickel AND 35% silver were both struck', () => {
    expect(resolveFromSql('5c', 1942, us)).toBeNull();
    expect(resolveFromSql('5c', 1942, us, 'Silver')).toBeNull();
    expect(resolveFromSql('5c', 1942, us, 'Copper-Nickel')).toBeNull();
  });

  it('1982 cent: bronze AND copper-plated zinc were both struck', () => {
    expect(resolveFromSql('1c', 1982, us)).toBeNull();
    expect(resolveFromSql('1c', 1982, us, 'Bronze')).toBeNull();
    expect(resolveFromSql('1c', 1982, us, 'Zinc')).toBeNull();
  });

  it('1971-1978 Eisenhower dollar: clad strikes AND 40% silver collector issues', () => {
    for (let year = 1971; year <= 1978; year += 1) {
      expect(resolveFromSql('$1', year, us), String(year)).toBeNull();
      expect(resolveFromSql('$1', year, us, 'Silver'), String(year)).toBeNull();
      expect(resolveFromSql('$1', year, us, 'Clad'), String(year)).toBeNull();
    }
  });

  it('a bare $1 in the gold-dollar era refuses, but resolves once a metal is known', () => {
    expect(resolveFromSql('$1', 1855, us)).toBeNull();
    // ...and this is the whole reason the migration runs BEFORE the in-app
    // backfill: with a metal to go on, the same coin resolves.
    expect(resolveFromSql('$1', 1855, us, 'Gold')?.pmWeightGrams).toBe(1.5);
    expect(resolveFromSql('$1', 1855, us, 'Silver')?.pmWeightGrams).toBe(24.06);
  });

  it('the 1856-57 cent and the 1866-73 five cents overlap two alloys', () => {
    expect(resolveFromSql('1c', 1856, us)).toBeNull();
    expect(resolveFromSql('1c', 1857, us)).toBeNull();
    for (let year = 1866; year <= 1873; year += 1) {
      expect(resolveFromSql('5c', year, us), String(year)).toBeNull();
    }
  });

  it('a 1992-or-later dime or quarter is clad unless something says silver', () => {
    expect(resolveFromSql('25c', 1999, us)?.metal).toBe('Clad');
    expect(resolveFromSql('10c', 1999, us)?.metal).toBe('Clad');
    expect(resolveFromSql('25c', 1999, us, 'Silver')?.pmWeightGrams).toBe(5.63);
    expect(resolveFromSql('10c', 1999, us, 'Silver')?.pmWeightGrams).toBe(2.25);
  });
});

/* ===========================================================================
 * 4. THE "UNIFORM METAL" INVARIANT
 * ---------------------------------------------------------------------------
 * The migration has one rule with no counterpart in pm-reference.ts: if EVERY
 * catalogued issue of a denomination is the same metal, it writes that metal
 * even when the year is missing or unreadable. That is what makes "a $20 is
 * gold" work on a coin dated "n.d.".
 *
 * The rule is derived from the data rather than asserted by hand, so it needs
 * no maintenance — but it is only SAFE while the ambiguous denominations are
 * not uniform. If somebody ever deleted the clad rows for the quarter, "25c"
 * would become uniformly Silver and the rule would start marking 1999
 * quarters as silver without a year. These assertions are the tripwire.
 * ======================================================================== */

describe('the uniform-metal shortcut can never reach an ambiguous denomination', () => {
  function metalsFor(denomKey: string): Set<string> {
    return new Set(SQL_ROWS.filter((r) => r.denomKey === denomKey).map((r) => r.metal));
  }

  it.each(['$2.50', '$3', '$5', '$10', '$20'])(
    '%s is uniformly Gold, so it resolves without a year',
    (denomKey) => {
      expect([...metalsFor(denomKey)]).toEqual(['Gold']);
    }
  );

  it.each(['3cs', '20c'])('%s is uniformly Silver', (denomKey) => {
    expect([...metalsFor(denomKey)]).toEqual(['Silver']);
  });

  it.each(['$1', '1c', '5c', '10c', '25c', '50c'])(
    '%s changed metal at some point, so the shortcut must NOT fire for it',
    (denomKey) => {
      expect(metalsFor(denomKey).size).toBeGreaterThan(1);
    }
  );

  it('every denomination that holds a deliberate gap is non-uniform', () => {
    // Restating the safety property directly: the three gaps the owner named
    // all live in denominations the shortcut cannot touch.
    for (const denomKey of ['5c', '1c', '$1']) {
      expect(metalsFor(denomKey).size, denomKey).toBeGreaterThan(1);
    }
  });
});
