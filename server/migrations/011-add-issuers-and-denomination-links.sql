-- ============================================================
-- 011-add-issuers-and-denomination-links.sql
-- Adds the Issuers table, Denominations.IssuerId / FaceValue
-- and Coins.DenominationId
-- ============================================================
--
-- WHY
-- ---
-- A denomination is currently a flat row with a two-letter Country column
-- that agrees with nothing else in the schema, and a coin's denomination is
-- free text. The concrete consequence, and the reason this exists:
--
--     *** 8 REALES IS MEXICAN AND THE APP FILES IT UNDER THE UNITED STATES. ***
--
-- The QIF parser never sets a country, so every imported coin says 'United
-- States' -- and there was no Mexican denomination to file one under in the
-- first place. The same flat model produced '3CS' and 'Three Cent Silver'
-- failing to match each other, and '100 Soles' with nowhere to live at all.
--
-- The full argument is in
-- docs/superpowers/specs/2026-11-08-denomination-reference-model-design.md.
-- The short version: a denomination belongs to an ISSUING AUTHORITY, not to
-- a country, because the Roman Republic, the Papal States and the German
-- states are not countries and ancients are explicitly in scope.
--
-- THIS FILE IS THE SCHEMA STEP AND ONLY THE SCHEMA STEP
-- -----------------------------------------------------
-- *** EVERY COIN COMES OUT OF THIS MIGRATION WITH DenominationId NULL. ***
-- That is correct, not a failure. 011 creates somewhere for the data to go
-- and puts nothing in it, so there is no value anywhere in the application
-- that reads differently the moment it finishes. It is reversible by
-- dropping three columns and one table, and it can be run today whether or
-- not the rest of the work ever lands.
--
-- The other two steps are separate files on purpose, so the owner can stop
-- between any two of them:
--
--     013-seed-issuers-and-denominations.sql   the issuers and their
--         denominations. GENERATED from server/migrations/seed-data/
--         issuers-denominations.json -- do not hand-edit it; edit the JSON
--         and regenerate (see migrations/generate-seed-migration.ts).
--
--     014-resolve-coin-denominations.sql       fills in Coins.DenominationId
--         for the coins it can resolve, and PRINTS A REPORT of every
--         distinct value it could not. That report is the review artefact:
--         read it before anything else is built on top of this.
--
-- (012 is the catalogue-references migration, written in parallel with this
-- one. The numbers are not re-used and the gap is intentional.)
--
-- WHY Denominations.Country IS NOT DROPPED
-- ----------------------------------------
-- It is kept, deliberately, as flagged debt (design §4.2). Re-pointing the
-- country handling at IssuerId is a second, separable migration, and
-- bundling the two doubles the risk of the one step that is actually
-- dangerous. Until then the denomination's ISSUER is the authoritative one
-- and the Country column is a display and search field that the existing
-- editor dropdown still reads.
--
-- WHY EVERY NEW COLUMN IS NULLABLE
-- --------------------------------
-- Two reasons, and the second is the real one.
--   * NOT NULL without a DEFAULT is refused outright by an ALTER on a table
--     that already has rows, and this database has 105 coins and 40
--     denominations.
--   * NOT NULL *with* a DEFAULT would be worse. It would invent an issuer
--     for every denomination and a denomination for every coin, silently,
--     and the design calls that a failure even if it works: a wrong value
--     the user has no reason to doubt beats a visible blank every time.
-- So NULL means "not established yet", everywhere, and that is a state the
-- application is required to handle for good -- imports will keep producing
-- it long after this migration is forgotten.
--
-- HOW TO RUN IT
-- -------------
--   sqlcmd -S localhost -d CoinInventory -E -i .\migrations\011-add-issuers-and-denomination-links.sql
--
-- Safe to run twice: every step is guarded on the object not already being
-- present, so a second run reports "nothing to do" and changes nothing. It
-- is also safe on a database freshly built from setup-database.sql, where
-- every object below already exists.
--
-- WHY THE STEPS ARE SEPARATED BY `GO`
-- -----------------------------------
-- SQL Server compiles a whole batch before running any of it, so a batch
-- that ADDs a column and then names that column -- in a FOREIGN KEY, in an
-- index, in an UPDATE -- fails to compile with "Invalid column name" even
-- though the ADD would have run first. Every ALTER below therefore sits in
-- its own batch, and the constraint and index that reference it come
-- afterwards. Do not merge them. migration-011.spec.ts asserts this by
-- splitting the file on GO, because the mistake is invisible to the eye.
-- ============================================================

USE CoinInventory;
GO

-- ============================================================
-- 1. Issuers -- who struck the coin
-- ============================================================
-- "Issuer" rather than "Country" because the Roman Empire, the Papal States
-- and the German states are not countries, and ancients are in scope.
--
-- IsoCode is NULLABLE and that is the point: roughly half the issuers this
-- table is for -- every ancient and most historical states -- have no ISO
-- code and never will. A table that required one would have excluded exactly
-- the entries the design calls first-class.
--
-- ValidFrom / ValidTo are plain INT years rather than dates. The precision
-- available for "the Roman Republic" is a year at best, and a DATE would
-- invite a precision nobody has. NULL on either side means open-ended.
--
-- Name is UNIQUE because the seed script (013) matches issuers BY NAME --
-- it inserts "WHERE NOT EXISTS (... WHERE Name = ...)" and joins its
-- denominations to the issuer the same way. Two rows called 'Mexico' would
-- make that join multiply rows silently rather than fail, which is the worst
-- of both worlds. The constraint is NAMED so a later migration can drop it
-- without hunting for a generated name.
IF OBJECT_ID('dbo.Issuers', 'U') IS NULL
BEGIN
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

    PRINT 'Migration 011: created table Issuers.';
END
ELSE
BEGIN
    PRINT 'Migration 011: table Issuers already exists - nothing to do.';
END
GO

-- ============================================================
-- 2. Denominations.IssuerId
-- ============================================================
-- Nullable through the migration window. The 40 rows already in the table
-- have a Country and no issuer; 013 backfills them from that Country before
-- it inserts anything new. Making the column NOT NULL now would mean
-- choosing an issuer for all 40 inside a script that cannot report what it
-- chose.
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.Denominations') AND name = 'IssuerId'
)
BEGIN
    ALTER TABLE Denominations
        ADD IssuerId INT NULL;

    PRINT 'Migration 011: added Denominations.IssuerId INT NULL.';
END
ELSE
BEGIN
    PRINT 'Migration 011: Denominations.IssuerId already exists - nothing to do.';
END
GO

-- ============================================================
-- 3. Denominations.FaceValue
-- ============================================================
-- DECIMAL(18,6) and NULLABLE. Six decimal places because a face value is not
-- always a whole unit -- an eighth of a dollar, a twelfth of a shilling --
-- and because sorting on a rounded value puts coins in the wrong order.
--
-- NULL is a real answer here, not a missing one: a Denarius has no face
-- value in any system this application knows about, and inventing one would
-- be a lie that then sorts things. Every ancient denomination in the seed
-- has a NULL FaceValue on purpose -- Roman ratios changed at every reform
-- and there is no honest single scale -- so a later "backfill the missing
-- face values" pass would be inventing data, not recovering it.
--
-- *** FaceValue IS COMPARABLE ONLY WITHIN ONE CURRENCY ERA OF ONE ISSUER. ***
-- France carries both '1 Franc' = 1 and '1 Euro' = 1, which are not the same
-- amount of anything. Great Britain happens to be coherent end to end in
-- pounds ('1/-' = 0.05, '1d' = 0.004167) and that is the exception, not the
-- rule. ANYTHING THAT SORTS A WHOLE ISSUER MUST USE SortOrder.
-- denomination-sort.ts stays the authority on display order until something
-- is proven to be better (design §8).
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.Denominations') AND name = 'FaceValue'
)
BEGIN
    ALTER TABLE Denominations
        ADD FaceValue DECIMAL(18,6) NULL;

    PRINT 'Migration 011: added Denominations.FaceValue DECIMAL(18,6) NULL.';
END
ELSE
BEGIN
    PRINT 'Migration 011: Denominations.FaceValue already exists - nothing to do.';
END
GO

-- ============================================================
-- 4. Coins.DenominationId
-- ============================================================
-- The canonical link. It sits ALONGSIDE the existing Coins.Denomination
-- text, which keeps its data and gains a new meaning: WHAT THE SOURCE SAID.
--
-- Keeping both is load-bearing. Everything
-- in this application arrives by import; a QIF security reading 'Trade
-- Dollar', or a spreadsheet column reading '8 Reales' before Mexico is
-- seeded, resolves to nothing. Under an id-only model that string is
-- DESTROYED AT IMPORT and neither the user nor a later, smarter resolver can
-- recover it. Keeping it costs one column that is already there.
--
-- *** Coins.Denomination IS NEVER WRITTEN BY ANY OF 011, 013 OR 014. ***
-- Read-only throughout. That single rule is what makes every step of this
-- change recoverable, and it is asserted by migration-011.spec.ts and by
-- src/app/services/denominations/sql-denomination-resolution-parity.spec.ts.
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.Coins') AND name = 'DenominationId'
)
BEGIN
    ALTER TABLE Coins
        ADD DenominationId INT NULL;

    PRINT 'Migration 011: added Coins.DenominationId INT NULL.';
END
ELSE
BEGIN
    PRINT 'Migration 011: Coins.DenominationId already exists - nothing to do.';
END
GO

-- ============================================================
-- 5. Foreign keys -- a SEPARATE BATCH, and that is mandatory
-- ============================================================
-- These could not go in the batches above. A FOREIGN KEY clause naming
-- IssuerId is compiled along with the rest of its batch, before the ALTER
-- that creates IssuerId has run, so the whole batch would die with "Invalid
-- column name 'IssuerId'" -- leaving the column added and the constraint
-- missing, with nothing saying so.
--
-- Both constraints are NAMED. A generated name
-- (FK__Coins__Denomin__1A2B3C4D) is different on every database, so the next
-- migration that needs to drop one would have to go looking for it in
-- sys.objects on a database it has never seen.
--
-- NO cascade on either. ON DELETE SET NULL on Coins.DenominationId would be
-- tempting -- it is close to what §4.4 wants when a denomination is removed
-- -- but deletion is a SOFT delete (IsActive = 0) precisely so a mistake is
-- recoverable, and a cascade would make a genuine row deletion silently
-- unlink coins with no count and no confirmation. The application asks
-- first; the database refuses.
IF NOT EXISTS (
    SELECT 1 FROM sys.foreign_keys
    WHERE name = 'FK_Denominations_Issuer' AND parent_object_id = OBJECT_ID('dbo.Denominations')
)
BEGIN
    ALTER TABLE Denominations
        ADD CONSTRAINT FK_Denominations_Issuer
            FOREIGN KEY (IssuerId) REFERENCES Issuers(IssuerId);

    PRINT 'Migration 011: added FK_Denominations_Issuer.';
END
ELSE
BEGIN
    PRINT 'Migration 011: FK_Denominations_Issuer already exists - nothing to do.';
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.foreign_keys
    WHERE name = 'FK_Coins_Denomination' AND parent_object_id = OBJECT_ID('dbo.Coins')
)
BEGIN
    ALTER TABLE Coins
        ADD CONSTRAINT FK_Coins_Denomination
            FOREIGN KEY (DenominationId) REFERENCES Denominations(DenominationId);

    PRINT 'Migration 011: added FK_Coins_Denomination.';
END
ELSE
BEGIN
    PRINT 'Migration 011: FK_Coins_Denomination already exists - nothing to do.';
END
GO

-- ============================================================
-- 6. Indexes -- also a separate batch, for the same reason
-- ============================================================
-- Design §8 leaves indexing to the builder. Both of these earn their place:
-- every read of a denomination's coins and every "how many coins use this
-- row?" count in the maintenance screen (§4.6) filters on exactly these
-- columns, and both are highly selective.
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_Denominations_IssuerId' AND object_id = OBJECT_ID('dbo.Denominations')
)
BEGIN
    CREATE INDEX IX_Denominations_IssuerId ON Denominations (IssuerId);

    PRINT 'Migration 011: created index IX_Denominations_IssuerId.';
END
ELSE
BEGIN
    PRINT 'Migration 011: index IX_Denominations_IssuerId already exists - nothing to do.';
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_Coins_DenominationId' AND object_id = OBJECT_ID('dbo.Coins')
)
BEGIN
    CREATE INDEX IX_Coins_DenominationId ON Coins (DenominationId);

    PRINT 'Migration 011: created index IX_Coins_DenominationId.';
END
ELSE
BEGIN
    PRINT 'Migration 011: index IX_Coins_DenominationId already exists - nothing to do.';
END
GO

-- ============================================================
-- SUMMARY
-- ============================================================
DECLARE @Issuers      INT = (SELECT COUNT(*) FROM Issuers);
DECLARE @Denoms       INT = (SELECT COUNT(*) FROM Denominations);
DECLARE @DenomsLinked INT = (SELECT COUNT(*) FROM Denominations WHERE IssuerId IS NOT NULL);
DECLARE @Coins        INT = (SELECT COUNT(*) FROM Coins);
DECLARE @CoinsLinked  INT = (SELECT COUNT(*) FROM Coins WHERE DenominationId IS NOT NULL);

PRINT '';
PRINT '--- After migration 011 ---';
PRINT 'Issuers ......................... ' + CAST(@Issuers      AS NVARCHAR(20));
PRINT 'Denominations ................... ' + CAST(@Denoms       AS NVARCHAR(20));
PRINT '  ... with an issuer ............ ' + CAST(@DenomsLinked AS NVARCHAR(20));
PRINT 'Coins ........................... ' + CAST(@Coins        AS NVARCHAR(20));
PRINT '  ... with a denomination id .... ' + CAST(@CoinsLinked  AS NVARCHAR(20));
PRINT '';
PRINT 'All three of those zeroes are expected on a first run. 011 creates';
PRINT 'somewhere for the data to go and puts nothing in it; no value anywhere';
PRINT 'in the application reads differently yet, and nothing has been lost.';
PRINT '';
PRINT 'Next: 013-seed-issuers-and-denominations.sql, then';
PRINT '014-resolve-coin-denominations.sql -- and READ 014''s report before';
PRINT 'anything else is built on top of this.';
GO
