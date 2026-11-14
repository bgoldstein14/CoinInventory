/**
 * migrations/seed-sql.spec.ts — the seed generator, and what it refuses.
 *
 * WHY THERE IS A GENERATOR AT ALL
 * There is no redistributable machine-readable dataset of denominations by
 * country. The seed is therefore AUTHORED,
 * roughly 40 issuers and 800-1,500 denominations, and the thing that makes
 * that survivable is that the author reviews JSON rather than T-SQL:
 *
 *     { "issuer": "mexico", "label": "8 Reales", "faceValue": 8,
 *       "sortOrder": 80 }
 *
 * `key` is a stable slug joining the two arrays and it never reaches the
 * database. Nothing else in the file is machine-checkable by eye, which is
 * exactly why the generator has to be the one that checks it.
 *
 * WHAT THIS SPEC IS GUARDING
 * Every refusal below is a way a 1,500-row hand-authored file goes wrong
 * silently:
 *
 *   - a denomination naming an issuer key that does not exist. Left to a
 *     JOIN, that row simply never appears, and the author's '8 Reales' is
 *     missing from an app that reports nothing wrong;
 *
 *   - two issuers sharing a key, or two sharing a name. Issuers.Name is
 *     UNIQUE and 013 joins on it, so a duplicate makes the INSERT fail on
 *     one database and silently pick a winner on another;
 *
 *   - the same (issuer, label) twice. Two '8 Reales' rows under Mexico make
 *     every resolution of that text AMBIGUOUS, which resolves
 *     to NULL -- so a duplicate in the seed does not add a denomination, it
 *     DELETES one;
 *
 *   - an apostrophe in a label ("Louis d'or") closing the string literal and
 *     turning the rest of a 1,500-row INSERT into a syntax error, or worse,
 *     into something that parses;
 *
 *   - a '¢' or a '£' written literally into the .sql file, whose meaning
 *     then depends on sqlcmd reading the file in the right code page. 007
 *     already refuses to do that and so does this.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import { buildSeedMigrationSql, validateSeed } from './seed-sql';
import { generateSeedMigrationSql, SEED_DATA_PATH, SEED_MIGRATION_PATH } from './seed-files';

/** A minimal, valid seed in the pinned format. */
const VALID = {
  issuers: [
    {
      key: 'mexico',
      name: 'Mexico',
      isoCode: 'MX',
      kind: 'modern',
      validFrom: 1821,
      validTo: null,
      sortOrder: 100,
    },
    {
      key: 'roman-empire',
      name: 'Roman Empire',
      isoCode: null,
      kind: 'ancient',
      validFrom: -27,
      validTo: 476,
      sortOrder: 900,
    },
  ],
  denominations: [
    { issuer: 'mexico', label: '8 Reales', faceValue: 8, sortOrder: 80 },
    { issuer: 'roman-empire', label: 'Denarius', faceValue: null, sortOrder: 10 },
  ],
};

/** A deep copy, so a test that breaks the seed cannot break the next test. */
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The message of the error a call threw, or '' if it did not throw. */
function refusal(run: () => unknown): string {
  try {
    run();
    return '';
  } catch (error) {
    return (error as Error).message;
  }
}

/*
 * IT ACCEPTS THE PINNED FORMAT
  */

describe('the format pinned in the design', () => {
  it('validates the worked example from the design document', () => {
    const seed = validateSeed(clone(VALID));
    expect(seed.issuers).toHaveLength(2);
    expect(seed.denominations).toHaveLength(2);
  });

  it('accepts an issuer with no ISO code, no end date and a BC start', () => {
    // Every ancient issuer looks like this. A validator that required an ISO
    // code would exclude precisely the entries called
    // first-class, and a negative ValidFrom is how BC is written.
    const seed = validateSeed(clone(VALID));
    expect(seed.issuers[1]).toMatchObject({ isoCode: null, validFrom: -27, validTo: 476 });
  });

  it('accepts optional fields being absent rather than null', () => {
    const terse = {
      issuers: [{ key: 'mexico', name: 'Mexico', kind: 'modern', sortOrder: 1 }],
      denominations: [{ issuer: 'mexico', label: '8 Reales', sortOrder: 1 }],
    };
    const seed = validateSeed(terse);
    expect(seed.issuers[0].isoCode).toBeNull();
    expect(seed.denominations[0].faceValue).toBeNull();
  });

  it('accepts an empty seed without pretending it did something', () => {
    // The seed file is authored incrementally, so an empty or half-written
    // one must not crash the generator — it must produce a migration that
    // inserts nothing.
    const sql = buildSeedMigrationSql({ issuers: [], denominations: [] });
    expect(sql).toContain('USE CoinInventory;');
    expect(sql).toContain('0 issuer');
  });
});

/*
 * IT REFUSES, LOUDLY, AND SAYS WHICH ROW
  */

describe('a denomination naming an issuer that does not exist', () => {
  it('is refused, naming both the key and the label', () => {
    const seed = clone(VALID);
    seed.denominations[0].issuer = 'mexcio';
    const message = refusal(() => validateSeed(seed));

    expect(message).toContain('mexcio');
    expect(message).toContain('8 Reales');
  });

  it('is refused by the generator too, not only by the validator', () => {
    // The generator is what the runner calls. If only validateSeed refused,
    // a caller that skipped it would emit a migration whose JOIN silently
    // drops the row.
    const seed = clone(VALID);
    seed.denominations[0].issuer = 'nowhere';
    expect(() => buildSeedMigrationSql(seed)).toThrow(/nowhere/);
  });
});

describe('duplicates', () => {
  it('refuses two issuers with the same key', () => {
    const seed = clone(VALID);
    seed.issuers[1].key = 'mexico';
    expect(refusal(() => validateSeed(seed))).toMatch(/duplicate issuer key.*mexico/i);
  });

  it('refuses two issuers with the same name, whatever their keys', () => {
    // Issuers.Name is UNIQUE and 013 joins its denominations to issuers BY
    // NAME. Two 'Mexico' rows would make that join multiply rows.
    const seed = clone(VALID);
    seed.issuers[1].name = 'Mexico';
    expect(refusal(() => validateSeed(seed))).toMatch(/duplicate issuer name.*Mexico/i);
  });

  it('refuses two issuers whose names differ only in case', () => {
    // SQL Server's default collation is case-insensitive, so 'mexico' and
    // 'Mexico' violate UQ_Issuers_Name on the database but look distinct to
    // a case-sensitive check here. The check has to match the database.
    const seed = clone(VALID);
    seed.issuers[1].name = 'MEXICO';
    expect(refusal(() => validateSeed(seed))).toMatch(/duplicate issuer name/i);
  });

  it('refuses the same label twice under one issuer', () => {
    // This one does not merely duplicate: two '8 Reales' rows under Mexico
    // make every resolution of that text ambiguous, and ambiguous resolves
    // to NULL. A duplicated seed row DELETES a denomination.
    const seed = clone(VALID);
    seed.denominations.push({ issuer: 'mexico', label: '8 Reales', faceValue: 8, sortOrder: 81 });
    expect(refusal(() => validateSeed(seed))).toMatch(/duplicate denomination.*mexico.*8 Reales/i);
  });

  it('allows the same label under DIFFERENT issuers', () => {
    // Great Britain and Australia both struck a Crown. That is the whole
    // reason the model has issuers, and refusing it would be refusing the
    // design.
    const seed = clone(VALID);
    seed.denominations.push({ issuer: 'roman-empire', label: '8 Reales', faceValue: 8, sortOrder: 99 });
    expect(() => validateSeed(seed)).not.toThrow();
  });
});

describe('field-level refusals', () => {
  it.each([
    ['a missing issuers array', { denominations: [] }, /issuers/i],
    ['a missing denominations array', { issuers: [] }, /denominations/i],
    ['not an object at all', 'nope', /object/i],
    ['null', null, /object/i],
  ])('refuses %s', (_label, input, pattern) => {
    expect(refusal(() => validateSeed(input))).toMatch(pattern);
  });

  it('refuses a kind that is not one of the three', () => {
    const seed = clone(VALID);
    (seed.issuers[0] as { kind: string }).kind = 'medieval';
    expect(refusal(() => validateSeed(seed))).toMatch(/kind.*medieval/i);
  });

  it('refuses an ISO code that is not two letters', () => {
    const seed = clone(VALID);
    seed.issuers[0].isoCode = 'MEX';
    expect(refusal(() => validateSeed(seed))).toMatch(/isoCode/i);
  });

  it('refuses a name longer than the NVARCHAR(100) column', () => {
    // A parameter longer than its column makes SQL Server abort the whole
    // transaction with error 8152, half way through a 1,500-row insert.
    const seed = clone(VALID);
    seed.issuers[0].name = 'x'.repeat(101);
    expect(refusal(() => validateSeed(seed))).toMatch(/100/);
  });

  it('refuses a label longer than the NVARCHAR(100) column', () => {
    const seed = clone(VALID);
    seed.denominations[0].label = 'y'.repeat(101);
    expect(refusal(() => validateSeed(seed))).toMatch(/100/);
  });

  it('refuses a blank name, key or label', () => {
    for (const mutate of [
      (s: typeof VALID) => { s.issuers[0].name = '   '; },
      (s: typeof VALID) => { s.issuers[0].key = ''; },
      (s: typeof VALID) => { s.denominations[0].label = ' '; },
    ]) {
      const seed = clone(VALID);
      mutate(seed);
      expect(refusal(() => validateSeed(seed))).not.toBe('');
    }
  });

  it('refuses a non-integer sortOrder or year', () => {
    for (const mutate of [
      (s: typeof VALID) => { (s.issuers[0] as { sortOrder: unknown }).sortOrder = 'first'; },
      (s: typeof VALID) => { (s.issuers[0] as { validFrom: unknown }).validFrom = 1821.5; },
      (s: typeof VALID) => { (s.denominations[0] as { sortOrder: unknown }).sortOrder = null; },
    ]) {
      const seed = clone(VALID);
      mutate(seed);
      expect(refusal(() => validateSeed(seed))).not.toBe('');
    }
  });

  it('refuses an issuer that stopped before it started', () => {
    const seed = clone(VALID);
    seed.issuers[1].validFrom = 476;
    seed.issuers[1].validTo = -27;
    expect(refusal(() => validateSeed(seed))).toMatch(/validTo/i);
  });

  it('reports EVERY problem at once, not just the first', () => {
    // A 1,500-row file fixed one error per run is a bad afternoon.
    const seed = clone(VALID);
    seed.issuers[0].name = '';
    seed.denominations[0].issuer = 'nowhere';
    const message = refusal(() => validateSeed(seed));
    expect(message).toMatch(/nowhere/);
    expect(message.split('\n').length).toBeGreaterThan(2);
  });
});

/*
 * WHAT IT EMITS
  */

describe('the generated migration', () => {
  const sql = buildSeedMigrationSql(clone(VALID));

  it('is pure ASCII, so no code page can mangle it', () => {
    // Exactly the argument migration 007 makes: writing '¢' or '£' literally
    // into a .sql file makes the script's correctness depend on sqlcmd
    // reading it in the right code page, which is a miserable thing to
    // debug. Non-ASCII characters are emitted as NCHAR(n) instead.
    const nonAscii = [...sql].filter((character) => character.charCodeAt(0) > 127);
    expect(nonAscii).toEqual([]);
  });

  it('emits non-ASCII label characters as NCHAR code points', () => {
    const seed = clone(VALID);
    seed.denominations[0].label = '50¢';
    const generated = buildSeedMigrationSql(seed);
    expect(generated).toContain("N'50' + NCHAR(162)");
  });

  it("doubles an apostrophe rather than ending the string", () => {
    // "Louis d'or" is a real denomination and a real way to turn the rest of
    // a 1,500-row INSERT into something that parses as something else.
    const seed = clone(VALID);
    seed.denominations[0].label = "Louis d'or";
    expect(buildSeedMigrationSql(seed)).toContain("N'Louis d''or'");
  });

  it('refuses to run before migration 011 has', () => {
    // Running this first would fail with "Invalid object name 'Issuers'" in
    // the middle of a batch, which says nothing about what to do next.
    expect(sql).toMatch(/011-add-issuers-and-denomination-links\.sql/);
    expect(sql).toMatch(/RAISERROR/);
  });

  it('only ever inserts rows that are not already there', () => {
    // Safe to run twice is house style (009, 010) and it matters more here:
    // a second run that re-inserted would double every denomination in the
    // database and make every resolution ambiguous.
    expect(sql).toMatch(/WHERE NOT EXISTS \(\s*SELECT 1 FROM Issuers i WHERE i\.Name = s\.Name\s*\)/);
    expect(sql).toMatch(/WHERE NOT EXISTS \(/);
  });

  it('never writes Coins.Denomination, or anything else on Coins', () => {
    // 013 seeds lookup tables; it has no business touching a coin.
    const code = sql.replace(/--[^\n]*/g, '').replace(/'(?:[^']|'')*'/g, "''");
    expect(code).not.toMatch(/\bUPDATE\s+Coins\b/i);
    expect(code).not.toMatch(/\bINSERT\s+INTO\s+Coins\b/i);
    expect(code).not.toMatch(/\bFROM\s+Coins\b/i);
  });

  it('backfills the existing rows from their Country, but only when it is unambiguous', () => {
    // The 37 denominations already in the database have a Country and no
    // issuer. Linking them is what stops the seed inserting a SECOND '50¢'
    // under the United States -- which would make every half dollar in the
    // collection resolve as ambiguous, i.e. to nothing.
    expect(sql).toMatch(/UPDATE d\s+SET IssuerId =/);
    expect(sql).toMatch(/= 1;/);
  });

  it('puts the issuers in before the denominations that point at them', () => {
    expect(sql.indexOf('INSERT INTO Issuers')).toBeGreaterThan(-1);
    expect(sql.indexOf('INSERT INTO Denominations')).toBeGreaterThan(
      sql.indexOf('INSERT INTO Issuers')
    );
  });

  it('carries the issuer key only as far as a temp table', () => {
    // The key is an authoring convenience and must never reach the schema:
    // Issuers has no column for it and adding one would make the JSON file
    // load-bearing for ever.
    expect(sql).toContain('#SeedIssuer');
    expect(sql).not.toMatch(/INSERT INTO Issuers[\s\S]{0,200}IssuerKey/);
  });

  it('chunks its VALUES lists under SQL Server\'s 1000-row limit', () => {
    const many = {
      issuers: [{ key: 'us', name: 'United States', isoCode: 'US', kind: 'modern', sortOrder: 1 }],
      denominations: Array.from({ length: 1200 }, (_unused, index) => ({
        issuer: 'us',
        label: `Label ${index}`,
        faceValue: index,
        sortOrder: index,
      })),
    };
    const generated = buildSeedMigrationSql(many);

    // More than one INSERT ... VALUES into the denomination temp table, and
    // no single one of them over 1000 rows. A 1,200-row VALUES clause is
    // rejected outright by SQL Server ("The number of row value expressions
    // ... exceeds the maximum").
    const inserts = generated.split('INSERT INTO #SeedDenomination').slice(1);
    expect(inserts.length).toBeGreaterThan(1);
    for (const insert of inserts) {
      const rows = insert.slice(0, insert.indexOf(';')).split('\n(').length - 1;
      expect(rows).toBeLessThanOrEqual(1000);
    }
  });

  it('says where it came from and that it must not be hand-edited', () => {
    expect(sql).toMatch(/GENERATED FILE/);
    expect(sql).toMatch(/seed-data[\/\\]issuers-denominations\.json/);
    expect(sql).toMatch(/generate-seed-migration/);
  });

  it('reports what it did, either way', () => {
    expect(sql).toMatch(/PRINT/);
    expect(sql).toMatch(/Migration 013/);
  });
});

/*
 * THE REAL SEED, AND THE FILE CHECKED IN BESIDE IT
  */

describe('the authored seed and the migration generated from it', () => {
  const realSeed = JSON.parse(fs.readFileSync(SEED_DATA_PATH, 'utf8')) as {
    issuers: { key: string; name: string; isoCode: string | null }[];
    denominations: { issuer: string; label: string }[];
  };

  it('validates', () => {
    // The data is authored by hand and owned elsewhere; this is the gate
    // that stops a typo in it reaching a migration.
    expect(() => validateSeed(realSeed)).not.toThrow();
  });

  it('is what the checked-in 013 was generated from, character for character', () => {
    // A generated file that has drifted from its source is the worst of
    // both worlds: the JSON is what gets reviewed and the .sql is what gets
    // run. Regenerate with:
    //     cd server && npx tsx migrations/generate-seed-migration.ts
    expect(fs.existsSync(SEED_MIGRATION_PATH)).toBe(true);
    const onDisk = fs.readFileSync(SEED_MIGRATION_PATH, 'utf8');
    expect(onDisk).toBe(generateSeedMigrationSql());
  });

  it('already contains every denomination setup-database.sql seeds, under the matching issuer', () => {
    // THE DUPLICATION GUARD, CHECKED FROM THE OTHER END.
    //
    // 013 links the 40 pre-existing rows to an issuer by their Country and
    // then skips any seed row that issuer already has. If the JSON spelled
    // a label differently from the row already in the database -- 'Half
    // Dollar' where the table says '50¢' -- the guard would not fire, a
    // SECOND row would be inserted under the United States, and the two
    // would fold to one key. Two candidates under one issuer is AMBIGUOUS,
    // which resolves to NULL: every half dollar in the collection would
    // come out of the migration unresolved. The seed would have deleted a
    // denomination by adding one.
    const schema = fs.readFileSync(path.join(__dirname, '..', 'setup-database.sql'), 'utf8');

    const seeded: { label: string; country: string }[] = [];
    for (const row of schema.matchAll(/^\(\d+,\s*'((?:[^']|'')*)',\s*'(US|GB)',/gm)) {
      seeded.push({ label: row[1].replace(/''/g, "'"), country: row[2] });
    }
    expect(seeded.length, 'parsed the Denominations seed out of setup-database.sql').toBeGreaterThan(30);

    const issuerByCode = new Map(
      realSeed.issuers.filter((issuer) => issuer.isoCode).map((issuer) => [issuer.isoCode as string, issuer.key])
    );
    const authored = new Set(
      realSeed.denominations.map((denomination) => `${denomination.issuer}\u0000${denomination.label.toLowerCase()}`)
    );

    const missing = seeded.filter((row) => {
      const issuerKey = issuerByCode.get(row.country);
      return !issuerKey || !authored.has(`${issuerKey}\u0000${row.label.toLowerCase()}`);
    });
    expect(missing).toEqual([]);
  });

  it('is pure ASCII once generated, the REAL seed and not just a fixture', () => {
    // The ASCII rule is tested above against the two-row VALID fixture,
    // which contains no '¢' and no '£' and therefore cannot fail. The seed
    // that actually ships does: 'Écu', '½¢', '£1', 'Württemberg'. Those are
    // legal IN THE JSON -- the JSON is read by Node as UTF-8 -- and must
    // come out of the generator as NCHAR(n), because the .sql is read by
    // sqlcmd, whose code page is whatever the machine says it is.
    //
    // This is the test that would catch a future escaping change, and it is
    // the one the Palestine labels had to pass: '1 Mil' through '100 Mils'
    // are plain ASCII, so they add nothing new here, which is the point.
    const onDisk = fs.readFileSync(SEED_MIGRATION_PATH, 'utf8');
    const nonAscii = [...onDisk].filter((character) => character.charCodeAt(0) > 127);
    expect(nonAscii).toEqual([]);
    expect(onDisk).toContain('NCHAR(');
  });

  it('gives every label in the seed a unique fold WITHIN its issuer', () => {
    // Same failure, reached a different way: two labels in the JSON that
    // are spelled differently but mean the same coin to the alias layer.
    // validateSeed catches exact duplicates; this catches the ones only the
    // folding sees. Reproduced here rather than imported because
    // denomination-aliases.ts lives in src/ and the server does not compile
    // against it -- the full comparison is in
    // src/app/services/denominations/sql-denomination-resolution-parity.spec.ts.
    const fold = (text: string): string =>
      text
        .replace(/¢/g, 'c')
        .replace(/½/g, 'half')
        .replace(/£/g, 'gbp')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();

    const collisions: string[] = [];
    const byIssuer = new Map<string, Map<string, string>>();
    for (const denomination of realSeed.denominations) {
      let seen = byIssuer.get(denomination.issuer);
      if (!seen) {
        seen = new Map();
        byIssuer.set(denomination.issuer, seen);
      }
      const key = fold(denomination.label);
      const first = seen.get(key);
      if (first !== undefined) {
        collisions.push(`${denomination.issuer}: '${first}' and '${denomination.label}' both fold to '${key}'`);
      } else {
        seen.set(key, denomination.label);
      }
    }
    expect(collisions).toEqual([]);
  });
});

/*
 * THE BRITISH MANDATE FOR PALESTINE
 *
 * Added on request. Everything asserted below is a FACT ABOUT THE COINAGE
 * that was checked against sources before it was typed, which is the only
 * reason a seed entry is worth testing at all:
 *
 *   - The Palestine Currency Order was made 7 February 1927 and the
 *     Palestine pound, divided into 1,000 mils, entered circulation on
 *     1 November 1927. The Mandate expired at midnight on 14/15 May 1948
 *     and the Palestine Currency Board was dissolved that month.
 *     (en.wikipedia.org/wiki/Palestine_pound,
 *      en.wikipedia.org/wiki/Mandatory_Palestine)
 *
 *   - SEVEN circulating denominations, all struck at the Royal Mint:
 *     1, 2, 5, 10, 20, 50 and 100 mils. The 5, 10 and 20 are centre-holed
 *     cupro-nickel (bronze 1942-44, when nickel went to the war); the 50
 *     and 100 are .720 silver. Coins are dated 1927-1947, though the
 *     1947s were melted rather than released, so 1946 is the last year
 *     anything circulated. (Krause KM# 1-7 via worldcoinscatalog.com,
 *     chiefacoins.com, numista.com/7298, coinweek.com)
 *
 *   - NOTHING ABOVE 100 MILS WAS A COIN. A gold Palestine pound was
 *     authorised by the 1927 Order at a silver:gold ratio of 10.5:1 and
 *     was never minted. 500 mils (= half a pound) and up were BANKNOTES
 *     issued by the Palestine Currency Board. That is the single easiest
 *     mistake to make here -- Israel's 250 and 500 PRUTA, already in this
 *     seed, are post-1948 and belong to a different issuer -- so it has a
 *     test of its own below.
 *
 *   - NO ISO CODE. Issuers.IsoCode is CHAR(2), an ISO 3166-1 alpha-2
 *     country code; ISO 3166 was first published in 1974 and the Mandate
 *     ended in 1948. 'PS' belongs to the State of Palestine, a different
 *     entity, and 'IL' is already this seed's Israel. Null is the honest
 *     answer, and the validator accepts it.
 */

describe('the British Mandate for Palestine', () => {
  const MANDATE_KEY = 'palestine-mandate';

  interface FullSeedFile {
    issuers: {
      key: string;
      name: string;
      isoCode: string | null;
      kind: string;
      validFrom: number | null;
      validTo: number | null;
      sortOrder: number;
    }[];
    denominations: { issuer: string; label: string; faceValue: number | null; sortOrder: number }[];
  }

  const seed = JSON.parse(fs.readFileSync(SEED_DATA_PATH, 'utf8')) as FullSeedFile;
  const issuer = seed.issuers.find((candidate) => candidate.key === MANDATE_KEY);
  const rows = seed.denominations.filter((row) => row.issuer === MANDATE_KEY);

  it('is in the seed, as a historical issuer with a closed date range', () => {
    expect(issuer).toBeDefined();
    expect(issuer).toMatchObject({
      name: 'British Mandate for Palestine',
      kind: 'historical',
      isoCode: null,
      validFrom: 1927,
      validTo: 1948,
    });
  });

  it('sits in the historical band of SortOrder, after the last entry there', () => {
    // The bands are the stored curator order: modern 100-420, historical
    // 1000-1150, ancient 2000-2120. A 'historical' issuer numbered 430
    // would read as modern to anyone maintaining this file, and POST
    // /issuers computes MAX + 10 on top of whatever the highest is.
    const historical = seed.issuers.filter((candidate) => candidate.kind === 'historical');

    expect(issuer?.sortOrder).toBeGreaterThanOrEqual(1000);
    expect(issuer?.sortOrder).toBeLessThan(2000);
    expect(issuer?.sortOrder).toBe(Math.max(...historical.map((candidate) => candidate.sortOrder)));
  });

  it('carries exactly the seven circulating denominations', () => {
    expect(rows.map((row) => row.label)).toEqual([
      '1 Mil',
      '2 Mils',
      '5 Mils',
      '10 Mils',
      '20 Mils',
      '50 Mils',
      '100 Mils',
    ]);
  });

  it('prices every one of them in pounds, because a mil is a thousandth', () => {
    // faceValue is in the issuer's MAIN unit throughout this file -- the
    // United States '1c' is 0.01, Great Britain's '6d' is 0.025 -- so a
    // mil is 0.001 and not 1. Derived from the label rather than listed
    // again, so the assertion cannot agree with a typo it copied.
    for (const row of rows) {
      const mils = Number(/^(\d+) Mils?$/.exec(row.label)?.[1]);
      expect(mils, `could not read a mil count out of ${row.label}`).toBeGreaterThan(0);
      expect(row.faceValue).toBeCloseTo(mils / 1000, 10);
    }
  });

  it('has no coin above 100 mils, because above that they were banknotes', () => {
    // The gold pound was authorised in 1927 and never struck; 500 mils
    // (half a pound), 1, 5, 10, 50 and 100 pounds were notes. Inventing a
    // '500 Mils' coin here would be inventing a coin.
    const highest = Math.max(...rows.map((row) => row.faceValue ?? 0));
    expect(highest).toBe(0.1);
    expect(rows.some((row) => /pound|lira|500|250/i.test(row.label))).toBe(false);
  });

  it('reaches the generated migration, issuer and denominations both', () => {
    // The JSON is what gets reviewed; the .sql is what the owner runs.
    const onDisk = fs.readFileSync(SEED_MIGRATION_PATH, 'utf8');
    expect(onDisk).toContain("N'British Mandate for Palestine'");
    for (const row of rows) {
      expect(onDisk).toContain(`(N'${MANDATE_KEY}', N'${row.label}', ${row.faceValue}, ${row.sortOrder})`);
    }
  });

  // Re-running 013 safely (both inserts NOT EXISTS-guarded -- issuers by
  // Name, denominations by (IssuerId, Label), so a second run against a
  // database that already holds the other 61 issuers adds Palestine and its
  // seven rows and nothing else) is asserted over this same migration file
  // by `can be picked up by re-running 013, or simply by reopening the app`
  // in the ancient-issuers block below, which additionally pins the
  // db/seed.ts guards. It is not restated here.
});

/*
 * THE EIGHT ANCIENT ISSUERS ADDED AFTER THE MANDATE
 *
 * Added by the same reviewed, offline route: researched against sources,
 * typed into the JSON, regenerated. The rule the author worked to is the
 * one in seed-sql.ts's header -- ACCURACY OVER COVERAGE -- and it shows in
 * how SHORT several of these lists are. Aegina gets two denominations and
 * Syracuse gets two, not because those cities struck two coins, but because
 * two is what the sources consulted actually attested BY NAME. A collector
 * adding the third himself is a normal action; a wrong third that shipped
 * with the app is a silent error he has no reason to doubt.
 *
 * WHERE EACH LIST CAME FROM (every URL below was read, not recalled):
 *
 *   Kingdom of Lydia  trite, hekte and the 1/24, 1/48 and 1/96 electrum
 *                     fractions: en.wikipedia.org/wiki/Electrum. The gold
 *                     and silver Croeseid staters (10.7 g heavy and 8.1 g
 *                     light gold; 10.7 g silver):
 *                     en.wikipedia.org/wiki/Croeseid. The full electrum
 *                     stater is DELIBERATELY ABSENT -- the Lydia article
 *                     says no complete specimen has been found and that
 *                     the 4.7 g trite may itself be the stater, and a
 *                     disputed coin is exactly what must not be seeded.
 *                     The hemihekte is absent for the same reason.
 *
 *   Aegina            "The Aeginetic stater was divided into two drachmae
 *                     of 6.1 grams of silver", and the captioned 404-340
 *                     BC land-tortoise drachma:
 *                     en.wikipedia.org/wiki/Aegina. No obol or smaller
 *                     fraction is attested there FOR AEGINA -- the
 *                     fraction table on the Ancient Greek coinage page is
 *                     Attic and generic -- so none is seeded.
 *
 *   Athens            Tetradrachm, didrachm (the Wappenmunzen didrachm
 *                     c. 545 BC) and the tetartemorion ("known to have
 *                     been struck in Athens, Colophon, and several other
 *                     cities"):
 *                     en.wikipedia.org/wiki/Ancient_Greek_coinage. The
 *                     obol, hemiobol, trihemiobol, diobol, triobol and
 *                     drachm, all named for Classical Athens:
 *                     en.wikipedia.org/wiki/Obol_(coin). NOT seeded,
 *                     because no page read attested them FOR ATHENS: the
 *                     dekadrachm, the tetrobol, the tritartemorion, the
 *                     hemitetartemorion, the bronze chalkous and the
 *                     407/406 BC emergency gold.
 *
 *   Corinth           Stater (8.6 g, "divided into three silver drachmae
 *                     of 2.9 g") and drachm:
 *                     en.wikipedia.org/wiki/Stater. The obol, from
 *                     "Corinth ... was documented having 0.42-gram
 *                     obols": en.wikipedia.org/wiki/Obol_(coin).
 *
 *   Syracuse          Tetradrachm ("A Syracusan tetradrachm (circa
 *                     415-405 BC)") and dekadrachm ("the silver decadrachm
 *                     coin from Syracuse signed by ... Kimon and
 *                     Euainetos"):
 *                     en.wikipedia.org/wiki/Ancient_Greek_coinage. The
 *                     Sicilian bronze litra fractions are attested for
 *                     SICILY and not for Syracuse
 *                     (en.wikipedia.org/wiki/Litra), so they stay where
 *                     they already are, under "Ancient Greece".
 *
 *   Carthage          Shekel ("The base denomination was the shekel"), the
 *                     gold shekel of 7.20 g, and the electrum half,
 *                     quarter, fifth and tenth:
 *                     en.wikipedia.org/wiki/Carthaginian_coinage. The
 *                     silver tetradrachm, from the same page: "the silver
 *                     was only minted in tetradrachms", Attic 17.26 g.
 *
 *   Greco-Bactrian    Stater (the kingdom's currency), the 20-stater
 *                     ("the largest gold coin ever minted in the ancient
 *                     world", 169.2 g) and the tetradrachm:
 *                     en.wikipedia.org/wiki/Greco-Bactrian_Kingdom and
 *                     en.wikipedia.org/wiki/Eucratides_I, which also
 *                     attests the "Pentadrachm (5 drachms) of Eucratides I
 *                     Megas".
 *
 *   Hasmonean         "Only bronze coins in various denominations have
 *                     been found; the smallest being a prutah or a half
 *                     prutah": en.wikipedia.org/wiki/Hasmonean_coinage.
 *                     The lepton, "first minted under Alexander Jannaeus
 *                     prior to 76 BCE": en.wikipedia.org/wiki/Greek_lepton.
 *                     NO SILVER. That page names one Roman denarius
 *                     associated with the Hasmoneans, and a Roman coin is
 *                     not a Hasmonean denomination.
 *
 * DATES. validFrom is the earliest year a source gives for the issuer or
 * its coinage; validTo is the end of the issuer, which for the Greek
 * cities is POLITICAL rather than numismatic, because no page read dated
 * the end of their coinage. Both are approximate, in the same broad-brush
 * spirit as the ancient entries already here ("Ancient Greece" is -700 to
 * -30). They are load-bearing for nothing except the derived Kind, and
 * every one of them is comfortably before 500.
 */

describe('the eight ancient issuers added after the Mandate', () => {
  interface AncientSeedShape {
    issuers: {
      key: string;
      name: string;
      isoCode: string | null;
      kind: string;
      validFrom: number | null;
      validTo: number | null;
      sortOrder: number;
    }[];
    denominations: { issuer: string; label: string; faceValue: number | null; sortOrder: number }[];
  }

  const ancientSeed = JSON.parse(fs.readFileSync(SEED_DATA_PATH, 'utf8')) as AncientSeedShape;

  const ADDED: Record<string, string[]> = {
    lydia: ['1/96 Stater', '1/48 Stater', '1/24 Stater', 'Hekte', 'Trite', 'Silver Stater', 'Gold Stater'],
    aegina: ['Drachm', 'Stater'],
    athens: [
      'Tetartemorion',
      'Hemiobol',
      'Obol',
      'Trihemiobol',
      'Diobol',
      'Triobol',
      'Drachm',
      'Didrachm',
      'Tetradrachm',
    ],
    corinth: ['Obol', 'Drachm', 'Stater'],
    syracuse: ['Tetradrachm', 'Dekadrachm'],
    carthage: ['Tenth Shekel', 'Fifth Shekel', 'Quarter Shekel', 'Half Shekel', 'Shekel', 'Tetradrachm'],
    'greco-bactrian-kingdom': ['Tetradrachm', 'Pentadrachm', 'Stater', '20 Stater'],
    'hasmonean-kingdom': ['Lepton', 'Half Prutah', 'Prutah'],
  };

  it('are all in the seed, as ancient issuers with closed BC spans and no ISO code', () => {
    // No ISO code: Issuers.IsoCode is CHAR(2), an ISO 3166-1 alpha-2
    // country code, and ISO 3166 was first published in 1974. For a city
    // that stopped striking coins in 340 BC there is no code to omit.
    for (const key of Object.keys(ADDED)) {
      const issuer = ancientSeed.issuers.find((candidate) => candidate.key === key);
      expect(issuer, `${key} is missing from the seed`).toBeDefined();
      expect(issuer?.kind, key).toBe('ancient');
      expect(issuer?.isoCode, key).toBeNull();
      expect(issuer?.validFrom ?? 0, `${key} validFrom`).toBeLessThan(0);
      expect(issuer?.validTo ?? 0, `${key} validTo`).toBeLessThan(0);
      expect(issuer?.validTo ?? 0, `${key} ends after it starts`).toBeGreaterThan(issuer?.validFrom ?? 0);
    }
  });

  it('is consistent with the derivation rule, so none of them needs a stored kind to stay ancient', () => {
    // Every validFrom here is BC and therefore below the rule's threshold
    // of 500. If somebody later adds an "ancient" issuer starting in 600
    // AD, the form would derive 'historical' for it and the seed and the
    // screen would disagree about the same row.
    for (const key of Object.keys(ADDED)) {
      const issuer = ancientSeed.issuers.find((candidate) => candidate.key === key);
      expect(issuer?.validFrom ?? 0, `${key} must derive as ancient`).toBeLessThan(500);
    }
  });

  it('carries exactly the researched denominations, in ascending value order', () => {
    for (const [key, labels] of Object.entries(ADDED)) {
      const denominationRows = ancientSeed.denominations.filter((row) => row.issuer === key);
      expect(denominationRows.map((row) => row.label), key).toEqual(labels);
      // Smallest first, in steps of ten, which is what the rest of the
      // file does and the order the maintenance screen renders.
      expect(denominationRows.map((row) => row.sortOrder), `${key} sort order`).toEqual(
        labels.map((_unused, index) => (index + 1) * 10)
      );
    }
  });

  it('prices none of them, because an ancient denomination has no decimal face value', () => {
    // Every ancient issuer already in this file does the same. A drachm is
    // not 1.00 of anything this column could mean, and inventing a number
    // would make it sort and compare against the United States cent.
    for (const key of Object.keys(ADDED)) {
      for (const row of ancientSeed.denominations.filter((candidate) => candidate.issuer === key)) {
        expect(row.faceValue, `${key} / ${row.label}`).toBeNull();
      }
    }
  });

  it('gives no issuer the same label twice, across the whole file', () => {
    // *** THE FAILURE THAT WOULD DELETE A DENOMINATION RATHER THAN ADD
    // ONE. *** Two rows with the same label under one issuer make every
    // resolution of that text AMBIGUOUS, and ambiguous resolves to NULL.
    // validateSeed enforces this too; it is restated here so the next
    // person adding a ninth issuer meets the rule where they are working.
    const seen = new Set<string>();
    for (const row of ancientSeed.denominations) {
      const pair = `${row.issuer}\u0000${row.label.toLowerCase()}`;
      expect(seen.has(pair), `${row.issuer} has '${row.label}' twice`).toBe(false);
      seen.add(pair);
    }
  });

  it('does not reuse a sort order the owner may already have taken', () => {
    // The seeded ancient band ends at 2120, and the owner's live database
    // already holds an issuer HE added, which took MAX(SortOrder) + 10 =
    // 2130. Continuing the band would have put a seeded row on a number
    // belonging to a row this seed must never touch. These start at 3000.
    for (const key of Object.keys(ADDED)) {
      const issuer = ancientSeed.issuers.find((candidate) => candidate.key === key);
      expect(issuer?.sortOrder ?? 0, key).toBeGreaterThanOrEqual(3000);
    }
  });

  it('reaches the generated migration, issuers and denominations both', () => {
    const onDisk = fs.readFileSync(SEED_MIGRATION_PATH, 'utf8');
    for (const [key, labels] of Object.entries(ADDED)) {
      const issuer = ancientSeed.issuers.find((candidate) => candidate.key === key);
      expect(onDisk, key).toContain(`N'${issuer?.name}'`);
      for (const label of labels) {
        expect(onDisk, `${key} / ${label}`).toContain(`(N'${key}', N'${label}', NULL,`);
      }
    }
  });

  it('can be picked up by re-running 013, or simply by reopening the app', () => {
    // BOTH ROUTES ARE GUARDED, which is the whole instruction the owner
    // needs. Migration 013 inserts issuers WHERE NOT EXISTS by Name and
    // denominations WHERE NOT EXISTS by (IssuerId, Label); db/seed.ts does
    // the same thing in SQLite on EVERY open. So the eight new issuers and
    // their 36 denominations appear on his next launch, his own additions
    // and his 40 edits are untouched, and nothing is doubled.
    const onDisk = fs.readFileSync(SEED_MIGRATION_PATH, 'utf8');
    expect(onDisk).toMatch(
      /INSERT INTO Issuers[\s\S]*?WHERE NOT EXISTS \(SELECT 1 FROM Issuers i WHERE i\.Name = s\.Name\)/
    );
    expect(onDisk).toMatch(
      /INSERT INTO Denominations[\s\S]*?WHERE NOT EXISTS \(\s*SELECT 1 FROM Denominations d\s*WHERE d\.IssuerId = i\.IssuerId AND d\.Label = s\.Label\s*\)/
    );

    const seeder = fs.readFileSync(path.join(__dirname, '..', 'db', 'seed.ts'), 'utf8');
    expect(seeder).toContain('WHERE NOT EXISTS (SELECT 1 FROM Issuers WHERE Name = @name)');
    expect(seeder).toContain('(SELECT 1 FROM Denominations WHERE IssuerId = @issuerId AND Label = @label)');
  });
});
