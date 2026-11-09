-- ============================================================
-- 010-add-collection-status-and-storage-location.sql
-- Adds Coins.CollectionStatus and Coins.StorageLocation
-- ============================================================
--
-- WHY
-- ---
-- Two new tracked fields, both about the owner's relationship to a coin
-- rather than about the coin itself.
--
-- 1. CollectionStatus -- "do I actually have this one?"
--    One of exactly five values: 'owned', 'wanted', 'ordered', 'for-sale',
--    'sold'. Until now a coin the owner WANTED and a coin he HAD were the
--    same row, so the only way to keep a want list was a second inventory
--    file. The argument for those five particular values, and for modelling
--    this as one field rather than a separate wish-list table, is written out
--    in src/app/types/collection-status.ts.
--
-- 2. StorageLocation -- "where is it?"
--    Free text: "Safe deposit box 2", "Dansco 7070, page 4", "Blue album,
--    slot 12". Deliberately unvalidated; every collector organises
--    differently. NOT the same thing as CoinSet, which is the conceptual
--    grouping a coin belongs to wherever it physically lives.
--
-- *** EVERY EXISTING COIN BECOMES 'owned'. ***
-- -------------------------------------------
-- That is the whole safety property of this migration, and it is worth being
-- explicit about why it is not merely a convenience. CollectionStatus decides
-- whether a coin counts towards the collection's totals and whether it
-- appears on the insurance schedule. A collection that came out of this
-- migration status-less would therefore come out VALUELESS -- every coin
-- still visible in the grid, every figure on the toolbar wrong, and nothing
-- anywhere saying so. The owner would simply find his collection worth less
-- than it was the day before.
--
-- Two independent things guarantee it does not happen:
--   * the column is NOT NULL with DEFAULT 'owned', so SQL Server itself backs
--     every existing row with 'owned' as part of the ALTER; and
--   * step 3 below sweeps up anything blank anyway, for the case where a
--     database already carries a hand-added, nullable version of the column.
-- The application adds a third, independent of the database entirely: an
-- absent or unrecognised status reads as 'owned' everywhere in the app (see
-- normalizeCollectionStatus in server/db/collection-status.ts and in
-- src/app/types/collection-status.ts).
--
-- WHY NVARCHAR AND NOT A LOOKUP TABLE OR A CHECK CONSTRAINT
-- ---------------------------------------------------------
-- A LOOKUP TABLE (as Categories, CoinSets and MetalContents have) would mean
-- a join and a seed script for five words the user cannot add to. Those
-- tables exist because their contents are the USER's data; these five values
-- are the application's logic, and a sixth one would need code, not a row.
--
-- A CHECK CONSTRAINT was the closer call, and was rejected because of what it
-- would cost the NEXT migration: adding a sixth status would mean dropping
-- and recreating the constraint from a script that has to discover its name
-- on a database it has never seen. The server validates instead -- one
-- function, server/db/collection-status.ts, which every INSERT and UPDATE
-- goes through -- and a spec there fails the build if its list of values ever
-- drifts from the Angular one.
--
-- NVARCHAR(20) leaves room for a longer future token without a second ALTER.
-- The length is mirrored by MAX_COLLECTION_STATUS_LENGTH in
-- server/db/collection-status.ts and asserted against this file and against
-- setup-database.sql by server/migrations/migration-010.spec.ts.
--
-- HOW TO RUN IT
-- -------------
--   sqlcmd -S localhost -d CoinInventory -E -i .\migrations\010-add-collection-status-and-storage-location.sql
--
-- Safe to run twice: every step is guarded on the column not already being
-- present (or on there being something to fix), so a second run reports
-- "nothing to do" and changes nothing. It is also safe on a database freshly
-- built from setup-database.sql, where both columns already exist.
--
-- WHY THE STEPS ARE SEPARATED BY `GO`
-- -----------------------------------
-- SQL Server compiles a whole batch before running any of it, so a batch that
-- both ADDs a column and then names that column fails to compile -- "Invalid
-- column name 'CollectionStatus'" -- even though the ADD would have run
-- first. The ALTER and the UPDATE that follows it therefore MUST be in
-- different batches. Do not merge them.
-- ============================================================

USE CoinInventory;
GO

-- ============================================================
-- 1. CollectionStatus
-- ============================================================
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.Coins') AND name = 'CollectionStatus'
)
BEGIN
    -- NOT NULL with a DEFAULT: SQL Server writes 'owned' into every existing
    -- row as part of this statement. The constraint is NAMED rather than left
    -- to a generated name (DF__Coins__Collect__1A2B3C4D) so that a future
    -- migration can drop it by name instead of hunting for it in sys.objects.
    ALTER TABLE Coins
        ADD CollectionStatus NVARCHAR(20) NOT NULL
            CONSTRAINT DF_Coins_CollectionStatus DEFAULT 'owned';

    PRINT 'Migration 010: added Coins.CollectionStatus NVARCHAR(20) NOT NULL DEFAULT ''owned''.';
END
ELSE
BEGIN
    PRINT 'Migration 010: Coins.CollectionStatus already exists - nothing to do.';
END
GO

-- ============================================================
-- 2. StorageLocation
-- ============================================================
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.Coins') AND name = 'StorageLocation'
)
BEGIN
    -- Nullable, no default. "Nothing recorded" is a perfectly good answer for
    -- a field whose whole point is that the user writes whatever he likes in
    -- it, and a default would be inventing a location for every coin he owns.
    ALTER TABLE Coins
        ADD StorageLocation NVARCHAR(200) NULL;

    PRINT 'Migration 010: added Coins.StorageLocation NVARCHAR(200) NULL.';
END
ELSE
BEGIN
    PRINT 'Migration 010: Coins.StorageLocation already exists - nothing to do.';
END
GO

-- ============================================================
-- 3. Backfill sweep -- belt and braces
-- ============================================================
-- Step 1 cannot leave a NULL behind: the column is NOT NULL and the DEFAULT
-- fills every existing row. This step exists for the database that did NOT
-- come from step 1 -- one where somebody added a nullable CollectionStatus by
-- hand, or where an older build inserted an empty string.
--
-- It is a no-op on a healthy database, which is exactly what makes it safe to
-- leave in: it only ever writes rows that currently say nothing, and it only
-- ever writes the value those rows already mean.
DECLARE @Fixed INT = 0;

UPDATE Coins
SET CollectionStatus = 'owned'
WHERE CollectionStatus IS NULL
   OR LTRIM(RTRIM(CollectionStatus)) = '';

SET @Fixed = @@ROWCOUNT;

IF @Fixed > 0
    PRINT 'Migration 010: backfilled ' + CAST(@Fixed AS NVARCHAR(20)) + ' row(s) with a blank status to ''owned''.';
ELSE
    PRINT 'Migration 010: no blank statuses to backfill - nothing to do.';
GO

-- ============================================================
-- SUMMARY
-- ============================================================
DECLARE @Total   INT = (SELECT COUNT(*) FROM Coins);
DECLARE @Owned   INT = (SELECT COUNT(*) FROM Coins WHERE CollectionStatus = 'owned');
DECLARE @Other   INT = (SELECT COUNT(*) FROM Coins WHERE CollectionStatus <> 'owned');
DECLARE @Located INT = (SELECT COUNT(*) FROM Coins WHERE StorageLocation IS NOT NULL AND LTRIM(RTRIM(StorageLocation)) <> '');

PRINT '';
PRINT '--- Coins after migration 010 ---';
PRINT 'Total coins ..................... ' + CAST(@Total   AS NVARCHAR(20));
PRINT 'Status = owned .................. ' + CAST(@Owned   AS NVARCHAR(20));
PRINT 'Status = something else ......... ' + CAST(@Other   AS NVARCHAR(20));
PRINT 'With a storage location recorded . ' + CAST(@Located AS NVARCHAR(20));
PRINT '';
PRINT 'Every coin that existed before this migration is now ''owned'', so no';
PRINT 'total and no insurance schedule has changed. Reload the app; the new';
PRINT 'Status column appears in the grid and the Status filter in the';
PRINT 'Filters panel.';
GO
