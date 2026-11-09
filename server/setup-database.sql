-- ============================================================
-- Coin Inventory Database Setup Script
-- ============================================================
-- Purpose: Complete schema initialization for coin inventory
-- Database: CoinInventory
-- Server: MYSERVER\SQLEXPRESS
-- Conventions: CamelCase table/column names, UNIQUEIDENTIFIER PKs
-- ============================================================

-- Switch to master database to create our database if needed
USE master;
GO

-- Create the CoinInventory database if it doesn't exist yet
IF NOT EXISTS (SELECT name FROM sys.databases WHERE name = 'CoinInventory')
BEGIN
    CREATE DATABASE CoinInventory;
END
GO

-- Switch to our database for all subsequent operations
USE CoinInventory;
GO

-- ============================================================
-- DROP EXISTING TABLES (in reverse dependency order)
-- ============================================================
-- We drop tables in reverse FK order to avoid constraint violations
-- This allows the script to be re-run safely

IF OBJECT_ID('Transactions', 'U') IS NOT NULL DROP TABLE Transactions;
-- CoinTags used to be dropped here. The tag feature was removed and the table
-- is no longer created below, so there is nothing to drop on a fresh build.
-- An EXISTING database still has the table; migrations/005-drop-coin-tags.sql
-- removes it there (safely -- it refuses to drop a table that has rows).
IF OBJECT_ID('CoinImages', 'U') IS NOT NULL DROP TABLE CoinImages;
IF OBJECT_ID('Coins', 'U') IS NOT NULL DROP TABLE Coins;
-- AFTER Coins, never before it: Coins.CatalogId has a foreign key pointing
-- here, and dropping the referenced table first fails outright and leaves
-- this script half-applied. (Migration 012 adds both to an existing
-- database.)
IF OBJECT_ID('Catalogs', 'U') IS NOT NULL DROP TABLE Catalogs;
IF OBJECT_ID('Categories', 'U') IS NOT NULL DROP TABLE Categories;
IF OBJECT_ID('CoinSets', 'U') IS NOT NULL DROP TABLE CoinSets;
IF OBJECT_ID('SpotPrices', 'U') IS NOT NULL DROP TABLE SpotPrices;
IF OBJECT_ID('AppSettings', 'U') IS NOT NULL DROP TABLE AppSettings;
IF OBJECT_ID('Denominations', 'U') IS NOT NULL DROP TABLE Denominations;
-- Issuers comes AFTER Denominations: Denominations carries FK_Denominations_Issuer
-- pointing at it, so dropping Issuers first fails on the constraint and the
-- whole re-run stops half way. (Coins is already dropped further up, which is
-- what lets Denominations go before Issuers here -- FK_Coins_Denomination
-- points the other way.)
IF OBJECT_ID('Issuers', 'U') IS NOT NULL DROP TABLE Issuers;
IF OBJECT_ID('MintMarks', 'U') IS NOT NULL DROP TABLE MintMarks;
GO

-- ============================================================
-- CREATE TABLES
-- ============================================================

-- ----- Coins -------------------------------------------------
-- Main table storing individual coin records
-- Uses UNIQUEIDENTIFIER for globally unique IDs
CREATE TABLE Coins (
    CoinId              UNIQUEIDENTIFIER    NOT NULL PRIMARY KEY DEFAULT NEWID(),
    -- *** THESE TWO COLUMNS ARE A PAIR AND BOTH ARE DELIBERATE. ***
    -- Denomination is no longer the authority; as of migration 011 it means
    -- WHAT THE SOURCE SAID -- typed by the user, or read out of a QIF, a CSV
    -- or a spreadsheet. DenominationId is the canonical link, when one could
    -- be established, and NULL is a normal state rather than an error.
    --
    -- Keeping the text was the owner's decision and it is load-bearing.
    -- Everything in this application arrives by import; a QIF security
    -- reading "Trade Dollar", or a spreadsheet column reading "8 Reales"
    -- before Mexico is seeded, resolves to nothing. Under an id-only model
    -- that string is destroyed at import and neither the user nor a later,
    -- smarter resolver can recover it.
    --
    -- Nothing rewrites Denomination. Not the migration (014 reads it and
    -- does not touch it), not the importers. The one place that decides what
    -- the pair READS AS is src/app/services/denominations/
    -- denomination-display.ts: id set -> the Label, id null and text present
    -- -> "Other (8 Reales)", both empty -> an em dash.
    Denomination        NVARCHAR(100)       NULL,           -- e.g., "1¢", "Quarter", "Sovereign" -- as recorded, never rewritten
    DenominationId      INT                 NULL,           -- FK to Denominations; NULL = never resolved (migration 011)
    Year                NVARCHAR(50)        NULL,           -- Stored as text to allow ranges like "1878-S"
    CoinType            NVARCHAR(100)       NULL,           -- e.g., "Morgan Dollar", "Lincoln Cent"
    Category            NVARCHAR(100)       NULL,           -- User-defined category grouping
    Country             NVARCHAR(100)       NULL,           -- e.g., "US", "GB", "Canada"
    Grade               NVARCHAR(50)        NULL,           -- e.g., "MS65", "AU50", "VF20"
    CertCompany         NVARCHAR(100)       NULL,           -- Certification company: PCGS, NGC, etc.
    CertNumber          NVARCHAR(100)       NULL,           -- Certification serial number
    Variety             NVARCHAR(100)       NULL,           -- Special varieties: VAM, DDO, etc.
    MintMark            NVARCHAR(20)        NULL,           -- e.g., "D", "S", "CC", blank for none
    Composition         NVARCHAR(100)       NULL,           -- Metal composition description
    PurchaseDate        NVARCHAR(30)        NULL,           -- Date acquired (stored as text for flexibility)
    PurchasePrice       DECIMAL(12,2)       NULL,           -- What you paid for it
    CurrentValue        DECIMAL(12,2)       NULL,           -- Estimated current market value
    Notes               NVARCHAR(MAX)       NULL,           -- Free-form notes
    Source              NVARCHAR(50)        NULL,           -- How added: 'manual', 'import', 'csv'
    HasCacSticker       BIT                 NOT NULL DEFAULT 0,  -- CAC (Certified Acceptance Corp) sticker
    SoldPrice           DECIMAL(12,2)       NULL,           -- Price if sold
    SoldDate            NVARCHAR(30)        NULL,           -- Date sold
    -- NOTE: a `Dealer NVARCHAR(200) NULL` column used to sit here, recording
    -- who a coin came from. It was removed at the owner's request; the same
    -- information is already held per event in Transactions.Dealer, which is a
    -- DIFFERENT column further down this file and is still in use.
    -- Migration 006-drop-coin-dealer.sql removes it from existing databases.
    -- Five decimals, matching what the coin editor displays. Widened from
    -- (10,4) by migration 004. This is the coin's GROSS weight -- the whole
    -- coin, alloy included. The PURE precious-metal content is PmWeightGrams
    -- below; the two measure different things, but as of migration 008 they
    -- are at least in the SAME UNIT.
    --
    -- *** THIS COLUMN USED TO BE TROY OUNCES. ***
    -- It is GRAMS now. The owner always read it as grams, and rather than
    -- correct the reading, the column was moved to match -- so that Weight
    -- and PmWeightGrams can be compared and divided without a conversion in
    -- the reader's head. migrations/008-weight-to-grams.sql multiplies the
    -- existing values by 31.1034768 and guards itself with an AppSettings
    -- marker row, because nothing in the column itself can reveal whether it
    -- has already been converted. A database built fresh from THIS file has
    -- never held troy ounces and needs no conversion.
    Weight              DECIMAL(12,5)       NULL,           -- Gross weight in GRAMS (was troy ounces before migration 008)
    MetalContent        NVARCHAR(50)        NULL,           -- Primary metal: "Gold", "Silver", "Platinum"
    -- Five decimal places, matching what the coin editor displays (0.00000).
    -- It was DECIMAL(10,4), which silently rounded away the fifth digit the
    -- field offered to accept. Migration 004 widens an existing database.
    -- NOTE: this is the weight of the PURE precious metal, not the coin's
    -- gross weight -- see services/pm-reference.ts and computeMeltValue.
    PmWeightGrams       DECIMAL(12,5)       NULL,           -- Precious metal weight in grams
    PmPercent           DECIMAL(5,2)        NULL,           -- Precious metal percentage (e.g., 90.00 for 90%)
    CoinSet             NVARCHAR(100)       NULL,           -- Set membership (FK to CoinSets)
    -- ===== Where this coin sits in the collecting cycle ======================
    -- One of exactly five values: 'owned', 'wanted', 'ordered', 'for-sale',
    -- 'sold'. The list, and the argument for those five, lives in
    -- src/app/types/collection-status.ts; the server's copy of it is in
    -- server/db/collection-status.ts and a spec there fails the build if the
    -- two ever disagree.
    --
    -- *** NOT NULL WITH A DEFAULT OF 'owned', AND BOTH HALVES MATTER. ***
    -- This column decides whether a coin counts towards the value of the
    -- collection and whether it appears on the insurance schedule. A NULL
    -- would be a third answer to a yes/no question, and every reader would
    -- have to decide for itself what to do with it -- which is how two parts
    -- of an app end up disagreeing about what the user owns. The DEFAULT is
    -- what makes an INSERT written before this column existed still work, and
    -- makes it mean the right thing.
    --
    -- NVARCHAR(20) rather than a lookup table or a CHECK constraint:
    --   * a lookup table would be a join and a seed script for five words
    --     that are part of the application's logic, not the user's data --
    --     unlike Categories or CoinSets, the user cannot invent a sixth;
    --   * a CHECK constraint would have to be dropped and recreated every
    --     time a value is added, from a migration that can only guess at the
    --     constraint's generated name on a database it has never seen. The
    --     server validates instead, in one function, on the way in.
    -- 20 characters leaves room for a longer future token without an ALTER.
    --
    -- Migration 010 adds this column (and the next) to an existing database.
    CollectionStatus    NVARCHAR(20)        NOT NULL DEFAULT 'owned',
    -- Where the physical coin is: "Safe deposit box 2", "Dansco 7070, page 4".
    -- FREE TEXT, NULLABLE, NO VALIDATION AND NO LOOKUP TABLE, on purpose --
    -- every collector organises differently and any structure imposed here
    -- would be wrong for most of them. NOT the same thing as CoinSet above:
    -- a set is a conceptual grouping a coin belongs to wherever it lives,
    -- this is the shelf you walk to. A coin is routinely in both.
    -- 200 characters: long enough for "Safe deposit box 2, tray 3, slot 12"
    -- and well short of anything that belongs in Notes.
    StorageLocation     NVARCHAR(200)       NULL,
    -- ===== The catalogue reference: "Sear 6819"  (migration 012) ============
    -- Two columns for one idea. CatalogId says WHICH catalogue (a row in the
    -- Catalogs lookup further down this file); CatalogNumber is the
    -- reference within it, stored EXACTLY as typed -- "1A", "6819",
    -- "II.1 234", "RRC 44/5". Nothing in the application upper-cases it,
    -- strips its punctuation or collapses its spaces: a reference the app
    -- tidied is a reference that no longer matches the book.
    --
    -- WHY THIS EXISTS. Ancients have no year, no denomination and no grade,
    -- so the catalogue reference is frequently the ONLY thing identifying
    -- the coin. The owner is already recording them -- in the Variety column
    -- above, for want of anywhere else (see coin-signature.ts, which
    -- documents a live record whose Variety reads "Sear 6819"). Migration
    -- 012 does NOT move those; the user does, one coin at a time, because
    -- only he can tell a reference from a real variety.
    --
    -- BOTH NULLABLE, NEITHER DEFAULTED. Almost no coin has a catalogue
    -- reference and almost none ever will; NULL is the honest and
    -- overwhelmingly common state, and a default would attribute the whole
    -- collection to a catalogue nobody chose.
    --
    -- NVARCHAR(50) is mirrored by CATALOG_NUMBER_MAX_LENGTH in
    -- src/app/types/catalog-reference.ts and by the binding in
    -- server/db/coin-fields.ts; migration-012.spec.ts asserts all of them
    -- against this file.
    --
    -- FK_Coins_Catalog is added by an ALTER further down rather than written
    -- inline here, because Catalogs is created AFTER this table.
    CatalogId           INT                 NULL,           -- FK to Catalogs; NULL = no catalogue chosen
    CatalogNumber       NVARCHAR(50)        NULL            -- The reference within that catalogue, as typed
);

-- ----- CoinImages --------------------------------------------
-- MANY photos per coin: one ROW per photo, not one column per photo.
--
-- This is the whole mechanism for "multiple pictures per coin". A coin with ten
-- photos is ten rows here, all sharing the same CoinId. There is deliberately
-- no limit on how many a coin may have, and nothing about the design changes
-- between one photo and twenty. In practice the photo library holds 8-10 files
-- for a typical coin: obverse and reverse, the slab label, plus derivative
-- renderings (Small / Orig / Sharpened) and occasional retakes.
--
-- SortOrder is that photo's position WITHIN its coin, zero-based, and is the
-- only thing deciding display order - the app always reads images as
-- "WHERE CoinId = @id ORDER BY SortOrder". Two photos of the same coin sharing
-- a SortOrder therefore have no defined order between them, which is why new
-- inserts assign MAX(SortOrder) + 1 (see routes/coins/images.ts) and why
-- migration 003 renumbers any historical collisions.
--
-- ImageData is a DOWNSCALED base64 copy, sized for display. The originals are
-- far too large to hold in the database - up to roughly 46 MB each, decoding to
-- ~190 MB in memory - so the full-resolution file stays on disk and only a
-- small rendering is stored.
--
-- SourcePath is where that original file lives on the machine hosting the app.
-- It serves two purposes: it documents the file's location for the user, and it
-- lets the UI offer a link that opens the full-scale image (served by
-- GET /api/images/file). It is NULLABLE on purpose - photos imported before the
-- column existed have no known path, and "unknown" is not "empty string".
-- Those rows keep working; the UI just shows no link for them.
CREATE TABLE CoinImages (
    ImageId             INT                 IDENTITY(1,1) PRIMARY KEY,
    CoinId              UNIQUEIDENTIFIER    NOT NULL,       -- Which coin this image belongs to (many rows per coin)
    ImageData           NVARCHAR(MAX)       NULL,           -- Base64 data URL (downscaled copy for display)
    SortOrder           INT                 NOT NULL DEFAULT 0,  -- Zero-based position within THIS coin's photos
    SourcePath          NVARCHAR(400)       NULL,           -- Absolute path of the original file (may be absent)
    CONSTRAINT FK_CoinImages_Coin
        FOREIGN KEY (CoinId) REFERENCES Coins(CoinId) ON DELETE CASCADE
);

-- ----- CoinTags (REMOVED) ------------------------------------
-- There used to be a CoinTags table here -- a many-to-many of free-text labels
-- such as "key date" or "rainbow toning". It was wired up end to end in the
-- API and the grid, but there was never any way for the user to enter a tag:
-- no editor input, no bulk-edit field, and neither importer could set one. The
-- column could therefore only ever display a dash, so the whole feature was
-- dropped rather than finished.
--
-- Nothing referenced CoinTags: the foreign key pointed FROM CoinTags TO Coins,
-- not the other way round, so removing it leaves no dangling constraint.
-- Existing databases are cleaned up by migrations/005-drop-coin-tags.sql.

-- ----- Categories --------------------------------------------
-- Lookup table for valid category names
-- Seeded with the two default categories currently used by the app
CREATE TABLE Categories (
    CategoryName        NVARCHAR(100)       NOT NULL PRIMARY KEY
);

INSERT INTO Categories (CategoryName)
SELECT CategoryName
FROM (VALUES ('20th Cent. Type'), ('Odd Type Set')) AS Seed(CategoryName)
WHERE NOT EXISTS (SELECT 1 FROM Categories WHERE CategoryName = Seed.CategoryName);

-- ----- CoinSets ----------------------------------------------
-- Lookup table for coin sets
-- Examples: "1878-1921 Morgan Set", "State Quarters", "Sovereign Collection"
CREATE TABLE CoinSets (
    SetName             NVARCHAR(100)       NOT NULL PRIMARY KEY
);

-- ----- Transactions ------------------------------------------
-- Historical transaction log for each coin
-- Tracks purchases, sales, trades, appraisals
CREATE TABLE Transactions (
    TransactionId       UNIQUEIDENTIFIER    NOT NULL PRIMARY KEY DEFAULT NEWID(),
    CoinId              UNIQUEIDENTIFIER    NOT NULL,
    TransactionType     NVARCHAR(50)        NOT NULL,       -- 'purchase', 'sale', 'trade', 'appraisal'
    TransactionDate     NVARCHAR(30)        NOT NULL,       -- Date of transaction
    Amount              DECIMAL(12,2)       NOT NULL,       -- Dollar amount
    -- KEEP. This is the TRANSACTION's counterparty -- who this one purchase /
    -- sale / appraisal was with. It is not the coin-level Dealer column that
    -- was removed from Coins above; that one described the coin as a whole,
    -- this one belongs to a single dated, priced event.
    Dealer              NVARCHAR(200)       NULL,           -- Dealer or counterparty
    Notes               NVARCHAR(MAX)       NULL,
    CONSTRAINT FK_Transactions_Coin
        FOREIGN KEY (CoinId) REFERENCES Coins(CoinId) ON DELETE CASCADE
);

-- ----- SpotPrices --------------------------------------------
-- Precious metal spot prices
-- Fetched from external APIs and cached here
CREATE TABLE SpotPrices (
    SpotPriceId         INT                 IDENTITY(1,1) PRIMARY KEY,
    Gold                DECIMAL(10,2)       NOT NULL DEFAULT 0,     -- USD per troy oz
    Silver              DECIMAL(10,2)       NOT NULL DEFAULT 0,
    Platinum            DECIMAL(10,2)       NOT NULL DEFAULT 0,
    Copper              DECIMAL(10,4)       NOT NULL DEFAULT 0,     -- Smaller unit (cents)
    Source              NVARCHAR(200)       NULL,           -- API source or manual entry
    FetchedAt           DATETIME2           NOT NULL DEFAULT GETDATE()
);

-- ----- AppSettings -------------------------------------------
-- Application configuration key/value store
-- Examples: theme, default filters, API keys
CREATE TABLE AppSettings (
    SettingKey          NVARCHAR(100)       NOT NULL PRIMARY KEY,
    SettingValue        NVARCHAR(MAX)       NULL
);

-- ----- Issuers -----------------------------------------------
-- WHO STRUCK THE COIN. Added by migration 011.
--
-- "Issuer" rather than "Country" because the Roman Empire, the Papal States
-- and the German states are not countries, and ancients are explicitly in
-- scope. IsoCode is nullable and that is the point: roughly half the entries
-- this table is for have no ISO code and never will, and a table requiring
-- one would have excluded exactly the issuers the design calls first-class.
--
-- ValidFrom / ValidTo are plain INT years, not dates: the precision
-- available for "the Roman Republic" is a year at best and a DATE would
-- invite a precision nobody has. NULL on either side means open-ended.
--
-- Name is UNIQUE because the seed script (013) matches issuers BY NAME. Two
-- rows called 'Mexico' would make its join multiply rows silently rather
-- than fail.
--
-- Declared BEFORE Denominations because Denominations points at it. The DDL
-- below is character-for-character identical to the CREATE TABLE in
-- migrations/011-add-issuers-and-denomination-links.sql, and
-- migrations/migration-011.spec.ts fails the build if the two ever drift --
-- a fresh install and a migrated install must not end up with different
-- schemas.
CREATE TABLE Issuers (
    IssuerId            INT                 IDENTITY(1,1) PRIMARY KEY,
    Name                NVARCHAR(100)       NOT NULL,       -- 'Mexico', 'Roman Empire', 'Great Britain'
    IsoCode             CHAR(2)             NULL,           -- 'MX' where one exists; NULL for ancients and historical states
    Kind                NVARCHAR(20)        NOT NULL,       -- 'modern' | 'historical' | 'ancient'
    ValidFrom           INT                 NULL,           -- Year this authority began issuing
    ValidTo             INT                 NULL,           -- Year it stopped; NULL means it still does
    SortOrder           INT                 NOT NULL DEFAULT 0,
    IsActive            BIT                 NOT NULL DEFAULT 1,
    CONSTRAINT UQ_Issuers_Name UNIQUE (Name)
);

-- Issuers is deliberately left EMPTY by this script. It is seeded by
-- migrations/013-seed-issuers-and-denominations.sql, which is generated from
-- a reviewable JSON file and is the same script an existing database runs.
-- One seeding path rather than two means a fresh install and a migrated one
-- cannot disagree about what was seeded.

-- ----- Denominations -----------------------------------------
-- Pre-defined denomination lookup table
-- Supports both US and international coins
--
-- IssuerId is nullable through the migration window: the 37 rows seeded at
-- the bottom of this file have a Country and no issuer until 013 backfills
-- them from it. FaceValue is nullable because NULL is a real answer -- a
-- Denarius has no face value in any system this application knows about, and
-- inventing one would be a lie that then sorts things. Every ancient
-- denomination in the seed is NULL here deliberately; it is not missing data
-- waiting to be backfilled.
--
-- *** FaceValue IS COMPARABLE ONLY WITHIN ONE CURRENCY ERA OF ONE ISSUER. ***
-- France carries both '1 Franc' = 1 and '1 Euro' = 1, which are not the same
-- amount of anything. ANYTHING THAT SORTS A WHOLE ISSUER MUST USE SortOrder.
CREATE TABLE Denominations (
    DenominationId      INT                 IDENTITY(1,1) PRIMARY KEY,
    Label               NVARCHAR(100)       NOT NULL,       -- Display label with symbols
    Country             NVARCHAR(100)       NOT NULL,       -- "US", "GB", etc. -- kept as flagged debt (design §4.2)
    IssuerId            INT                 NULL,           -- FK to Issuers; NULL until seeded/backfilled (migration 011)
    FaceValue           DECIMAL(18,6)       NULL,           -- For sorting; NULL where a face value is meaningless
    SortOrder           INT                 NOT NULL,       -- For dropdown display order
    IsActive            BIT                 NOT NULL DEFAULT 1
);

-- ----- MintMarks ---------------------------------------------
-- Pre-defined mint mark lookup table
-- Covers major US mints and a catch-all "Other"
CREATE TABLE MintMarks (
    MintMarkId          INT                 IDENTITY(1,1) PRIMARY KEY,
    Label               NVARCHAR(20)        NOT NULL,       -- "P", "D", "S", "CC", blank, etc.
    Description         NVARCHAR(200)       NULL,           -- Human-readable description
    IsActive            BIT                 NOT NULL DEFAULT 1
);

-- ----- Catalogs ----------------------------------------------
-- THE REFERENCE CATALOGUES A COIN CAN BE ATTRIBUTED TO. Added by migration
-- 012, whose header carries the full argument.
--
-- Shaped like Denominations and MintMarks on purpose -- same IDENTITY key,
-- same SortOrder, same IsActive soft delete -- so it is maintained by the
-- same kind of screen through the same kind of routes, and anyone who
-- understands one understands all three.
--
-- The DDL below is character-for-character identical to the CREATE TABLE in
-- migrations/012-add-catalog-references.sql, and
-- migrations/migration-012.spec.ts fails the build if the two ever drift: a
-- fresh install and a migrated install must not end up with different
-- schemas, because the parameter bindings in db/coin-fields.ts can only be
-- right for one of them.
CREATE TABLE Catalogs (
    CatalogId           INT                 IDENTITY(1,1) PRIMARY KEY,
    Name                NVARCHAR(60)        NOT NULL,       -- 'Sear', 'RIC', 'Krause (KM)'
    SortOrder           INT                 NOT NULL DEFAULT 0,  -- Picker order; seeded 1..15
    IsActive            BIT                 NOT NULL DEFAULT 1   -- Soft delete, like every other lookup here
);

-- SEED DATA: the fifteen catalogues this collection uses.
--
-- NOT AN ARBITRARY LIST. The first fourteen are CATALOG_PREFIXES from
-- src/app/services/image-matching/filename-vocabulary.ts, expanded into
-- display names -- a list built by reading this collection's actual photo
-- filenames, which is why the picker's top entry is usually the right one.
-- The fifteenth, Krause (KM), is world-coin numbering: no filename mentions
-- it, but anyone cataloguing modern foreign coins needs it.
--
-- Duplicated from TypeScript because SQL cannot import a module.
-- src/app/types/catalog-seed-parity.spec.ts reads this file, the migration
-- and catalog-reference.ts off disk and fails the build if the three ever
-- disagree -- the same technique sql-pm-reference-parity.spec.ts uses for
-- migration 007's alloy table.
--
-- Guarded per NAME rather than "insert if the table is empty", matching
-- migration 012, so a re-run can neither duplicate a catalogue nor resurrect
-- one the user deliberately removed.
INSERT INTO Catalogs (Name, SortOrder, IsActive)
SELECT Seed.Name, Seed.SortOrder, 1
FROM (VALUES
    ('Sear',         1),   -- David Sear: Greek / Roman / Byzantine
    ('RIC',          2),   -- Roman Imperial Coinage
    ('Hendin',       3),   -- Guide to Biblical Coins (Judaea)
    ('RPC',          4),   -- Roman Provincial Coinage
    ('Svoronos',     5),   -- Ptolemaic
    ('BMC',          6),   -- British Museum Catalogue
    ('SNG',          7),   -- Sylloge Nummorum Graecorum
    ('Crawford',     8),   -- Roman Republican Coinage (RRC)
    ('Sydenham',     9),   -- The Coinage of the Roman Republic
    ('Cohen',       10),   -- Description historique des monnaies romaines
    ('RSC',         11),   -- Roman Silver Coinage
    ('Meshorer',    12),   -- Ancient Jewish Coinage
    ('TJC',         13),   -- A Treasury of Jewish Coins
    ('Kraay',       14),   -- Archaic and Classical Greek Coins
    ('Krause (KM)', 15)    -- Standard Catalog of World Coins (the one NOT from the matcher)
) AS Seed(Name, SortOrder)
WHERE NOT EXISTS (
    SELECT 1 FROM Catalogs WHERE Catalogs.Name = Seed.Name
);

-- ----- MetalContents -----------------------------------------
-- Canonical metal-content values used by the app and imported data
CREATE TABLE MetalContents (
    MetalContentId      INT                 IDENTITY(1,1) PRIMARY KEY,
    MetalContentName    NVARCHAR(50)        NOT NULL UNIQUE,
    SortOrder           INT                 NOT NULL DEFAULT 999,
    IsActive            BIT                 NOT NULL DEFAULT 1
);

INSERT INTO MetalContents (MetalContentName, SortOrder, IsActive) VALUES
('Gold', 1, 1),
('Silver', 2, 1),
('Platinum', 3, 1),
('Palladium', 4, 1),
('Copper', 5, 1),
('Nickel', 6, 1),
('Copper-Nickel', 7, 1),
('Bronze', 8, 1),
('Brass', 9, 1),
('Zinc', 10, 1),
('Steel', 11, 1),
('Aluminum', 12, 1),
('Nickel-Brass', 13, 1),
('Clad', 14, 1),
('Other', 15, 1);

-- ----- Foreign keys added after the tables -------------------
-- Both of these are ALTERs rather than inline constraints, and the reason is
-- testability rather than necessity. Coins is created above Denominations,
-- so ITS foreign key has to be an ALTER here whatever we do; writing the
-- other one the same way means both read character-for-character identically
-- to migrations/011-add-issuers-and-denomination-links.sql, and
-- migrations/migration-011.spec.ts can compare the two files as text.
--
-- Both constraints are NAMED. A generated name
-- (FK__Coins__Denomin__1A2B3C4D) is different on every database, so a later
-- migration that needs to drop one would have to hunt for it in sys.objects.
--
-- NO cascade on either, deliberately. ON DELETE SET NULL on
-- Coins.DenominationId is close to what design §4.4 wants when a
-- denomination is removed -- but removal is a SOFT delete (IsActive = 0)
-- precisely so a mistake is recoverable, and a cascade would make a genuine
-- row deletion silently unlink coins with no count and no confirmation.
ALTER TABLE Denominations
        ADD CONSTRAINT FK_Denominations_Issuer
            FOREIGN KEY (IssuerId) REFERENCES Issuers(IssuerId);

ALTER TABLE Coins
        ADD CONSTRAINT FK_Coins_Denomination
            FOREIGN KEY (DenominationId) REFERENCES Denominations(DenominationId);

-- The same shape again, for the catalogue reference (migration 012). An
-- ALTER for the same reason: Catalogs is created well below Coins, so an
-- inline REFERENCES on the column could not resolve.
--
-- NO CASCADE, and here that is the important word. Deleting a catalogue must
-- never delete the owner's coins; removal in the UI is a soft delete
-- (IsActive = 0) and even a hand-run DELETE should fail loudly on this
-- constraint rather than quietly take a hundred coins with it. ON DELETE SET
-- NULL was considered and rejected too -- it would silently discard the
-- attribution on every affected coin.
--
-- Character-for-character identical to the ALTER in
-- migrations/012-add-catalog-references.sql, which is what lets
-- migration-012.spec.ts compare the two files as text.
ALTER TABLE Coins
        ADD CONSTRAINT FK_Coins_Catalog
            FOREIGN KEY (CatalogId) REFERENCES Catalogs(CatalogId);

GO

-- ============================================================
-- CREATE INDEXES
-- ============================================================
-- Indexes to speed up common queries and JOIN operations

-- CoinImages is indexed on (CoinId, SortOrder), not CoinId alone, because the
-- app's hot image query is always "this coin's photos, in display order":
--   WHERE CoinId = @id ORDER BY SortOrder
-- Including SortOrder in the key means the rows come off the index already
-- sorted and the plan needs no separate sort step. With up to ten photos per
-- coin that is worth having. (Migration 003 applies this same change to an
-- existing database, where it replaces the old CoinId-only index.)
CREATE INDEX IX_CoinImages_CoinId_SortOrder ON CoinImages  (CoinId, SortOrder);
-- IX_CoinTags_CoinId used to sit here; the CoinTags table was removed.
CREATE INDEX IX_Coins_Category           ON Coins         (Category);
CREATE INDEX IX_Coins_Grade              ON Coins         (Grade);
CREATE INDEX IX_Coins_Year               ON Coins         (Year);
CREATE INDEX IX_Coins_CoinSet            ON Coins         (CoinSet);
-- IX_Coins_Dealer used to sit here; the Coins.Dealer column was removed.
CREATE INDEX IX_Coins_MetalContent       ON Coins         (MetalContent);
CREATE INDEX IX_Coins_CoinType           ON Coins         (CoinType);
CREATE INDEX IX_Transactions_CoinId      ON Transactions  (CoinId);
-- The two foreign keys added by migration 011. Both earn an index: every
-- "which coins use this denomination?" count behind the maintenance screen
-- and every read of an issuer's denominations filters on exactly these
-- columns. (These two lines are duplicated by 011 for existing databases;
-- migration-011.spec.ts asserts the two files agree.)
CREATE INDEX IX_Denominations_IssuerId ON Denominations (IssuerId);
CREATE INDEX IX_Coins_DenominationId ON Coins (DenominationId);

GO

-- ============================================================
-- SEED DATA: US Denominations (16 rows)
-- ============================================================
-- Sorted by value from smallest to largest

SET IDENTITY_INSERT Denominations ON;

INSERT INTO Denominations (DenominationId, Label, Country, SortOrder, IsActive) VALUES
(1,  '½¢',         'US', 1,  1),
(2,  '1¢',         'US', 2,  1),
(3,  '2¢',         'US', 3,  1),
(4,  '3CS',        'US', 4,  1),
(5,  '3CN',        'US', 5,  1),
(6,  '5¢',         'US', 6,  1),
(7,  '10¢',        'US', 7,  1),
(8,  '20¢',        'US', 8,  1),
(9,  '25¢',        'US', 9,  1),
(10, '50¢',        'US', 10, 1),
(11, '$1',         'US', 11, 1),
(12, '$2.50',      'US', 12, 1),
(13, '$3',         'US', 13, 1),
(14, '$5',         'US', 14, 1),
(15, '$10',        'US', 15, 1),
(16, '$20',        'US', 16, 1),
-- The two modern American Gold Eagle bullion face values. The 1/10 oz and
-- 1/4 oz sizes are $5 and $10, already listed above; these are the 1/2 oz
-- and the 1 oz coins. Added so a bullion Eagle can be recorded at all --
-- the matcher reads both, and resolves a bare "Gold Eagle" dated 1986 or
-- later to $50 (see resolveEagleSeries in image-matching/reference-tables).
--
-- Ids 39/40, NOT 17/18: Great Britain already occupies 17-38 below. SortOrder
-- keeps them in the right place in the US dropdown regardless of the id.
(39, '$25',        'US', 17, 1),
(40, '$50',        'US', 18, 1);

-- ============================================================
-- SEED DATA: Great Britain Denominations (21 rows)
-- ============================================================
-- Mix of pre-decimal (d, shillings) and decimal (p, pounds)

INSERT INTO Denominations (DenominationId, Label, Country, SortOrder, IsActive) VALUES
(17, 'Farthing',           'GB', 1,  1),
(18, '½d',                 'GB', 2,  1),
(19, '1d',                 'GB', 3,  1),
(20, '3d',                 'GB', 4,  1),
(21, '6d',                 'GB', 5,  1),
(22, '1/-',                'GB', 6,  1),
(23, '2/- (Florin)',       'GB', 7,  1),
(24, '2/6 (Half Crown)',   'GB', 8,  1),
(25, '5/- (Crown)',        'GB', 9,  1),
(26, '½ Sovereign',        'GB', 10, 1),
(27, 'Sovereign',          'GB', 11, 1),
(28, 'Guinea',             'GB', 12, 1),
(29, '½p',                 'GB', 13, 1),
(30, '1p',                 'GB', 14, 1),
(31, '2p',                 'GB', 15, 1),
(32, '5p',                 'GB', 16, 1),
(33, '10p',                'GB', 17, 1),
(34, '20p',                'GB', 18, 1),
(35, '50p',                'GB', 19, 1),
(36, '£1',                 'GB', 20, 1),
(37, '£2',                 'GB', 21, 1),
(38, '£5',                 'GB', 22, 1);

SET IDENTITY_INSERT Denominations OFF;

GO

-- ============================================================
-- SEED DATA: Mint Marks (9 rows)
-- ============================================================
-- Covers major US mints plus blank (Philadelphia pre-1980)

SET IDENTITY_INSERT MintMarks ON;

INSERT INTO MintMarks (MintMarkId, Label, Description, IsActive) VALUES
(1, '',      'No mintmark / Philadelphia pre-1980', 1),
(2, 'P',     'Philadelphia',                        1),
(3, 'D',     'Denver/Dahlonega',                    1),
(4, 'S',     'San Francisco',                       1),
(5, 'W',     'West Point',                          1),
(6, 'O',     'New Orleans',                         1),
(7, 'CC',    'Carson City',                         1),
(8, 'C',     'Charlotte',                           1),
(9, 'Other', 'Catch-all for oddities like O/S',    1);

SET IDENTITY_INSERT MintMarks OFF;

GO

-- ============================================================
-- BACKFILL METAL CONTENT VALUES
-- ============================================================
-- Use denomination/year rules for the known US and GB coinage in this database.
-- Composition is not reliable enough to be the source of truth for legacy rows.

UPDATE Coins
SET MetalContent = CASE
    WHEN MetalContent IS NOT NULL THEN MetalContent

    -- U.S. copper and bronze type coins
    WHEN Denomination IN ('½¢', '1¢') THEN 'Copper'
    WHEN Denomination = '2¢' THEN 'Bronze'

    -- U.S. nickel and copper-nickel series
    WHEN Denomination = '3CN' THEN 'Nickel'
    WHEN Denomination = '5¢' AND CAST(COALESCE(Year, '0') AS INT) = 1943 THEN 'Silver'
    WHEN Denomination = '5¢' THEN 'Copper-Nickel'

    -- U.S. silver series
    WHEN Denomination IN ('3CS', '10¢', '20¢', '25¢', '50¢', '$1') THEN 'Silver'
    WHEN Denomination IN ('$2.50', '$3', '$5', '$10', '$20') THEN 'Gold'

    -- GB coins
    WHEN Denomination IN ('Farthing', '½d', '1d', '3d', '6d', '1/-', '2/- (Florin)', '2/6 (Half Crown)', '5/- (Crown)', '½p', '1p', '2p', '5p', '10p', '20p', '50p', '£1', '£2', '£5') THEN 'Other'
    WHEN Denomination IN ('½ Sovereign', 'Sovereign', 'Guinea') THEN 'Gold'

    ELSE 'Other'
END
WHERE MetalContent = 'Other';

GO

-- ============================================================
-- Setup Complete!
-- ============================================================
-- Database: CoinInventory is now ready
-- Tables: 10 core tables created with indexes
-- Seed data: 16 US denominations, 21 GB denominations, 9 mint marks
--
-- Next steps:
-- 1. Run queries in server code using these CamelCase names
-- 2. Update TypeScript models to match the schema
-- 3. Test with SELECT * FROM Denominations; SELECT * FROM MintMarks;
-- ============================================================
