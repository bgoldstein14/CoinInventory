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
  /** Coins.CoinId / CoinImages.CoinId / Transactions.CoinId */
  coinId: sql.NVarChar(36),

  // ----- CoinImages ---------------------------------------------------
  imageData: sql.NVarChar(sql.MAX),   // CoinImages.ImageData  NVARCHAR(MAX)
  imageId: sql.Int,                   // CoinImages.ImageId    INT IDENTITY
  sortOrder: sql.Int,                 // CoinImages.SortOrder  INT

  /**
   * CoinImages.SourcePath  NVARCHAR(400) NULL
   *
   * The absolute path of the ORIGINAL full-resolution file on the machine that
   * hosts the app. ImageData holds a downscaled base64 copy for display; this
   * records where the real photo lives, so the UI can link to it (via
   * GET /api/images/file) and can grey the link out when the file has moved.
   *
   * 400 characters is comfortably above Windows' traditional 260-character
   * MAX_PATH. As everywhere in this file, the binding length must match the
   * column exactly: shorter silently truncates, longer makes SQL Server raise
   * error 8152. A path longer than 400 therefore surfaces as an HTTP 400 via
   * classifyDbError() rather than being quietly cut in half.
   */
  imageSourcePath: sql.NVarChar(400),

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

  // ----- Issuers (migration 011) --------------------------------------
  // Who struck the coin. "Issuer" rather than "Country" because the Roman
  // Empire, the Papal States and the German states are not countries.
  issuerId: sql.Int,
  issuerName: sql.NVarChar(100),          // Issuers.Name     NVARCHAR(100)
  /**
   * Issuers.IsoCode  CHAR(2) NULL
   *
   * *** THE ONLY FIXED-WIDTH COLUMN IN THIS SCHEMA, AND IT BITES BOTH WAYS. ***
   * Bound as Char(2), not NVarChar(2), because the column is CHAR(2): SQL
   * Server TRUNCATES 'MMR' to 'MM' and PADS 'M' to 'M ', both silently. The
   * padded one is the worse of the two — it then compares unequal to 'M'
   * everywhere, so the issuer quietly stops matching anything. The route
   * refuses anything that is not exactly two letters before it gets here;
   * this binding is the second line of that defence.
   */
  issuerIsoCode: sql.Char(2),
  issuerKind: sql.NVarChar(20),           // Issuers.Kind     NVARCHAR(20)
  /**
   * Issuers.ValidFrom / ValidTo  INT NULL
   *
   * Plain INT years, and NEGATIVE IS LEGAL: -509 is the Roman Republic.
   * A year column that rejected negatives would exclude exactly the issuers
   * the design calls first-class.
   */
  issuerYear: sql.Int,
  issuerSortOrder: sql.Int,

  // ----- Denominations ------------------------------------------------
  denominationId: sql.Int,
  denominationLabel: sql.NVarChar(100),   // Label     NVARCHAR(100)
  denominationCountry: sql.NVarChar(100), // Country   NVARCHAR(100)
  denominationSortOrder: sql.Int,
  /** Denominations.IssuerId INT NULL — FK to Issuers (migration 011). */
  denominationIssuerId: sql.Int,

  // ----- MintMarks ----------------------------------------------------
  mintMarkId: sql.Int,
  mintMarkLabel: sql.NVarChar(20),        // Label        NVARCHAR(20)
  mintMarkDescription: sql.NVarChar(200), // Description  NVARCHAR(200)

  // ----- Catalogs (migration 012) -------------------------------------
  // The reference catalogues a coin can be attributed to: Sear, RIC,
  // Hendin, Krause. Note this `catalogId` binds the Catalogs table's own
  // PRIMARY KEY, for /api/catalogs/:id -- the COIN's foreign key to it is a
  // different binding, in db/coin-fields.ts, where it also gets the
  // normalizer that keeps a CSV-round-tripped string out of an INT
  // parameter.
  catalogId: sql.Int,
  catalogName: sql.NVarChar(60),          // Catalogs.Name  NVARCHAR(60)
} as const;
