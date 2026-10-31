-- ============================================================
-- 009-add-bullion-denominations.sql
-- Adds the $25 and $50 US denominations
-- ============================================================
--
-- WHY
-- ---
-- The seeded US denominations stopped at $20, which is the top of the CLASSIC
-- gold series (the Double Eagle, struck to 1933). The modern American Gold
-- Eagle bullion series, which began in 1986, carries four face values:
--
--     1/10 oz -> $5      already seeded
--     1/4  oz -> $10     already seeded
--     1/2  oz -> $25     MISSING
--     1    oz -> $50     MISSING
--
-- So a half-ounce or one-ounce Gold Eagle could not be recorded at all: there
-- was no denomination row to file it under. The image matcher already reads
-- both values and resolves a bare "Gold Eagle" dated 1986 or later to $50
-- (see resolveEagleSeries in src/app/services/image-matching/reference-tables.ts),
-- so the application understood a coin the inventory had no room for.
--
-- This is a DATA migration, not a schema one: it inserts two lookup rows and
-- changes no column.
--
-- WHY THE IDs ARE NOT SPECIFIED
-- -----------------------------
-- Denominations.DenominationId is IDENTITY(1,1). setup-database.sql seeds
-- explicit ids only because it builds the whole table in one pass with
-- IDENTITY_INSERT semantics; a migration inserting into a live table must let
-- the identity assign itself, or it would collide with whatever the database
-- has already handed out. SortOrder is what controls dropdown position, and
-- that IS specified -- 17 and 18, directly after $20's 16, so the two new
-- values appear at the end of the US list where they belong.
--
-- HOW TO RUN IT
-- -------------
--   sqlcmd -S localhost -d CoinInventory -E -i .\migrations\009-add-bullion-denominations.sql
--
-- Safe to run twice: each insert is guarded on the label not already being
-- present for the US, so a second run reports "nothing to do" and changes
-- nothing. It is also safe on a database freshly built from
-- setup-database.sql, where both rows already exist.
-- ============================================================

USE CoinInventory;
GO

-- $25 -- the 1/2 oz American Gold Eagle.
IF NOT EXISTS (SELECT 1 FROM Denominations WHERE Label = '$25' AND Country = 'US')
BEGIN
    INSERT INTO Denominations (Label, Country, SortOrder, IsActive)
    VALUES ('$25', 'US', 17, 1);

    PRINT 'Migration 009: added US denomination $25 (1/2 oz Gold Eagle).';
END
ELSE
BEGIN
    PRINT 'Migration 009: US denomination $25 already exists - nothing to do.';
END
GO

-- $50 -- the 1 oz American Gold Eagle, and what a bare "Gold Eagle" means.
IF NOT EXISTS (SELECT 1 FROM Denominations WHERE Label = '$50' AND Country = 'US')
BEGIN
    INSERT INTO Denominations (Label, Country, SortOrder, IsActive)
    VALUES ('$50', 'US', 18, 1);

    PRINT 'Migration 009: added US denomination $50 (1 oz Gold Eagle).';
END
ELSE
BEGIN
    PRINT 'Migration 009: US denomination $50 already exists - nothing to do.';
END
GO

-- ============================================================
-- SUMMARY
-- ============================================================
DECLARE @UsCount INT = (SELECT COUNT(*) FROM Denominations WHERE Country = 'US');

PRINT '';
PRINT '--- US denominations after migration 009 ---';
PRINT 'Total US denomination rows ...... ' + CAST(@UsCount AS NVARCHAR(20));
PRINT '';
PRINT 'Migration 009 complete. Reload the app so the new values appear in the';
PRINT 'Denomination dropdown.';
GO
