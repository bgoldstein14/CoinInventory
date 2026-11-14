/**
 * db/coin-fields.ts — the Coins table, column by column: the single source of
 * truth for the parameter types used by both INSERT and UPDATE.
 *
 * Every `.input(name, type, value)` type must match db/schema.sql exactly.
 * *** WHAT "MUST MATCH" NOW MEANS IS DIFFERENT FROM WHAT IT USED TO MEAN,
 * AND THE DIFFERENCE IS THE POINT OF THIS FILE. ***
 *
 *   THEN (mssql + SQL Server). A parameter declared SHORTER than its column
 *   silently TRUNCATED the user's data — mssql trimmed the value before it
 *   ever reached the server, so there was no error, just missing characters.
 *   A parameter declared LONGER made SQL Server raise 8152 / 2628 "String or
 *   binary data would be truncated" and abort the transaction.
 *
 *   NOW (SQLite). SQLite enforces nothing at all: it will put four thousand
 *   characters in a column this file calls NVarChar(50) and say nothing.
 *   The declared lengths here are therefore no longer a description of what
 *   the database will do — THEY ARE THE ONLY THING THAT DOES IT.
 *   db/bind-values.ts reads them and refuses an over-long value with the
 *   8152 equivalent, which routes/db-error-response.ts turns into an HTTP
 *   400. Silent truncation is gone in both directions: a value that is too
 *   long is reported, not quietly shortened.
 *
 *   The same applies to the DECIMAL entries. SQL Server rounded a value to
 *   the column's scale on the way in and refused one too large for its
 *   precision; SQLite stores whatever double it is handed. Both behaviours
 *   are reapplied from the precision and scale recorded here. The argument
 *   for storing these as REAL at all is in the header of db/schema.sql and
 *   it is the most consequential decision in the migration — read it before
 *   changing a Decimal() on this page.
 *
 * db/coin-fields.spec.ts parses db/schema.sql and fails the build if the two
 * ever disagree.
 *
 * CoinId: the column is TEXT and we bind NVarChar(36). It was
 * UNIQUEIDENTIFIER under SQL Server and the binding was NVarChar(36) even
 * then, deliberately — a GUID-typed parameter would reject any id that is not
 * a well-formed GUID, and the Quicken import path and some existing rows use
 * free-form ids. SQLite has no GUID type, so the schema now simply says what
 * the application was always doing. (The CoinId binding itself lives in
 * db/bindings.ts with the other tables.)
 */

import { NVarChar, Int, Bit, Decimal, MAX, type DbType } from './column-types';
import { normalizeNullable, normalizeTextDate } from './value-normalizers';
import {
  DEFAULT_COLLECTION_STATUS,
  MAX_COLLECTION_STATUS_LENGTH,
  normalizeCollectionStatus,
} from './collection-status';

/** Describes how one JSON field maps onto one Coins column. */
export interface CoinColumnBinding {
  /** Column name in the Coins table. */
  column: string;
  /** Parameter type. MUST match db/schema.sql. */
  sqlType: DbType;
  /** Declared NVARCHAR length; undefined for non-text and NVARCHAR(MAX) columns. */
  maxLength?: number;
  /** Converts an incoming JSON value into the value we bind. */
  normalize?: (value: unknown) => unknown;
  /** Value used by INSERT when the request body omits this field. */
  insertDefault?: unknown;
}

/**
 * The Coins table, column by column, in schema order.
 * Used by both POST /api/coins (INSERT) and PUT /api/coins/:id (UPDATE).
 */
export const COIN_FIELDS: Record<string, CoinColumnBinding> = {
  denomination:  { column: 'Denomination',  sqlType: NVarChar(100), maxLength: 100 },
  /*
   * DenominationId INT NULL -> Denominations(DenominationId).
   *
   * PUT /api/coins/:id generates its UPDATE from the keys present in the
   * request body INTERSECTED WITH THIS MAP, so an unbound column yields a
   * statement that never names it, a 200 response, and a value that is gone on
   * the next reload — no error anywhere in that sequence. That is why
   * db/denomination-column.spec.ts and routes/coins/denomination-id.spec.ts
   * assert the generated SQL rather than the status code.
   *
   * TWO COLUMNS FOR ONE IDEA, AND BOTH ARE WRITTEN. This is the canonical link;
   * `denomination` above is WHAT THE SOURCE SAID. They are allowed to disagree,
   * and after an import or a deletion they usually do — that state is visible
   * by design, and src/app/services/denominations/denomination-display.ts is
   * the only place it is turned into words.
   *
   * NOTHING ON THE SERVER MAY REWRITE `Denomination` FROM THIS ID. Not the
   * routes, not the migrations (011, 013 and 014 all read it and leave it
   * alone). The text is the only surviving evidence of what a QIF, a CSV or a
   * spreadsheet actually said.
   *
   * NULL is the ORDINARY state for this column, not an error: every coin
   * imported before its issuer was seeded has one, and deleting a denomination
   * puts coins back into it. No insertDefault: a client that has never heard of
   * this feature must not have its coins linked to a denomination nobody chose.
   */
  denominationId: {
    column: 'DenominationId',
    sqlType: Int,
    normalize: normalizeForeignKeyId,
  },
  year:          { column: 'Year',          sqlType: NVarChar(50),  maxLength: 50 },
  coinType:      { column: 'CoinType',      sqlType: NVarChar(100), maxLength: 100 },
  category:      { column: 'Category',      sqlType: NVarChar(100), maxLength: 100 },
  country:       { column: 'Country',       sqlType: NVarChar(100), maxLength: 100 },
  grade:         { column: 'Grade',         sqlType: NVarChar(50),  maxLength: 50 },
  certCompany:   { column: 'CertCompany',   sqlType: NVarChar(100), maxLength: 100 },
  certNumber:    { column: 'CertNumber',    sqlType: NVarChar(100), maxLength: 100 },
  variety:       { column: 'Variety',       sqlType: NVarChar(100), maxLength: 100 },
  mintMark:      { column: 'MintMark',      sqlType: NVarChar(20),  maxLength: 20 },
  composition:   { column: 'Composition',   sqlType: NVarChar(100), maxLength: 100 },
  purchaseDate:  { column: 'PurchaseDate',  sqlType: NVarChar(30),  maxLength: 30, normalize: normalizeTextDate },
  purchasePrice: { column: 'PurchasePrice', sqlType: Decimal(12, 2) },
  currentValue:  { column: 'CurrentValue',  sqlType: Decimal(12, 2) },
  notes:         { column: 'Notes',         sqlType: NVarChar(MAX) },
  source:        { column: 'Source',        sqlType: NVarChar(50),  maxLength: 50, insertDefault: 'manual' },
  hasCacSticker: {
    column: 'HasCacSticker',
    sqlType: Bit,
    // HasCacSticker is BIT NOT NULL DEFAULT 0 — never bind null to it.
    normalize: (value) => (value ? 1 : 0),
    insertDefault: 0,
  },
  soldPrice:     { column: 'SoldPrice',     sqlType: Decimal(12, 2) },
  soldDate:      { column: 'SoldDate',      sqlType: NVarChar(30),  maxLength: 30, normalize: normalizeTextDate },
  // The coin's GROSS weight, in GRAMS. Stored values were troy ounces until
  // migration 008 multiplied them by 31.1034768; the column type did not
  // change, only the unit. DECIMAL(12,5) matches the five decimals the editor
  // shows — a parameter narrower than its column rounds the user's value away
  // without any error.
  weight:        { column: 'Weight',        sqlType: Decimal(12, 5) },
  metalContent:  { column: 'MetalContent',  sqlType: NVarChar(50),  maxLength: 50 },
  // DECIMAL(12,5) for the same reason as `weight` above.
  pmWeightGrams: { column: 'PmWeightGrams', sqlType: Decimal(12, 5) },
  pmPercent:     { column: 'PmPercent',     sqlType: Decimal(5, 2) },
  coinSet:       { column: 'CoinSet',       sqlType: NVarChar(100), maxLength: 100 },
  /*
   * CollectionStatus NVARCHAR(20) NOT NULL DEFAULT 'owned'.
   *
   * THE normalize HOOK IS LOAD-BEARING. DO NOT DELETE IT. Every other text
   * field here falls through to normalizeNullable(), which turns an empty or
   * absent value into SQL NULL; this column is NOT NULL, so that would abort
   * the INSERT with a constraint violation and the user could not save a coin
   * at all. normalizeCollectionStatus() always answers one of the five tokens —
   * never null, never the caller's text. That is also what keeps a closed set
   * closed: the column decides whether a coin counts towards the value of the
   * collection, so an unrecognised word from a request body would be a sixth
   * value nothing downstream has a rule for. See db/collection-status.ts.
   *
   * insertDefault is 'owned' for the same reason: a POST from a client that
   * predates the feature carries no status at all, and a coin the user has just
   * typed in is a coin he has.
   */
  collectionStatus: {
    column: 'CollectionStatus',
    sqlType: NVarChar(MAX_COLLECTION_STATUS_LENGTH),
    maxLength: MAX_COLLECTION_STATUS_LENGTH,
    normalize: normalizeCollectionStatus,
    insertDefault: DEFAULT_COLLECTION_STATUS,
  },
  /*
   * StorageLocation NVARCHAR(200) NULL — where the physical coin is: "Safe
   * deposit box 2", "Dansco 7070, page 4". Deliberately plain: no normalizer,
   * no default, no validation, so normalizeNullable() applies and an empty box
   * becomes NULL. Every collector organises differently, so anything done to
   * the text — trimming it to a pattern, matching it against a lookup,
   * title-casing it — would be wrong for somebody. If a future change gives
   * this field a normalizer, write the reason here.
   */
  storageLocation: { column: 'StorageLocation', sqlType: NVarChar(200), maxLength: 200 },
  /*
   * CatalogId INT NULL -> Catalogs(CatalogId).
   *
   * THE normalize HOOK IS LOAD-BEARING. DO NOT DELETE IT. normalizeNullable()
   * passes everything except `undefined` straight through to the INT
   * parameter, and three real inputs are not numbers:
   *
   *   - an empty box arrives as '';
   *   - a coin round-tripped through Export -> CSV -> Import carries the
   *     STRING "3" rather than the number 3, because the CSV importer copies a
   *     mapped cell into the record verbatim; and
   *   - a user who maps a catalogue-NAME column onto this field on the import
   *     screen sends "Sear".
   *
   * The first two may or may not be coerced by the driver, and that differs
   * between mssql versions; the third fails with SQL Server error 8114 ("Error
   * converting data type") at SAVE time, aborting the whole transaction so the
   * coin is lost rather than merely unattributed. normalizeForeignKeyId()
   * answers an integer or NULL and nothing else — NULL loses the attribution,
   * which the user can see and fix in one click.
   *
   * No insertDefault: a client that has never heard of this feature must not
   * have its coins attributed to a catalogue nobody chose.
   */
  catalogId: {
    column: 'CatalogId',
    sqlType: Int,
    normalize: normalizeForeignKeyId,
  },
  /*
   * CatalogNumber NVARCHAR(50) NULL — the reference within the catalogue:
   * '1A', '6819', 'II.1 234', 'RRC 44/5'. No normalizer on purpose. The value
   * is a KEY INTO A PRINTED BOOK, so upper-casing it, stripping its
   * punctuation or collapsing its internal space would produce a reference
   * that no longer matches the catalogue it names. If a future change gives
   * this field a normalizer, write the reason here.
   *
   * 50 characters, matching the column and CATALOG_NUMBER_MAX_LENGTH in
   * src/app/types/catalog-reference.ts, which caps the editor input.
   */
  catalogNumber: { column: 'CatalogNumber', sqlType: NVarChar(50), maxLength: 50 },
};

/**
 * An integer foreign-key id, or null. Never a string, never NaN.
 *
 * Shared by both INT foreign keys on Coins — `catalogId` and `denominationId`
 * — so that a route cannot end up coercing one and not the other. See the
 * notes on those bindings for the ways a non-number reaches here.
 *
 * `Number.parseInt` is deliberately not used: it would read "3 sheep" as 3,
 * which is a guess. `Number()` on a trimmed string is all-or-nothing, which is
 * the behaviour wanted — anything that is not plainly a number is "no link".
 */
function normalizeForeignKeyId(value: unknown): number | null {
  if (value === null || value === undefined) return null;

  const text = String(value).trim();
  if (text === '') return null;

  const id = Number(text);
  return Number.isInteger(id) ? id : null;
}

/**
 * Applies a field's normalizer (or the default one) to a raw JSON value.
 * Exported so both the INSERT and the UPDATE path use identical conversion.
 */
export function normalizeCoinValue(key: string, rawValue: unknown): unknown {
  const binding = COIN_FIELDS[key];
  if (!binding) return normalizeNullable(rawValue);
  return (binding.normalize ?? normalizeNullable)(rawValue);
}
