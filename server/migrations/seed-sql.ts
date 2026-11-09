/*
 * migrations/seed-sql.ts — reviewable JSON in, migration 013 out.
 *
 * A GENERATOR AND NOT A HAND-WRITTEN .sql. There is no redistributable,
 * machine-readable dataset of denominations by issuer: Nomisma is coin-TYPE
 * data under non-commercial terms, Numista answers 403 to automated reads,
 * WorldCoinDatabase has no export. So the seed is AUTHORED — roughly 40
 * issuers and 800 to 1,500 denominations — and the only thing that makes a
 * hand-authored file of that size survivable is that the author reviews,
 * diffs and corrects DATA rather than T-SQL:
 *
 *     { "issuer": "mexico", "label": "8 Reales", "faceValue": 8,
 *       "sortOrder": 80 }
 *
 * `key` is a stable slug joining the two arrays. It never reaches the
 * database — it travels as far as a temp table in the generated script and
 * stops there, because adding a column for it would make the JSON file
 * load-bearing for ever.
 *
 * WHAT THIS REFUSES. A 1,500-row authored file goes wrong QUIETLY:
 *
 *   UNKNOWN ISSUER KEY. Left to the generated JOIN, the row simply never
 *   appears, and nothing reports it.
 *
 *   DUPLICATE ISSUER KEY OR NAME. Issuers.Name is UNIQUE and the generated
 *   script joins denominations to issuers by name, so a duplicate either
 *   fails the insert or silently picks a winner, depending on the database.
 *
 *   THE SAME LABEL TWICE UNDER ONE ISSUER — the worst of them, and
 *   counter-intuitive. Two '8 Reales' rows under Mexico make every resolution
 *   of that text AMBIGUOUS, and ambiguous resolves to NULL. A duplicated seed
 *   row does not add a denomination; it DELETES one.
 *
 *   A VALUE TOO LONG FOR ITS COLUMN. SQL Server raises 8152 and aborts the
 *   whole transaction, half way through the insert.
 *
 * Everything is reported in ONE throw, with the offending row named: fixing a
 * 1,500-row file one error per run is a bad afternoon.
 *
 * THE OUTPUT IS PURE ASCII. Labels contain the cent sign, the vulgar one-half
 * and the pound sign, and issuer names contain accents. Written literally
 * into a .sql file, the script's correctness would depend on sqlcmd reading
 * the file in the right code page (migration 007 states the same case). Every
 * non-ASCII character is emitted as NCHAR(n) instead, so the generated file
 * cannot be mangled by a code page, by git, or by a network share.
 */

/** The three values `Issuers.Kind` may take. Mirrors the column's comment. */
export const ISSUER_KINDS = ['modern', 'historical', 'ancient'] as const;
export type IssuerKind = (typeof ISSUER_KINDS)[number];

/** `Issuers.Name` and `Denominations.Label` are both NVARCHAR(100). */
export const MAX_NAME_LENGTH = 100;

/** How many rows go in one `VALUES` list. SQL Server's hard limit is 1000. */
export const VALUES_CHUNK = 500;

/** One authored issuer, after validation. */
export interface SeedIssuer {
  /** Stable slug joining the two arrays. Never reaches the database. */
  key: string;
  name: string;
  isoCode: string | null;
  kind: IssuerKind;
  validFrom: number | null;
  validTo: number | null;
  sortOrder: number;
}

/** One authored denomination, after validation. */
export interface SeedDenomination {
  /** The `key` of the issuer that struck it. */
  issuer: string;
  label: string;
  faceValue: number | null;
  sortOrder: number;
}

export interface SeedFile {
  issuers: SeedIssuer[];
  denominations: SeedDenomination[];
}

/** Thrown with every problem found, one per line. */
export class SeedValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(
      `server/migrations/seed-data/issuers-denominations.json is not usable ` +
        `(${problems.length} problem${problems.length === 1 ? '' : 's'}):\n  ` +
        problems.join('\n  ')
    );
    this.name = 'SeedValidationError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value);

/** `undefined` and `null` both mean "not stated". */
const optional = (value: unknown): unknown => (value === undefined ? null : value);

/**
 * Read and check the whole file, reporting every problem at once.
 *
 * @throws SeedValidationError listing every problem found
 */
export function validateSeed(data: unknown): SeedFile {
  const problems: string[] = [];

  if (!isRecord(data)) {
    throw new SeedValidationError([
      `the file must contain a JSON object with "issuers" and "denominations" arrays (got ${
        data === null ? 'null' : typeof data
      })`,
    ]);
  }

  const rawIssuers = data['issuers'];
  const rawDenominations = data['denominations'];

  if (!Array.isArray(rawIssuers)) problems.push('"issuers" must be an array');
  if (!Array.isArray(rawDenominations)) problems.push('"denominations" must be an array');
  if (problems.length > 0) throw new SeedValidationError(problems);

  /* ---- issuers ------------------------------------------------------- */
  const issuers: SeedIssuer[] = [];
  const keysSeen = new Map<string, number>();
  const namesSeen = new Map<string, number>();

  (rawIssuers as unknown[]).forEach((raw, index) => {
    const where = `issuers[${index}]`;
    if (!isRecord(raw)) {
      problems.push(`${where}: must be an object`);
      return;
    }

    const key = String(raw['key'] ?? '').trim();
    const name = String(raw['name'] ?? '').trim();
    const kind = raw['kind'];
    const isoCode = optional(raw['isoCode']);
    const validFrom = optional(raw['validFrom']);
    const validTo = optional(raw['validTo']);
    const sortOrder = raw['sortOrder'];
    const label = `${where} ${name ? `'${name}'` : ''}`.trim();

    if (!key) problems.push(`${label}: "key" must be a non-empty slug`);
    else if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) {
      // A slug rather than free text because it is the join between the two
      // arrays and a trailing space in one of them is invisible in a diff.
      problems.push(`${label}: "key" must be lower-case letters, digits and hyphens (got '${key}')`);
    }

    if (!name) problems.push(`${label}: "name" must be non-empty`);
    else if (name.length > MAX_NAME_LENGTH) {
      problems.push(`${label}: "name" is ${name.length} characters; Issuers.Name is NVARCHAR(${MAX_NAME_LENGTH})`);
    }

    if (!ISSUER_KINDS.includes(kind as IssuerKind)) {
      problems.push(`${label}: "kind" must be one of ${ISSUER_KINDS.join(', ')} (got ${JSON.stringify(kind)})`);
    }

    if (isoCode !== null && !(typeof isoCode === 'string' && /^[A-Za-z]{2}$/.test(isoCode))) {
      // CHAR(2). Null is the normal answer for ancients and historical
      // states and must stay easy to write; a three-letter code is a typo.
      problems.push(`${label}: "isoCode" must be exactly two letters or null (got ${JSON.stringify(isoCode)})`);
    }

    for (const [field, value] of [['validFrom', validFrom], ['validTo', validTo]] as const) {
      if (value !== null && !isInteger(value)) {
        problems.push(`${label}: "${field}" must be a whole year or null (got ${JSON.stringify(value)})`);
      }
    }
    if (isInteger(validFrom) && isInteger(validTo) && validTo < validFrom) {
      problems.push(`${label}: "validTo" (${validTo}) is before "validFrom" (${validFrom})`);
    }

    if (!isInteger(sortOrder)) {
      problems.push(`${label}: "sortOrder" must be a whole number (got ${JSON.stringify(sortOrder)})`);
    }

    if (key) {
      const first = keysSeen.get(key);
      if (first !== undefined) problems.push(`${label}: duplicate issuer key '${key}', first used by issuers[${first}]`);
      else keysSeen.set(key, index);
    }
    if (name) {
      // Folded, because SQL Server's default collation is case-insensitive:
      // 'mexico' and 'Mexico' violate UQ_Issuers_Name on the database even
      // though a case-sensitive check here would let them through.
      const folded = name.toLowerCase();
      const first = namesSeen.get(folded);
      if (first !== undefined) problems.push(`${label}: duplicate issuer name '${name}', first used by issuers[${first}]`);
      else namesSeen.set(folded, index);
    }

    issuers.push({
      key,
      name,
      isoCode: typeof isoCode === 'string' ? isoCode.toUpperCase() : null,
      kind: kind as IssuerKind,
      validFrom: isInteger(validFrom) ? validFrom : null,
      validTo: isInteger(validTo) ? validTo : null,
      sortOrder: isInteger(sortOrder) ? sortOrder : 0,
    });
  });

  /* ---- denominations -------------------------------------------------- */
  const denominations: SeedDenomination[] = [];
  const pairsSeen = new Map<string, number>();

  (rawDenominations as unknown[]).forEach((raw, index) => {
    const where = `denominations[${index}]`;
    if (!isRecord(raw)) {
      problems.push(`${where}: must be an object`);
      return;
    }

    const issuer = String(raw['issuer'] ?? '').trim();
    const rawLabel = raw['label'];
    const labelText = typeof rawLabel === 'string' ? rawLabel.trim() : '';
    const faceValue = optional(raw['faceValue']);
    const sortOrder = raw['sortOrder'];
    const where2 = `${where} ${labelText ? `'${labelText}'` : ''}`.trim();

    if (!labelText) problems.push(`${where2}: "label" must be non-empty`);
    else if (labelText.length > MAX_NAME_LENGTH) {
      problems.push(`${where2}: "label" is ${labelText.length} characters; Denominations.Label is NVARCHAR(${MAX_NAME_LENGTH})`);
    }

    if (!issuer) {
      problems.push(`${where2}: "issuer" must name an issuer key`);
    } else if (!keysSeen.has(issuer)) {
      problems.push(`${where2}: unknown issuer key '${issuer}' -- no issuer in this file has that key`);
    }

    if (faceValue !== null && !(typeof faceValue === 'number' && Number.isFinite(faceValue))) {
      problems.push(`${where2}: "faceValue" must be a number or null (got ${JSON.stringify(faceValue)})`);
    }

    if (!isInteger(sortOrder)) {
      problems.push(`${where2}: "sortOrder" must be a whole number (got ${JSON.stringify(sortOrder)})`);
    }

    if (issuer && labelText) {
      // Case-insensitive again, for the same collation reason, and because
      // '8 reales' and '8 Reales' are the same row to every reader.
      const pair = `${issuer}\u0000${labelText.toLowerCase()}`;
      const first = pairsSeen.get(pair);
      if (first !== undefined) {
        problems.push(
          `${where2}: duplicate denomination -- issuer '${issuer}' already has label '${labelText}' at denominations[${first}]. ` +
            `Two rows that fold to one key make every resolution of that text ambiguous, which resolves to NULL.`
        );
      } else {
        pairsSeen.set(pair, index);
      }
    }

    denominations.push({
      issuer,
      label: labelText,
      faceValue: typeof faceValue === 'number' ? faceValue : null,
      sortOrder: isInteger(sortOrder) ? sortOrder : 0,
    });
  });

  if (problems.length > 0) throw new SeedValidationError(problems);
  return { issuers, denominations };
}

/**
 * One NVARCHAR literal, ASCII-safe.
 *
 * Runs of ASCII become `N'...'` with apostrophes doubled; anything above
 * code point 127 becomes `NCHAR(n)` and the pieces are concatenated. So
 * '50¢' emits as `N'50' + NCHAR(162)` and the file stays readable in any
 * editor and identical under any code page.
 *
 * The doubling is not decoration: "Louis d'or" is a real denomination, and
 * an unescaped apostrophe does not merely break the script -- it can leave
 * it parsing as something else entirely.
 */
export function sqlText(value: string): string {
  if (value.length === 0) return "N''";

  const pieces: string[] = [];
  let run = '';

  const flush = (): void => {
    if (run.length > 0) {
      pieces.push(`N'${run.replace(/'/g, "''")}'`);
      run = '';
    }
  };

  for (const character of value) {
    if (character.charCodeAt(0) > 127) {
      flush();
      for (let i = 0; i < character.length; i += 1) {
        pieces.push(`NCHAR(${character.charCodeAt(i)})`);
      }
    } else {
      run += character;
    }
  }
  flush();

  return pieces.join(' + ');
}

/** A nullable integer, or an expression that is literally NULL. */
const sqlInt = (value: number | null): string => (value === null ? 'NULL' : String(value));

/**
 * A nullable decimal for DECIMAL(18,6).
 *
 * `String(1e-7)` is '1e-7', which SQL Server reads as a FLOAT and then
 * rounds differently from a decimal literal. Anything that would need
 * exponent notation is refused rather than silently converted.
 */
function sqlDecimal(value: number | null): string {
  if (value === null) return 'NULL';
  const text = String(value);
  if (/e/i.test(text)) {
    throw new SeedValidationError([
      `faceValue ${text} cannot be written as a plain decimal literal; DECIMAL(18,6) holds six decimal places`,
    ]);
  }
  return text;
}

/** `INSERT INTO <table> (<columns>) VALUES` statements of at most 500 rows. */
function chunkedInsert(table: string, columns: string, rows: string[]): string {
  if (rows.length === 0) {
    return `-- (nothing to insert into ${table})`;
  }
  const statements: string[] = [];
  for (let start = 0; start < rows.length; start += VALUES_CHUNK) {
    const slice = rows.slice(start, start + VALUES_CHUNK);
    statements.push(
      `INSERT INTO ${table} (${columns}) VALUES\n${slice.map((row) => `(${row})`).join(',\n')};`
    );
  }
  return statements.join('\n\n');
}

/**
 * The whole of migration 013, as text.
 *
 * Validates first and always: the runner calls this, so a caller that
 * skipped `validateSeed` must not be able to emit a migration whose JOIN
 * silently drops rows.
 */
export function buildSeedMigrationSql(data: unknown): string {
  const seed = validateSeed(data);

  const issuerRows = seed.issuers.map((issuer) =>
    [
      sqlText(issuer.key),
      sqlText(issuer.name),
      issuer.isoCode === null ? 'NULL' : sqlText(issuer.isoCode),
      sqlText(issuer.kind),
      sqlInt(issuer.validFrom),
      sqlInt(issuer.validTo),
      String(issuer.sortOrder),
    ].join(', ')
  );

  const denominationRows = seed.denominations.map((denomination) =>
    [
      sqlText(denomination.issuer),
      sqlText(denomination.label),
      sqlDecimal(denomination.faceValue),
      String(denomination.sortOrder),
    ].join(', ')
  );

  return `-- ============================================================
-- 013-seed-issuers-and-denominations.sql
-- Seeds the Issuers table and their denominations
-- ============================================================
--
-- *** GENERATED FILE -- DO NOT HAND-EDIT. ***
-- Source:    server/migrations/seed-data/issuers-denominations.json
-- Generator: server/migrations/seed-sql.ts
-- Regenerate: cd server && npx tsx migrations/generate-seed-migration.ts
--
-- Contents: ${seed.issuers.length} issuer(s), ${seed.denominations.length} denomination(s).
--
-- An edit made here is lost the next time anybody regenerates, and a seed
-- that disagrees with its source file is worse than no seed at all -- the
-- JSON is what gets reviewed. server/migrations/seed-sql.spec.ts asserts
-- that this file is exactly what the generator produces from that JSON.
--
-- WHY THE SEED IS AUTHORED AND NOT IMPORTED
-- -----------------------------------------
-- There is no redistributable machine-readable dataset of denominations by
-- country. Nomisma is coin-TYPE data under non-commercial terms, Numista
-- answers HTTP 403 to automated reads, WorldCoinDatabase has no export.
-- Every row below is something a human was sure about, and the rule the
-- author worked to is ACCURACY OVER COVERAGE: a denomination the user adds
-- himself is a normal action, while a wrong one that shipped with the app is
-- a silent error he has no reason to doubt.
--
-- WHAT IT DOES, IN ORDER
-- ----------------------
--   1. Inserts any issuer whose Name is not already present.
--   2. Backfills Denominations.IssuerId on the rows that were already in the
--      database, from their existing Country -- and ONLY where exactly one
--      issuer matches it. This step is what stops step 3 inserting a SECOND
--      '50c' under the United States; two rows folding to one key make
--      every half dollar in the collection resolve as AMBIGUOUS, which
--      resolves to NULL. A duplicate here would delete a denomination.
--   3. Inserts any denomination its issuer does not already have.
--
-- Nothing is ever updated except that one backfill, and nothing is ever
-- deleted. Coins are not touched at all -- this script does not read or
-- write a single row of that table.
--
-- Denominations.Country is filled with the issuer's IsoCode where it has
-- one and its Name otherwise. That column is kept as flagged debt (design
-- section 4.2) and the existing editor dropdown still reads it, so leaving
-- it blank would make the new rows invisible there.
--
-- PURE ASCII, ON PURPOSE
-- ----------------------
-- Labels contain the cent sign, the vulgar one-half and the pound sign.
-- Written literally they would make this script's correctness depend on
-- sqlcmd reading the file in the right code page, which is a miserable
-- thing to debug; migration 007 states the case at length. They are emitted
-- as NCHAR(n) instead, so nothing between here and the database can mangle
-- them.
--
-- HOW TO RUN IT
-- -------------
--   sqlcmd -S localhost -d CoinInventory -E -i .\\migrations\\013-seed-issuers-and-denominations.sql
--
-- Run 011-add-issuers-and-denomination-links.sql FIRST; this script stops
-- with a clear message if you have not. Safe to run twice: every insert is
-- guarded on the row not already being there.
--
-- AFTERWARDS the lookup table is large. The editor's denomination dropdown
-- has not been rebuilt yet (that is a later step), so a flat list of this
-- size will be unpleasant to use until it has. That is the reason seeding
-- is a separate script from the schema: run 011 whenever you like, and hold
-- this one until the picker lands if you prefer.
-- ============================================================

USE CoinInventory;
GO

-- ============================================================
-- 0. Refuse to run before the schema exists
-- ============================================================
-- Without this the script dies with "Invalid object name 'Issuers'" in the
-- middle of a batch, which says nothing about what to do next.
IF OBJECT_ID('dbo.Issuers', 'U') IS NULL
BEGIN
    RAISERROR('Migration 013: table Issuers does not exist. Run 011-add-issuers-and-denomination-links.sql first.', 16, 1);
END
GO

-- ============================================================
-- 1. The authored issuers, staged
-- ============================================================
-- IssuerKey is the slug that joins the two arrays of the JSON file. It gets
-- this far and no further: Issuers has no column for it, because a key in
-- the schema would make the JSON file load-bearing for ever.
IF OBJECT_ID('tempdb..#SeedIssuer') IS NOT NULL DROP TABLE #SeedIssuer;

CREATE TABLE #SeedIssuer (
    IssuerKey   NVARCHAR(60)    NOT NULL,
    Name        NVARCHAR(100)   NOT NULL,
    IsoCode     CHAR(2)         NULL,
    Kind        NVARCHAR(20)    NOT NULL,
    ValidFrom   INT             NULL,
    ValidTo     INT             NULL,
    SortOrder   INT             NOT NULL
);

${chunkedInsert('#SeedIssuer', 'IssuerKey, Name, IsoCode, Kind, ValidFrom, ValidTo, SortOrder', issuerRows)}
GO

DECLARE @IssuersBefore INT = (SELECT COUNT(*) FROM Issuers);

INSERT INTO Issuers (Name, IsoCode, Kind, ValidFrom, ValidTo, SortOrder, IsActive)
SELECT s.Name, s.IsoCode, s.Kind, s.ValidFrom, s.ValidTo, s.SortOrder, 1
FROM #SeedIssuer s
WHERE NOT EXISTS (SELECT 1 FROM Issuers i WHERE i.Name = s.Name);

PRINT 'Migration 013: inserted ' + CAST(@@ROWCOUNT AS NVARCHAR(20))
    + ' issuer(s); the table held ' + CAST(@IssuersBefore AS NVARCHAR(20)) + ' before.';
GO

-- ============================================================
-- 2. Link the denominations that were already here
-- ============================================================
-- The rows seeded by setup-database.sql carry Country = 'US' or 'GB' and no
-- issuer. Linking them is what makes step 3's guard work: without it the
-- seed inserts a second '50c' under the United States, and two rows folding
-- to one key make every half dollar in the collection resolve as AMBIGUOUS
-- -- which resolves to NULL. The duplicate would not add a denomination, it
-- would take one away.
--
-- ONLY where exactly one issuer matches. A Country that matches two (or
-- none) is left alone for a human, because a lookup row filed under the
-- wrong issuer is invisible and permanent.
UPDATE d
SET IssuerId = (
        SELECT MIN(i.IssuerId) FROM Issuers i
        WHERE i.IsoCode = d.Country OR i.Name = d.Country
    )
FROM Denominations d
WHERE d.IssuerId IS NULL
  AND (
        SELECT COUNT(*) FROM Issuers i
        WHERE i.IsoCode = d.Country OR i.Name = d.Country
      ) = 1;

PRINT 'Migration 013: linked ' + CAST(@@ROWCOUNT AS NVARCHAR(20))
    + ' pre-existing denomination(s) to an issuer by their Country.';
GO

-- ============================================================
-- 3. The authored denominations, staged
-- ============================================================
IF OBJECT_ID('tempdb..#SeedDenomination') IS NOT NULL DROP TABLE #SeedDenomination;

CREATE TABLE #SeedDenomination (
    IssuerKey   NVARCHAR(60)    NOT NULL,
    Label       NVARCHAR(100)   NOT NULL,
    FaceValue   DECIMAL(18,6)   NULL,
    SortOrder   INT             NOT NULL
);

${chunkedInsert('#SeedDenomination', 'IssuerKey, Label, FaceValue, SortOrder', denominationRows)}
GO

INSERT INTO Denominations (Label, Country, IssuerId, FaceValue, SortOrder, IsActive)
SELECT s.Label,
       COALESCE(i.IsoCode, LEFT(i.Name, 100)),
       i.IssuerId,
       s.FaceValue,
       s.SortOrder,
       1
FROM #SeedDenomination s
INNER JOIN #SeedIssuer si ON si.IssuerKey = s.IssuerKey
INNER JOIN Issuers i ON i.Name = si.Name
WHERE NOT EXISTS (
    SELECT 1 FROM Denominations d
    WHERE d.IssuerId = i.IssuerId AND d.Label = s.Label
);

PRINT 'Migration 013: inserted ' + CAST(@@ROWCOUNT AS NVARCHAR(20)) + ' denomination(s).';
GO

DROP TABLE #SeedIssuer;
DROP TABLE #SeedDenomination;
GO

-- ============================================================
-- SUMMARY
-- ============================================================
DECLARE @Issuers      INT = (SELECT COUNT(*) FROM Issuers);
DECLARE @Denoms       INT = (SELECT COUNT(*) FROM Denominations);
DECLARE @Orphans      INT = (SELECT COUNT(*) FROM Denominations WHERE IssuerId IS NULL);

PRINT '';
PRINT '--- After migration 013 ---';
PRINT 'Issuers ......................... ' + CAST(@Issuers AS NVARCHAR(20));
PRINT 'Denominations ................... ' + CAST(@Denoms  AS NVARCHAR(20));
PRINT '  ... still with no issuer ...... ' + CAST(@Orphans AS NVARCHAR(20));
PRINT '';
PRINT 'Rows with no issuer are ones this script could not match to exactly';
PRINT 'one issuer by their Country. They still work exactly as they did';
PRINT 'before; they simply cannot be preferred by a coin''s country yet.';
PRINT '';
PRINT 'No coin has been touched. Next: 014-resolve-coin-denominations.sql,';
PRINT 'and READ ITS REPORT before anything else is built on top of this.';
GO
`;
}
