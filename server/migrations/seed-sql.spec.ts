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
