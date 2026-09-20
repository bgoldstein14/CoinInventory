/**
 * db/bindings.ts — parameter types for every table EXCEPT Coins.
 *
 * The Coins table has its own richer description in db/coin-fields.ts (it needs
 * per-column defaults and normalizers because INSERT and UPDATE are generated
 * from it). Everything else just needs "which mssql type do I bind this
 * parameter as", which is what this file provides.
 *
 * The same rule from db/coin-fields.ts applies here and is worth repeating:
 * a parameter declared SHORTER than its column silently truncates the user's
 * data, and one declared LONGER makes SQL Server raise error 8152 and abort the
 * statement. Keep these in step with setup-database.sql.
 */

import sql from 'mssql';

/**
 * Parameter types for the non-Coins tables, again mirroring setup-database.sql.
 * Grouped by table so a schema change has one obvious place to land.
 */
export const DB_BINDINGS = {
  /** Coins.CoinId / CoinImages.CoinId / CoinTags.CoinId / Transactions.CoinId */
  coinId: sql.NVarChar(36),

  // ----- CoinImages ---------------------------------------------------
  imageData: sql.NVarChar(sql.MAX),   // CoinImages.ImageData  NVARCHAR(MAX)
  imageId: sql.Int,                   // CoinImages.ImageId    INT IDENTITY
  sortOrder: sql.Int,                 // CoinImages.SortOrder  INT

  // ----- CoinTags -----------------------------------------------------
  tag: sql.NVarChar(100),             // CoinTags.Tag          NVARCHAR(100)

  // ----- Transactions -------------------------------------------------
  transactionId: sql.NVarChar(36),    // TransactionId         UNIQUEIDENTIFIER (bound as text)
  transactionType: sql.NVarChar(50),  // TransactionType       NVARCHAR(50)
  transactionDate: sql.NVarChar(30),  // TransactionDate       NVARCHAR(30)  <- text, not DATE
  transactionAmount: sql.Decimal(12, 2),
  transactionDealer: sql.NVarChar(200), // Dealer              NVARCHAR(200)
  transactionNotes: sql.NVarChar(sql.MAX),

  // ----- SpotPrices ---------------------------------------------------
  spotPrice: sql.Decimal(10, 2),      // Gold/Silver/Platinum  DECIMAL(10,2)
  spotCopper: sql.Decimal(10, 4),     // Copper                DECIMAL(10,4)
  spotSource: sql.NVarChar(200),      // Source                NVARCHAR(200)

  // ----- AppSettings --------------------------------------------------
  settingKey: sql.NVarChar(100),      // SettingKey            NVARCHAR(100)
  settingValue: sql.NVarChar(sql.MAX),

  // ----- Categories / CoinSets / MetalContents ------------------------
  categoryName: sql.NVarChar(100),    // Categories.CategoryName   NVARCHAR(100)
  setName: sql.NVarChar(100),         // CoinSets.SetName          NVARCHAR(100)
  metalContentName: sql.NVarChar(50), // MetalContents.Name        NVARCHAR(50)

  // ----- Denominations ------------------------------------------------
  denominationId: sql.Int,
  denominationLabel: sql.NVarChar(100),   // Label     NVARCHAR(100)
  denominationCountry: sql.NVarChar(100), // Country   NVARCHAR(100)
  denominationSortOrder: sql.Int,

  // ----- MintMarks ----------------------------------------------------
  mintMarkId: sql.Int,
  mintMarkLabel: sql.NVarChar(20),        // Label        NVARCHAR(20)
  mintMarkDescription: sql.NVarChar(200), // Description  NVARCHAR(200)
} as const;
