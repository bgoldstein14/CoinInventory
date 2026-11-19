/**
 * Parameter types for every table except Coins (see db/coin-fields.ts).
 *
 * SQLite doesn't enforce widths, so these declared lengths and decimal
 * scales are what db/bind-values.ts enforces (see db/column-types.ts). Keep
 * them in step with the trailing `-- NVARCHAR(n)` comments in db/schema.sql;
 * the parity specs compare the two.
 */

import { NVarChar, Char, Int, Bit, Decimal, MAX } from './column-types';

/** Parameter types for the non-Coins tables, grouped by table. */
export const DB_BINDINGS = {
  /** Coins.CoinId / CoinImages.CoinId */
  coinId: NVarChar(36),

  // ----- CoinImages ---------------------------------------------------
  imageData: NVarChar(MAX),   // CoinImages.ImageData  NVARCHAR(MAX)
  imageId: Int,                   // CoinImages.ImageId    INT IDENTITY
  sortOrder: Int,                 // CoinImages.SortOrder  INT

  /**
   * CoinImages.SourcePath NVARCHAR(400) NULL: absolute path of the original
   * full-resolution file, so the UI can link to it via GET /api/images/file.
   * ImageData holds the downscaled display copy.
   */
  imageSourcePath: NVarChar(400),

  // (Transactions bindings removed: purchase/sale are now Coins columns in db/coin-fields.ts.)

  // ----- SpotPrices ---------------------------------------------------
  spotPrice: Decimal(10, 2),      // Gold/Silver/Platinum  DECIMAL(10,2)
  spotCopper: Decimal(10, 4),     // Copper                DECIMAL(10,4)
  spotSource: NVarChar(200),      // Source                NVARCHAR(200)

  // ----- AppSettings --------------------------------------------------
  settingKey: NVarChar(100),      // SettingKey            NVARCHAR(100)
  settingValue: NVarChar(MAX),

  // ----- Categories / CoinSets / MetalContents ------------------------
  categoryName: NVarChar(100),    // Categories.CategoryName   NVARCHAR(100)
  setName: NVarChar(100),         // CoinSets.SetName          NVARCHAR(100)
  metalContentName: NVarChar(50), // MetalContents.Name        NVARCHAR(50)

  // ----- Issuers (migration 011) --------------------------------------
  // "Issuer" rather than "Country": e.g. the Roman Empire or the Papal States.
  issuerId: Int,
  issuerName: NVarChar(100),          // Issuers.Name     NVARCHAR(100)
  /**
   * Issuers.IsoCode CHAR(2) NULL. Bound as Char(2) so a third character is
   * rejected, not truncated. The legacy SQL Server column was fixed-width, so
   * imported values are padded and must be trimmed.
   */
  issuerIsoCode: Char(2),
  issuerKind: NVarChar(20),           // Issuers.Kind     NVARCHAR(20)
  /** Issuers.ValidFrom / ValidTo INT NULL. Negative years are valid (-509 = Roman Republic). */
  issuerYear: Int,
  issuerSortOrder: Int,

  // ----- Denominations ------------------------------------------------
  denominationId: Int,
  denominationLabel: NVarChar(100),   // Label     NVARCHAR(100)
  denominationCountry: NVarChar(100), // Country   NVARCHAR(100)
  denominationSortOrder: Int,
  /** Denominations.IssuerId INT NULL — FK to Issuers (migration 011). */
  denominationIssuerId: Int,

  // ----- MintMarks ----------------------------------------------------
  mintMarkId: Int,
  mintMarkLabel: NVarChar(20),        // Label        NVARCHAR(20)
  mintMarkDescription: NVarChar(200), // Description  NVARCHAR(200)

  // ----- Catalogs and CoinCatalogRefs ---------------------------------
  catalogId: Int,                     // Catalogs.CatalogId / CoinCatalogRefs.CatalogId
  catalogName: NVarChar(60),          // Catalogs.Name  NVARCHAR(60)
  catalogNumber: NVarChar(50),        // CoinCatalogRefs.CatalogNumber  NVARCHAR(50)
} as const;
