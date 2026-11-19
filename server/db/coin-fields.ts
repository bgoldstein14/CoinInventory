/**
 * The Coins table, column by column: the parameter types used by both INSERT
 * and UPDATE. Must match db/schema.sql (checked by db/coin-fields.spec.ts).
 *
 * SQLite enforces no lengths or decimal precision, so the NVarChar lengths and
 * Decimal precision/scale declared here are what db/bind-values.ts enforces:
 * an over-long string is rejected (HTTP 400), never truncated, and decimals
 * are rounded to scale and range-checked. See the db/schema.sql header for why
 * decimals are stored as REAL.
 *
 * CoinId is bound as NVarChar(36), not a GUID type, because imported coins
 * can have free-form ids. Its binding lives in db/bindings.ts.
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
   * DenominationId INT NULL -> Denominations(DenominationId). The canonical
   * link; `denomination` is the text the import source said, and the two may
   * disagree. The server never rewrites `Denomination` from this id.
   *
   * NULL is normal (unseeded issuer, deleted denomination). No insertDefault,
   * so older clients never link a denomination nobody chose.
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
  // Gross weight in grams (migration 008 converted from troy ounces).
  // DECIMAL(12,5) matches the five decimals the editor shows.
  weight:        { column: 'Weight',        sqlType: Decimal(12, 5) },
  metalContent:  { column: 'MetalContent',  sqlType: NVarChar(50),  maxLength: 50 },
  // DECIMAL(12,5), same as `weight`.
  pmWeightGrams: { column: 'PmWeightGrams', sqlType: Decimal(12, 5) },
  pmPercent:     { column: 'PmPercent',     sqlType: Decimal(5, 2) },
  coinSet:       { column: 'CoinSet',       sqlType: NVarChar(100), maxLength: 100 },
  /*
   * CollectionStatus NVARCHAR(20) NOT NULL DEFAULT 'owned'.
   * Needs its own normalizer: the default turns empty into NULL, which this
   * NOT NULL column would reject. normalizeCollectionStatus() always returns
   * one of the known tokens (see db/collection-status.ts).
   */
  collectionStatus: {
    column: 'CollectionStatus',
    sqlType: NVarChar(MAX_COLLECTION_STATUS_LENGTH),
    maxLength: MAX_COLLECTION_STATUS_LENGTH,
    normalize: normalizeCollectionStatus,
    insertDefault: DEFAULT_COLLECTION_STATUS,
  },
  /*
   * StorageLocation NVARCHAR(200) NULL: free text such as "Safe deposit box 2".
   * Intentionally not normalized beyond empty -> NULL.
   */
  storageLocation: { column: 'StorageLocation', sqlType: NVarChar(200), maxLength: 200 },
  /*
   * Acquisition / disposal record. Purchase and sale dates and prices are the
   * existing purchaseDate / purchasePrice / soldDate / soldPrice bindings
   * above; don't bind those columns twice.
   */
  purchasedFrom: { column: 'PurchasedFrom', sqlType: NVarChar(200), maxLength: 200 },
  soldTo:        { column: 'SoldTo',        sqlType: NVarChar(200), maxLength: 200 },
  /*
   * Not the same as `notes`: notes -> Coins.Notes (the coin), transactionNotes
   * -> Coins.TransactionNotes (the purchase/sale). Keep them separate.
   */
  transactionNotes: { column: 'TransactionNotes', sqlType: NVarChar(MAX) },
};

/**
 * An integer foreign-key id, or null. Used for `denominationId` and catalogue
 * reference ids. Real inputs include '' (empty box), "3" (CSV round trip) and
 * "Sear" (a name column mapped onto an id field). Uses Number() on the trimmed
 * string, not parseInt, so "3 sheep" is rejected rather than read as 3.
 */
export function normalizeForeignKeyId(value: unknown): number | null {
  if (value === null || value === undefined) return null;

  const text = String(value).trim();
  if (text === '') return null;

  const id = Number(text);
  return Number.isInteger(id) ? id : null;
}

/** Applies a field's normalizer (or the default) to a raw JSON value. Used by both INSERT and UPDATE. */
export function normalizeCoinValue(key: string, rawValue: unknown): unknown {
  const binding = COIN_FIELDS[key];
  if (!binding) return normalizeNullable(rawValue);
  return (binding.normalize ?? normalizeNullable)(rawValue);
}
