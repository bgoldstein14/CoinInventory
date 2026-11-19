-- ============================================================
-- Coin Inventory — SQLite schema
-- ============================================================
-- Applied by db/schema.ts on every open; every statement is IF NOT EXISTS, so
-- an existing database is left alone. Reference data is seeded by db/seed.ts.
-- The schema was translated from an earlier SQL Server version; the notes
-- below explain the type choices that came from that.
--
-- Type translation from SQL Server:
--
--   IDENTITY(1,1)      -> INTEGER PRIMARY KEY AUTOINCREMENT. AUTOINCREMENT
--                         stops SQLite reusing the id of a deleted top row.
--   UNIQUEIDENTIFIER   -> TEXT. CoinId may be free-form (imports); the app
--                         always supplies it, so there is no default.
--   NVARCHAR(n)        -> TEXT. SQLite doesn't enforce widths; db/bind-values.ts
--                         does, using db/bindings.ts and db/coin-fields.ts.
--   DECIMAL(p,s)       -> REAL (see below).
--   BIT                -> INTEGER NOT NULL ... CHECK (x IN (0, 1)).
--   DATETIME2          -> TEXT, ISO-8601 UTC, so text order is time order.
--   Foreign keys are declared inline (SQLite can't ALTER ADD CONSTRAINT).
--   PRAGMA foreign_keys is per connection, so db/driver.ts sets it at open.
--
-- The trailing `-- NVARCHAR(n)` / `-- DECIMAL(p,s)` comment on each column is
-- the declared SQL Server type. The parity specs parse it and compare it with
-- the bindings, so keep that format.
--
-- Collation: SQL Server's was case-insensitive; SQLite's default is
-- case-sensitive. Every text column that is compared, grouped, ordered or
-- unique uses COLLATE NOCASE (e.g. 'gold' must match 'Gold' for deletes,
-- uniqueness and usage counts). Payload columns (Notes, CertNumber,
-- CoinCatalogRefs.CatalogNumber, StorageLocation, ImageData, SourcePath, ids) stay BINARY.
-- NOCASE folds A-Z only, not accents.
--
-- Numbers: SQLite has no fixed-point type, so DECIMAL columns are REAL. The
-- app only ever handled these values as JavaScript doubles, which REAL stores
-- exactly, so values round-trip unchanged. Scaled INTEGER would need a
-- conversion at every read and write site; TEXT would need casts everywhere.
-- db/bind-values.ts reapplies SQL Server's rounding to scale and range check.
--
-- ============================================================


-- ----- Issuers -----------------------------------------------
-- "Issuer" rather than "Country": e.g. the Roman Empire or the Papal States.
-- IsoCode is often NULL. ValidFrom / ValidTo are years; negative is valid
-- (-509 = Roman Republic). Name is UNIQUE because the seed matches by name.
CREATE TABLE IF NOT EXISTS Issuers (
    IssuerId            INTEGER     PRIMARY KEY AUTOINCREMENT,
    Name                TEXT        NOT NULL COLLATE NOCASE,        -- NVARCHAR(100)
    IsoCode             TEXT        NULL     COLLATE NOCASE,        -- CHAR(2)
    Kind                TEXT        NOT NULL COLLATE NOCASE,        -- NVARCHAR(20)   'modern' | 'historical' | 'ancient'
    ValidFrom           INTEGER     NULL,                           -- INT
    ValidTo             INTEGER     NULL,                           -- INT
    SortOrder           INTEGER     NOT NULL DEFAULT 0,             -- INT
    IsActive            INTEGER     NOT NULL DEFAULT 1 CHECK (IsActive IN (0, 1)),   -- BIT
    CONSTRAINT UQ_Issuers_Name UNIQUE (Name)
);

-- ----- Denominations -----------------------------------------
-- FaceValue is NULL when there is none (e.g. a Denarius). It is comparable
-- only within one currency era of one issuer (France has 1 Franc and 1 Euro),
-- so sort a whole issuer by SortOrder. No cascade: issuers are soft-deleted.
CREATE TABLE IF NOT EXISTS Denominations (
    DenominationId      INTEGER     PRIMARY KEY AUTOINCREMENT,
    Label               TEXT        NOT NULL COLLATE NOCASE,        -- NVARCHAR(100)
    Country             TEXT        NOT NULL COLLATE NOCASE,        -- NVARCHAR(100)
    IssuerId            INTEGER     NULL,                           -- INT
    FaceValue           REAL        NULL,                           -- DECIMAL(18,6)
    SortOrder           INTEGER     NOT NULL,                       -- INT
    IsActive            INTEGER     NOT NULL DEFAULT 1 CHECK (IsActive IN (0, 1)),   -- BIT
    CONSTRAINT FK_Denominations_Issuer
        FOREIGN KEY (IssuerId) REFERENCES Issuers (IssuerId)
);

-- ----- Catalogs ----------------------------------------------
-- Reference catalogues a coin can be attributed to (Sear, RIC, Hendin, Krause).
CREATE TABLE IF NOT EXISTS Catalogs (
    CatalogId           INTEGER     PRIMARY KEY AUTOINCREMENT,
    Name                TEXT        NOT NULL COLLATE NOCASE,        -- NVARCHAR(60)
    SortOrder           INTEGER     NOT NULL DEFAULT 0,             -- INT
    IsActive            INTEGER     NOT NULL DEFAULT 1 CHECK (IsActive IN (0, 1))    -- BIT
);

-- ----- Coins -------------------------------------------------
-- Denomination is the text the user or import source gave; DenominationId is
-- the canonical link (NULL is normal). Nothing rewrites Denomination.
-- Weight is in grams. CollectionStatus values are validated in
-- db/collection-status.ts. No cascade on the foreign keys: deleting a
-- catalogue or denomination must never delete or silently unlink coins.
CREATE TABLE IF NOT EXISTS Coins (
    CoinId              TEXT        NOT NULL PRIMARY KEY,           -- NVARCHAR(36)   was UNIQUEIDENTIFIER
    Denomination        TEXT        NULL     COLLATE NOCASE,        -- NVARCHAR(100)  as recorded, never rewritten
    DenominationId      INTEGER     NULL,                           -- INT
    Year                TEXT        NULL     COLLATE NOCASE,        -- NVARCHAR(50)   text, to allow "1878-S"
    CoinType            TEXT        NULL     COLLATE NOCASE,        -- NVARCHAR(100)
    Category            TEXT        NULL     COLLATE NOCASE,        -- NVARCHAR(100)
    Country             TEXT        NULL     COLLATE NOCASE,        -- NVARCHAR(100)
    Grade               TEXT        NULL,                           -- NVARCHAR(50)
    CertCompany         TEXT        NULL,                           -- NVARCHAR(100)
    CertNumber          TEXT        NULL,                           -- NVARCHAR(100)
    Variety             TEXT        NULL,                           -- NVARCHAR(100)
    MintMark            TEXT        NULL     COLLATE NOCASE,        -- NVARCHAR(20)
    Composition         TEXT        NULL,                           -- NVARCHAR(100)
    PurchaseDate        TEXT        NULL,                           -- NVARCHAR(30)   text, not a date
    PurchasePrice       REAL        NULL,                           -- DECIMAL(12,2)
    CurrentValue        REAL        NULL,                           -- DECIMAL(12,2)
    Notes               TEXT        NULL,                           -- NVARCHAR(MAX)
    Source              TEXT        NULL     COLLATE NOCASE,        -- NVARCHAR(50)   'manual', 'import', 'csv'
    HasCacSticker       INTEGER     NOT NULL DEFAULT 0 CHECK (HasCacSticker IN (0, 1)),  -- BIT
    SoldPrice           REAL        NULL,                           -- DECIMAL(12,2)
    SoldDate            TEXT        NULL,                           -- NVARCHAR(30)
    Weight              REAL        NULL,                           -- DECIMAL(12,5)  GRAMS, gross
    MetalContent        TEXT        NULL     COLLATE NOCASE,        -- NVARCHAR(50)
    PmWeightGrams       REAL        NULL,                           -- DECIMAL(12,5)  GRAMS, precious metal only
    PmPercent           REAL        NULL,                           -- DECIMAL(5,2)
    CoinSet             TEXT        NULL     COLLATE NOCASE,        -- NVARCHAR(100)
    CollectionStatus    TEXT        NOT NULL DEFAULT 'owned' COLLATE NOCASE,   -- NVARCHAR(20)
    StorageLocation     TEXT        NULL,                           -- NVARCHAR(200)
    -- ----- Acquisition / disposal record ------------------------
    -- PurchaseDate, PurchasePrice ("Cost"), SoldDate and SoldPrice are above.
    -- TransactionNotes is the note on the deal, separate from the coin's Notes.
    PurchasedFrom       TEXT        NULL,                           -- NVARCHAR(200)  who the coin was bought FROM
    SoldTo              TEXT        NULL,                           -- NVARCHAR(200)  who the coin was sold TO
    TransactionNotes    TEXT        NULL,                           -- NVARCHAR(MAX)  the DEAL's note, NOT the coin's
    CONSTRAINT FK_Coins_Denomination
        FOREIGN KEY (DenominationId) REFERENCES Denominations (DenominationId)
);

-- ----- CoinImages --------------------------------------------
-- One row per photo; SortOrder is the zero-based display position. ImageData
-- is a downscaled base64 copy for display; SourcePath is the full-resolution
-- original on this machine (NULL for older imports). Deleting a coin deletes
-- its photos (ON DELETE CASCADE).
CREATE TABLE IF NOT EXISTS CoinImages (
    ImageId             INTEGER     PRIMARY KEY AUTOINCREMENT,
    CoinId              TEXT        NOT NULL,                       -- NVARCHAR(36)
    ImageData           TEXT        NULL,                           -- NVARCHAR(MAX)  base64 data URL
    SortOrder           INTEGER     NOT NULL DEFAULT 0,             -- INT
    SourcePath          TEXT        NULL,                           -- NVARCHAR(400)
    CONSTRAINT FK_CoinImages_Coin
        FOREIGN KEY (CoinId) REFERENCES Coins (CoinId) ON DELETE CASCADE
);

-- ----- CoinCatalogRefs ---------------------------------------
-- A coin's catalogue references (Sear 6819, RIC 123, ...), in SortOrder.
-- CatalogId is NULL when only a number was given. CatalogNumber is stored as
-- typed. Deleting a coin deletes its references; catalogues are soft-deleted.
CREATE TABLE IF NOT EXISTS CoinCatalogRefs (
    RefId               INTEGER     PRIMARY KEY AUTOINCREMENT,
    CoinId              TEXT        NOT NULL,                       -- NVARCHAR(36)
    CatalogId           INTEGER     NULL,                           -- INT
    CatalogNumber       TEXT        NOT NULL,                       -- NVARCHAR(50)
    SortOrder           INTEGER     NOT NULL DEFAULT 0,             -- INT
    CONSTRAINT FK_CoinCatalogRefs_Coin
        FOREIGN KEY (CoinId) REFERENCES Coins (CoinId) ON DELETE CASCADE,
    CONSTRAINT FK_CoinCatalogRefs_Catalog
        FOREIGN KEY (CatalogId) REFERENCES Catalogs (CatalogId)
);

-- (The old Transactions table is gone; its data lives on Coins. Don't re-add
-- it here: it would be recreated in every existing database on next open.)

-- ----- Categories --------------------------------------------
-- User-defined category names. Hard-deleted from the maintenance screen.
CREATE TABLE IF NOT EXISTS Categories (
    CategoryName        TEXT        NOT NULL COLLATE NOCASE PRIMARY KEY  -- NVARCHAR(100)
);

-- ----- CoinSets ----------------------------------------------
CREATE TABLE IF NOT EXISTS CoinSets (
    SetName             TEXT        NOT NULL COLLATE NOCASE PRIMARY KEY  -- NVARCHAR(100)
);

-- ----- SpotPrices --------------------------------------------
-- Precious metal spot prices, one row per save; the latest is the one with
-- the highest FetchedAt.
CREATE TABLE IF NOT EXISTS SpotPrices (
    SpotPriceId         INTEGER     PRIMARY KEY AUTOINCREMENT,
    Gold                REAL        NOT NULL DEFAULT 0,             -- DECIMAL(10,2)  USD per troy oz
    Silver              REAL        NOT NULL DEFAULT 0,             -- DECIMAL(10,2)
    Platinum            REAL        NOT NULL DEFAULT 0,             -- DECIMAL(10,2)
    Copper              REAL        NOT NULL DEFAULT 0,             -- DECIMAL(10,4)
    Source              TEXT        NULL,                           -- NVARCHAR(200)
    FetchedAt           TEXT        NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))             -- DATETIME2      was GETDATE()
);

-- ----- AppSettings -------------------------------------------
-- Key/value store for UI preferences, backup metadata and migration markers.
CREATE TABLE IF NOT EXISTS AppSettings (
    SettingKey          TEXT        NOT NULL PRIMARY KEY,           -- NVARCHAR(100)
    SettingValue        TEXT        NULL                            -- NVARCHAR(MAX)
);

-- ----- MintMarks ---------------------------------------------
CREATE TABLE IF NOT EXISTS MintMarks (
    MintMarkId          INTEGER     PRIMARY KEY AUTOINCREMENT,
    Label               TEXT        NOT NULL COLLATE NOCASE,        -- NVARCHAR(20)
    Description         TEXT        NULL,                           -- NVARCHAR(200)
    IsActive            INTEGER     NOT NULL DEFAULT 1 CHECK (IsActive IN (0, 1))    -- BIT
);

-- ----- MetalContents -----------------------------------------
CREATE TABLE IF NOT EXISTS MetalContents (
    MetalContentId      INTEGER     PRIMARY KEY AUTOINCREMENT,
    MetalContentName    TEXT        NOT NULL COLLATE NOCASE UNIQUE, -- NVARCHAR(50)
    SortOrder           INTEGER     NOT NULL DEFAULT 999,           -- INT
    IsActive            INTEGER     NOT NULL DEFAULT 1 CHECK (IsActive IN (0, 1))    -- BIT
);

-- ============================================================
-- INDEXES
-- ============================================================
-- (CoinId, SortOrder) serves "this coin's photos, in order" and lets the
-- imageCount COUNT(*) in routes/coins/list-query.ts skip the image data.
CREATE INDEX IF NOT EXISTS IX_CoinImages_CoinId_SortOrder ON CoinImages (CoinId, SortOrder);
CREATE INDEX IF NOT EXISTS IX_Coins_Category        ON Coins (Category);
CREATE INDEX IF NOT EXISTS IX_Coins_Grade           ON Coins (Grade);
CREATE INDEX IF NOT EXISTS IX_Coins_Year            ON Coins (Year);
CREATE INDEX IF NOT EXISTS IX_Coins_CoinSet         ON Coins (CoinSet);
CREATE INDEX IF NOT EXISTS IX_Coins_MetalContent    ON Coins (MetalContent);
CREATE INDEX IF NOT EXISTS IX_Coins_CoinType        ON Coins (CoinType);
CREATE INDEX IF NOT EXISTS IX_Denominations_IssuerId ON Denominations (IssuerId);
CREATE INDEX IF NOT EXISTS IX_Coins_DenominationId  ON Coins (DenominationId);
CREATE INDEX IF NOT EXISTS IX_CoinCatalogRefs_CoinId_SortOrder ON CoinCatalogRefs (CoinId, SortOrder);
CREATE INDEX IF NOT EXISTS IX_CoinCatalogRefs_CatalogId ON CoinCatalogRefs (CatalogId);
