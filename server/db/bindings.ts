/**
 * db/bindings.ts — parameter types for every table EXCEPT Coins.
 *
 * The Coins table has its own richer description in db/coin-fields.ts (it needs
 * per-column defaults and normalizers because INSERT and UPDATE are generated
 * from it). Everything else just needs "which type do I bind this parameter
 * as", which is what this file provides.
 *
 * *** WHY THIS TABLE SURVIVED THE MOVE TO SQLITE, WHICH IS DYNAMICALLY
 * TYPED. *** It is the only machine-readable record of what each column is
 * FOR — how wide it is, how many decimals it keeps. db/bind-values.ts
 * enforces it on the way in, so a value SQL Server would have refused is
 * still refused with an HTTP 400 instead of being stored and discovered
 * later. The full argument is in the header of db/column-types.ts.
 *
 * The rule to keep in mind has changed slightly and is worth stating plainly:
 * a length declared SHORTER than the real column now REJECTS a legitimate
 * value (where mssql silently truncated it), and one declared LONGER lets an
 * over-long value through. Both are wrong; keep these in step with
 * db/schema.sql, whose trailing `-- NVARCHAR(n)` comments the parity specs
 * compare against.
 */

import { NVarChar, Char, Int, Bit, Decimal, MAX } from './column-types';

/**
 * Parameter types for the non-Coins tables, again mirroring db/schema.sql.
 * Grouped by table so a schema change has one obvious place to land.
 */
export const DB_BINDINGS = {
  /** Coins.CoinId / CoinImages.CoinId / Transactions.CoinId */
  coinId: NVarChar(36),

  // ----- CoinImages ---------------------------------------------------
  imageData: NVarChar(MAX),   // CoinImages.ImageData  NVARCHAR(MAX)
  imageId: Int,                   // CoinImages.ImageId    INT IDENTITY
  sortOrder: Int,                 // CoinImages.SortOrder  INT

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
  imageSourcePath: NVarChar(400),

  // ----- Transactions -------------------------------------------------
  transactionId: NVarChar(36),    // TransactionId         UNIQUEIDENTIFIER (bound as text)
  transactionType: NVarChar(50),  // TransactionType       NVARCHAR(50)
  transactionDate: NVarChar(30),  // TransactionDate       NVARCHAR(30)  <- text, not DATE
  transactionAmount: Decimal(12, 2),
  transactionDealer: NVarChar(200), // Dealer              NVARCHAR(200)
  transactionNotes: NVarChar(MAX),

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
  // Who struck the coin. "Issuer" rather than "Country" because the Roman
  // Empire, the Papal States and the German states are not countries.
  issuerId: Int,
  issuerName: NVarChar(100),          // Issuers.Name     NVARCHAR(100)
  /**
   * Issuers.IsoCode  CHAR(2) NULL
   *
   * *** THE ONLY FIXED-WIDTH COLUMN IN THIS SCHEMA. IT USED TO BITE BOTH
   * WAYS; NOW IT BITES ONE. *** Under SQL Server a CHAR(2) silently
   * TRUNCATED 'MMR' to 'MM' and silently PADDED 'M' to 'M '. The padding was
   * the worse of the two: the value then compared unequal to 'M' everywhere,
   * so the issuer quietly stopped matching anything.
   *
   * SQLite's TEXT stores exactly the characters it is given, so NOTHING PADS
   * and that failure mode is gone. Declaring it Char(2) rather than
   * NVarChar(2) is kept anyway, for two reasons: it still records that the
   * column is two characters wide (db/bind-values.ts rejects a third rather
   * than truncating to it), and it is the only surviving note that the
   * source column was fixed-width, which Stage 2's import needs to know
   * because the rows it reads out of SQL Server ARE padded and must be
   * trimmed on the way in. The route refuses anything that is not exactly
   * two letters before it gets here; this binding is the second line of that
   * defence.
   */
  issuerIsoCode: Char(2),
  issuerKind: NVarChar(20),           // Issuers.Kind     NVARCHAR(20)
  /**
   * Issuers.ValidFrom / ValidTo  INT NULL
   *
   * Plain INT years, and NEGATIVE IS LEGAL: -509 is the Roman Republic.
   * A year column that rejected negatives would exclude exactly the issuers
   * the design calls first-class.
   */
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

  // ----- Catalogs (migration 012) -------------------------------------
  // The reference catalogues a coin can be attributed to: Sear, RIC,
  // Hendin, Krause. Note this `catalogId` binds the Catalogs table's own
  // PRIMARY KEY, for /api/catalogs/:id -- the COIN's foreign key to it is a
  // different binding, in db/coin-fields.ts, where it also gets the
  // normalizer that keeps a CSV-round-tripped string out of an INT
  // parameter.
  catalogId: Int,
  catalogName: NVarChar(60),          // Catalogs.Name  NVARCHAR(60)
} as const;
