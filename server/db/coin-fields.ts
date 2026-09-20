/**
 * db/coin-fields.ts — the Coins table, column by column.
 *
 * ============================================================
 * Column bindings — the SINGLE source of truth for parameter types
 * ============================================================
 *
 * Every `.input(name, type, value)` call in the route modules must use a type
 * that matches setup-database.sql *exactly*:
 *
 *   - Declaring a parameter SHORTER than the column silently truncates the
 *     user's data (mssql trims the value to the declared length before it ever
 *     reaches SQL Server — no error, just missing characters).
 *   - Declaring a parameter LONGER than the column makes SQL Server raise
 *     error 8152 / 2628 "String or binary data would be truncated", which
 *     aborts the whole transaction.
 *
 * Both used to happen here, and under the old code every one of those failures
 * also called resetPool(), which killed the shared pool for every request.
 * Keeping the types in one place is what stops INSERT and UPDATE drifting
 * apart again — change a column in setup-database.sql, change it here, done.
 * (db/coin-fields.spec.ts parses setup-database.sql and fails the build if the
 * two ever disagree.)
 *
 * NOTE ON CoinId: the schema declares CoinId as UNIQUEIDENTIFIER but we bind it
 * as NVarChar(36) and let SQL Server do the implicit conversion. That is
 * deliberate and unchanged: switching to sql.UniqueIdentifier would make the
 * driver reject any id that is not a well-formed GUID, and the Quicken import
 * path and some existing rows use free-form ids. Revisit only as a dedicated
 * change that migrates the data and every CoinId parameter at once.
 * (The CoinId binding itself lives in db/bindings.ts with the other tables.)
 */

import sql from 'mssql';
import { normalizeNullable, normalizeTextDate } from './value-normalizers';

/** Describes how one JSON field maps onto one SQL Server column. */
export interface CoinColumnBinding {
  /** SQL Server column name in the Coins table. */
  column: string;
  /** mssql parameter type. MUST match setup-database.sql. */
  sqlType: sql.ISqlType | (() => sql.ISqlType);
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
  denomination:  { column: 'Denomination',  sqlType: sql.NVarChar(100), maxLength: 100 },
  year:          { column: 'Year',          sqlType: sql.NVarChar(50),  maxLength: 50 },
  coinType:      { column: 'CoinType',      sqlType: sql.NVarChar(100), maxLength: 100 },
  category:      { column: 'Category',      sqlType: sql.NVarChar(100), maxLength: 100 },
  country:       { column: 'Country',       sqlType: sql.NVarChar(100), maxLength: 100 },
  grade:         { column: 'Grade',         sqlType: sql.NVarChar(50),  maxLength: 50 },
  certCompany:   { column: 'CertCompany',   sqlType: sql.NVarChar(100), maxLength: 100 },
  certNumber:    { column: 'CertNumber',    sqlType: sql.NVarChar(100), maxLength: 100 },
  variety:       { column: 'Variety',       sqlType: sql.NVarChar(100), maxLength: 100 },
  mintMark:      { column: 'MintMark',      sqlType: sql.NVarChar(20),  maxLength: 20 },
  composition:   { column: 'Composition',   sqlType: sql.NVarChar(100), maxLength: 100 },
  purchaseDate:  { column: 'PurchaseDate',  sqlType: sql.NVarChar(30),  maxLength: 30, normalize: normalizeTextDate },
  purchasePrice: { column: 'PurchasePrice', sqlType: sql.Decimal(12, 2) },
  currentValue:  { column: 'CurrentValue',  sqlType: sql.Decimal(12, 2) },
  notes:         { column: 'Notes',         sqlType: sql.NVarChar(sql.MAX) },
  source:        { column: 'Source',        sqlType: sql.NVarChar(50),  maxLength: 50, insertDefault: 'manual' },
  hasCacSticker: {
    column: 'HasCacSticker',
    sqlType: sql.Bit,
    // HasCacSticker is BIT NOT NULL DEFAULT 0 — never bind null to it.
    normalize: (value) => (value ? 1 : 0),
    insertDefault: 0,
  },
  soldPrice:     { column: 'SoldPrice',     sqlType: sql.Decimal(12, 2) },
  soldDate:      { column: 'SoldDate',      sqlType: sql.NVarChar(30),  maxLength: 30, normalize: normalizeTextDate },
  dealer:        { column: 'Dealer',        sqlType: sql.NVarChar(200), maxLength: 200 },
  weight:        { column: 'Weight',        sqlType: sql.Decimal(10, 4) },
  metalContent:  { column: 'MetalContent',  sqlType: sql.NVarChar(50),  maxLength: 50 },
  pmWeightGrams: { column: 'PmWeightGrams', sqlType: sql.Decimal(10, 4) },
  pmPercent:     { column: 'PmPercent',     sqlType: sql.Decimal(5, 2) },
  coinSet:       { column: 'CoinSet',       sqlType: sql.NVarChar(100), maxLength: 100 },
};

/**
 * Applies a field's normalizer (or the default one) to a raw JSON value.
 * Exported so both the INSERT and the UPDATE path use identical conversion.
 */
export function normalizeCoinValue(key: string, rawValue: unknown): unknown {
  const binding = COIN_FIELDS[key];
  if (!binding) return normalizeNullable(rawValue);
  return (binding.normalize ?? normalizeNullable)(rawValue);
}
