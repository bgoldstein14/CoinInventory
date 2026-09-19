-- ============================================================
-- Coin Inventory Database Setup Script
-- ============================================================
-- Purpose: Complete schema initialization for coin inventory
-- Database: CoinInventory
-- Server: BRUCE_PC\SQLEXPRESS
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
IF OBJECT_ID('CoinTags', 'U') IS NOT NULL DROP TABLE CoinTags;
IF OBJECT_ID('CoinImages', 'U') IS NOT NULL DROP TABLE CoinImages;
IF OBJECT_ID('Coins', 'U') IS NOT NULL DROP TABLE Coins;
IF OBJECT_ID('Categories', 'U') IS NOT NULL DROP TABLE Categories;
IF OBJECT_ID('CoinSets', 'U') IS NOT NULL DROP TABLE CoinSets;
IF OBJECT_ID('SpotPrices', 'U') IS NOT NULL DROP TABLE SpotPrices;
IF OBJECT_ID('AppSettings', 'U') IS NOT NULL DROP TABLE AppSettings;
IF OBJECT_ID('Denominations', 'U') IS NOT NULL DROP TABLE Denominations;
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
    Denomination        NVARCHAR(100)       NULL,           -- e.g., "1¢", "Quarter", "Sovereign"
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
    Dealer              NVARCHAR(200)       NULL,           -- Dealer/seller name
    Weight              DECIMAL(10,4)       NULL,           -- Weight in troy ounces
    MetalContent        NVARCHAR(50)        NULL,           -- Primary metal: "Gold", "Silver", "Platinum"
    PmWeightGrams       DECIMAL(10,4)       NULL,           -- Precious metal weight in grams
    PmPercent           DECIMAL(5,2)        NULL,           -- Precious metal percentage (e.g., 90.00 for 90%)
    CoinSet             NVARCHAR(100)       NULL            -- Set membership (FK to CoinSets)
);

-- ----- CoinImages --------------------------------------------
-- Stores multiple images per coin (front, back, detail shots)
-- Images stored as base64-encoded data URLs
CREATE TABLE CoinImages (
    ImageId             INT                 IDENTITY(1,1) PRIMARY KEY,
    CoinId              UNIQUEIDENTIFIER    NOT NULL,       -- Which coin this image belongs to
    ImageData           NVARCHAR(MAX)       NULL,           -- Base64 data URL
    SortOrder           INT                 NOT NULL DEFAULT 0,  -- Display order
    CONSTRAINT FK_CoinImages_Coin
        FOREIGN KEY (CoinId) REFERENCES Coins(CoinId) ON DELETE CASCADE
);

-- ----- CoinTags ----------------------------------------------
-- Many-to-many tags for flexible categorization
-- Examples: "key date", "rainbow toning", "investment grade"
CREATE TABLE CoinTags (
    CoinId              UNIQUEIDENTIFIER    NOT NULL,
    Tag                 NVARCHAR(100)       NOT NULL,
    CONSTRAINT PK_CoinTags PRIMARY KEY (CoinId, Tag),       -- Composite PK prevents duplicates
    CONSTRAINT FK_CoinTags_Coin
        FOREIGN KEY (CoinId) REFERENCES Coins(CoinId) ON DELETE CASCADE
);

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

-- ----- Denominations -----------------------------------------
-- Pre-defined denomination lookup table
-- Supports both US and international coins
CREATE TABLE Denominations (
    DenominationId      INT                 IDENTITY(1,1) PRIMARY KEY,
    Label               NVARCHAR(100)       NOT NULL,       -- Display label with symbols
    Country             NVARCHAR(100)       NOT NULL,       -- "US", "GB", etc.
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

GO

-- ============================================================
-- CREATE INDEXES
-- ============================================================
-- Indexes to speed up common queries and JOIN operations

CREATE INDEX IX_CoinImages_CoinId        ON CoinImages    (CoinId);
CREATE INDEX IX_CoinTags_CoinId          ON CoinTags      (CoinId);
CREATE INDEX IX_Coins_Category           ON Coins         (Category);
CREATE INDEX IX_Coins_Grade              ON Coins         (Grade);
CREATE INDEX IX_Coins_Year               ON Coins         (Year);
CREATE INDEX IX_Coins_CoinSet            ON Coins         (CoinSet);
CREATE INDEX IX_Coins_Dealer             ON Coins         (Dealer);
CREATE INDEX IX_Coins_MetalContent       ON Coins         (MetalContent);
CREATE INDEX IX_Coins_CoinType           ON Coins         (CoinType);
CREATE INDEX IX_Transactions_CoinId      ON Transactions  (CoinId);

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
(16, '$20',        'US', 16, 1);

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
