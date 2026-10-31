-- ============================================================
-- 006-drop-coin-dealer.sql
-- Remove the Coins.Dealer column  ->  the coin-level "dealer" field is gone
-- ============================================================
--
-- WHY
-- ---
-- A coin used to carry a single free-text "dealer" string -- who the coin came
-- from -- in Coins.Dealer. It was plumbed through every layer: the column, the
-- mssql binding, the coin editor's Dealer input, a Dealer column in the
-- inventory grid, a "Search dealers" box in the advanced filter panel, a Dealer
-- option in bulk edit, and a Dealer column in the CSV import/export.
--
-- The owner asked for it to go ("not sure why that was added anyway"), and the
-- reason it was redundant is worth writing down: the same information is
-- already recorded, more precisely, on the TRANSACTION rows. A coin-level
-- dealer can only say "this coin is associated with Heritage"; a transaction
-- says "the purchase on 2024-01-15, for $150, was with Heritage" -- and it can
-- say something different about the sale two years later. One string on the
-- coin could never express that, so it was a weaker second answer to a question
-- that was already answered properly elsewhere.
--
-- This migration is the database half of the removal; the application half has
-- already deleted the field, the binding, the grid column, the filter, the
-- editor input and the CSV column.
--
-- ************************************************************
-- *** Transactions.Dealer IS A DIFFERENT COLUMN AND STAYS ***
-- ************************************************************
-- setup-database.sql declares `Dealer NVARCHAR(200) NULL` on TWO tables:
--
--   Coins.Dealer         <- removed by this script
--   Transactions.Dealer  <- UNTOUCHED, still in active use
--
-- Every statement below names the Coins table explicitly, and the catalog
-- lookups are all scoped with OBJECT_ID('Coins'), so there is no path by which
-- this script can reach the Transactions column. If you are adapting this file
-- for something else, keep that scoping -- a bare search for a column called
-- "Dealer" would hit both and silently delete a working feature.
--
-- ************************************************************
-- *** THIS SCRIPT DESTROYS DATA, DELIBERATELY ***
-- ************************************************************
-- Migration 005 (the tags removal) REFUSED to drop anything it found data in,
-- and stopped with instructions instead. This one does NOT do that, and the
-- difference is a decision the owner made, not an oversight:
--
--   - Tags were unreachable. No code path could ever set one, so any row found
--     in CoinTags was a mystery that deserved a human look before deletion.
--   - Dealer was a real, editable field. There is nothing mysterious about
--     finding values in it -- that is what it was for -- and the owner has
--     chosen to discard them anyway.
--
-- So there is no refusal path here. What the script DOES do is COUNT the values
-- it is about to destroy and PRINT that count first, so the log records exactly
-- what was lost. If you want the data kept, stop now and run:
--
--     SELECT CoinId, Year, Denomination, CoinType, Dealer
--     INTO   Coins_Dealer_Backup
--     FROM   Coins
--     WHERE  Dealer IS NOT NULL AND LTRIM(RTRIM(Dealer)) <> '';
--
-- ...before executing this file. Afterwards the values are unrecoverable short
-- of a database restore.
--
-- ************************************************************
-- *** THE ORDER MATTERS: INDEX FIRST, THEN COLUMN ***
-- ************************************************************
-- This is the one real trap in this migration, and it is why the script has two
-- separate steps rather than a single ALTER TABLE.
--
-- setup-database.sql creates `CREATE INDEX IX_Coins_Dealer ON Coins (Dealer);`.
-- An index is a persisted, sorted copy of the column it keys on, so the index
-- physically CONTAINS the data in Dealer. SQL Server therefore refuses to drop
-- a column while any index still depends on it:
--
--     Msg 5074, Level 16, State 1
--     The object 'IX_Coins_Dealer' is dependent on column 'Dealer'.
--     ALTER TABLE DROP COLUMN Dealer failed because one or more objects access
--     this column.
--
-- That error is not a warning you can ignore -- the ALTER does nothing at all.
-- So the index must be dropped FIRST, which leaves the column with no dependent
-- objects, and only THEN can the column itself go. Reversing the two steps does
-- not half-work; it simply fails at the second one.
--
-- The reverse direction is not a problem: dropping an index never affects the
-- data in the underlying table, because the index is a derived copy. Dropping
-- IX_Coins_Dealer on its own would just make "find coins from this dealer"
-- slower, which is irrelevant when the column is about to disappear anyway.
--
-- WHAT ELSE DEPENDS ON THE COLUMN? (checked, not assumed)
-- -------------------------------------------------------
-- setup-database.sql was read line by line for anything else bound to
-- Coins.Dealer. The answer is: only the index.
--
--   - Default constraint ...... none. The column is declared plain
--                               `NVARCHAR(200) NULL` with no DEFAULT. (The only
--                               DEFAULTs on Coins are on CoinId and
--                               HasCacSticker.)
--   - CHECK constraint ........ none anywhere in the schema.
--   - Foreign key ............. none. The only FKs in the database are
--                               CoinImages -> Coins and Transactions -> Coins,
--                               and both are on CoinId.
--   - Computed column ......... none; the schema has no computed columns at all.
--   - View / trigger /
--     function / procedure .... none; the schema creates no programmable
--                               objects whatsoever, so nothing can be bound to
--                               the column by WITH SCHEMABINDING or otherwise.
--   - Statistics .............. nothing to do by hand. The statistics object
--                               that belongs to IX_Coins_Dealer is dropped with
--                               the index, and any auto-created column
--                               statistics (the `_WA_Sys_...` ones SQL Server
--                               makes on its own) are dropped automatically
--                               with the column. Only a hand-written
--                               CREATE STATISTICS would block the drop, and the
--                               schema contains none.
--
-- Step 2 below nevertheless sweeps for a default constraint before dropping the
-- column, and step 1 sweeps for indexes by catalog lookup rather than by the
-- single name IX_Coins_Dealer. That is the same reasoning migration 005 used
-- about rows: the schema FILE says one thing, but the actual database is a
-- separate object that nobody can inspect from here, and someone may have added
-- an index or a default by hand in SSMS. Sweeping costs a few lines and turns a
-- cryptic Msg 5074 into a clear PRINT saying what was removed.
--
-- HOW TO RUN IT
-- -------------
--   sqlcmd -S localhost -d CoinInventory -E -i .\migrations\006-drop-coin-dealer.sql
--
-- ...or open it in SSMS / Azure Data Studio with CoinInventory selected and
-- press Execute.
--
-- Running it twice is harmless, and so is running it after a failure half way
-- through. Every step is guarded independently by reading the system catalog
-- (sys.indexes, sys.default_constraints, COL_LENGTH) rather than by tracking
-- which migrations have been applied, so each step asks "is this still true?"
-- and skips itself if not. A run that dropped the index and then died before
-- the column would, on the next run, report the index already gone and finish
-- the job.
-- ============================================================

USE CoinInventory;
GO

-- ============================================================
-- STEP 0: report what is about to be discarded
-- ============================================================
-- The owner has already decided to proceed regardless of what is in here, so
-- this step never blocks. Its only job is to put the loss on the record.
--
-- WHY THE COUNT GOES THROUGH sp_executesql INSTEAD OF BEING WRITTEN PLAINLY:
-- a batch is compiled as a whole before any of it runs, and column names in a
-- SELECT are resolved at compile time. So writing
--
--     IF COL_LENGTH('Coins','Dealer') IS NOT NULL
--         SELECT COUNT(*) FROM Coins WHERE Dealer IS NOT NULL;
--
-- would fail with "Msg 207: Invalid column name 'Dealer'" on the SECOND run of
-- this script -- the IF would correctly be false, but the batch would never get
-- as far as evaluating it, because it could not compile. Hiding the reference
-- inside a string defers it to execution time, where the guard protects it.
-- (The DDL in steps 1-3 does not need this treatment: ALTER TABLE and DROP
-- INDEX resolve their targets when they run, not when the batch is compiled.)

DECLARE @WithDealer INT = 0;
DECLARE @TotalCoins INT = 0;

IF COL_LENGTH('Coins', 'Dealer') IS NULL
BEGIN
    PRINT 'Migration 006: Coins.Dealer does not exist - no data to discard.';
    PRINT '               (Either this migration already ran, or the database';
    PRINT '                was built from the current setup-database.sql, which';
    PRINT '                no longer creates the column.)';
END
ELSE
BEGIN
    DECLARE @CountSql NVARCHAR(500) = N'
        SELECT @OutWithDealer = COUNT(CASE WHEN Dealer IS NOT NULL
                                            AND LTRIM(RTRIM(Dealer)) <> ''''
                                           THEN 1 END),
               @OutTotal      = COUNT(*)
        FROM Coins;';

    EXEC sp_executesql
        @CountSql,
        N'@OutWithDealer INT OUTPUT, @OutTotal INT OUTPUT',
        @OutWithDealer = @WithDealer OUTPUT,
        @OutTotal      = @TotalCoins OUTPUT;

    PRINT '';
    PRINT '--- Migration 006: data about to be discarded ---';
    PRINT 'Coins in the table .............. ' + CAST(@TotalCoins AS NVARCHAR(20));
    PRINT 'Coins with a Dealer value ....... ' + CAST(@WithDealer AS NVARCHAR(20));

    IF @WithDealer = 0
    BEGIN
        PRINT 'Nothing is lost: no coin has a dealer recorded.';
    END
    ELSE
    BEGIN
        PRINT '';
        PRINT '*** ' + CAST(@WithDealer AS NVARCHAR(20)) + ' dealer value(s) WILL BE PERMANENTLY DELETED by this script. ***';
        PRINT '';
        PRINT 'This is intended. The owner chose to drop the field unconditionally,';
        PRINT 'so this script does not stop. The count above is the record of what';
        PRINT 'was lost.';
        PRINT '';
        PRINT 'If you are reading this BEFORE running the script and want the data';
        PRINT 'kept, cancel now and run:';
        PRINT '';
        PRINT '    SELECT CoinId, Year, Denomination, CoinType, Dealer';
        PRINT '    INTO   Coins_Dealer_Backup';
        PRINT '    FROM   Coins';
        PRINT '    WHERE  Dealer IS NOT NULL AND LTRIM(RTRIM(Dealer)) <> '''';';
    END
    PRINT '';
END
GO

-- ============================================================
-- STEP 1: drop every index that depends on Coins.Dealer
-- ============================================================
-- THIS MUST HAPPEN BEFORE STEP 3. See the long explanation in the header: SQL
-- Server raises Msg 5074 and refuses the DROP COLUMN outright while an index
-- still references the column.
--
-- Written as a catalog-driven loop rather than a single
-- `DROP INDEX IX_Coins_Dealer ON Coins;` for two reasons:
--
--   1. It is self-guarding. The loop simply finds nothing on a second run, so
--      re-running the script is a no-op rather than an error.
--   2. It catches an index this file does not know the name of. sys.index_columns
--      lists BOTH key columns and INCLUDE columns, so an index that merely
--      carries Dealer along as an included column -- which also blocks the drop
--      -- is found too.
--
-- Against the shipped schema this finds exactly one index: IX_Coins_Dealer.
--
-- Primary keys and unique constraints are excluded from the search deliberately.
-- They cannot be removed with DROP INDEX (they need ALTER TABLE DROP CONSTRAINT)
-- and neither exists on Dealer, so finding one would mean something is very
-- different from what this script expects -- better to leave it alone and let
-- step 3 report a clear failure than to guess.

DECLARE @IndexName SYSNAME;
DECLARE @DropIndexSql NVARCHAR(500);
DECLARE @IndexesDropped INT = 0;

WHILE 1 = 1
BEGIN
    SET @IndexName = NULL;

    SELECT TOP (1) @IndexName = i.name
    FROM sys.indexes AS i
    INNER JOIN sys.index_columns AS ic
        ON  ic.object_id = i.object_id
        AND ic.index_id  = i.index_id
    INNER JOIN sys.columns AS c
        ON  c.object_id = ic.object_id
        AND c.column_id = ic.column_id
    WHERE i.object_id = OBJECT_ID('Coins')   -- Coins ONLY; never Transactions.
      AND c.name = 'Dealer'
      AND i.name IS NOT NULL                 -- excludes the heap/clustered entry
      AND i.is_primary_key = 0
      AND i.is_unique_constraint = 0
    ORDER BY i.name;

    IF @IndexName IS NULL BREAK;

    -- QUOTENAME guards against an index whose name needs bracketing. The table
    -- is written out literally so the statement can only ever target Coins.
    SET @DropIndexSql = N'DROP INDEX ' + QUOTENAME(@IndexName) + N' ON Coins;';
    EXEC sp_executesql @DropIndexSql;

    SET @IndexesDropped = @IndexesDropped + 1;
    PRINT 'Migration 006: dropped index ' + @IndexName
        + ' (it keyed on, or included, Coins.Dealer).';
END

IF @IndexesDropped = 0
    PRINT 'Migration 006: no index depends on Coins.Dealer - nothing to drop.';
GO

-- ============================================================
-- STEP 2: drop any DEFAULT constraint bound to Coins.Dealer
-- ============================================================
-- The shipped schema declares no default on this column, so on a database built
-- from setup-database.sql this step finds nothing and says so.
--
-- It is here because a default constraint is the other common thing that blocks
-- DROP COLUMN (Msg 5074 again), it is easy to add by accident in SSMS's table
-- designer, and its name is auto-generated (`DF__Coins__Dealer__3B75D760`) so it
-- cannot be hard-coded. Looking it up in sys.default_constraints is the only way
-- to remove it reliably.

DECLARE @DefaultName SYSNAME = NULL;
DECLARE @DropDefaultSql NVARCHAR(500);

SELECT @DefaultName = dc.name
FROM sys.default_constraints AS dc
INNER JOIN sys.columns AS c
    ON  c.object_id = dc.parent_object_id
    AND c.column_id = dc.parent_column_id
WHERE dc.parent_object_id = OBJECT_ID('Coins')   -- Coins ONLY.
  AND c.name = 'Dealer';

IF @DefaultName IS NULL
BEGIN
    PRINT 'Migration 006: no DEFAULT constraint on Coins.Dealer - nothing to drop.';
END
ELSE
BEGIN
    SET @DropDefaultSql = N'ALTER TABLE Coins DROP CONSTRAINT ' + QUOTENAME(@DefaultName) + N';';
    EXEC sp_executesql @DropDefaultSql;

    PRINT 'Migration 006: dropped DEFAULT constraint ' + @DefaultName + ' from Coins.Dealer.';
END
GO

-- ============================================================
-- STEP 3: drop the column itself
-- ============================================================
-- Only now, with no index and no constraint left pointing at it, can the column
-- go. COL_LENGTH returns NULL for a column that does not exist, which makes it
-- the cheapest honest guard: it asks the database directly instead of trusting
-- that step 1 and step 2 ran in this session.
--
-- This is the irreversible statement. Everything above was either read-only or
-- affected derived objects that could be rebuilt; this physically removes the
-- values counted in step 0.

IF COL_LENGTH('Coins', 'Dealer') IS NOT NULL
BEGIN
    ALTER TABLE Coins DROP COLUMN Dealer;

    PRINT 'Migration 006: Coins.Dealer DROPPED.';
END
ELSE
BEGIN
    PRINT 'Migration 006: Coins.Dealer does not exist - nothing to do.';
END
GO

-- ============================================================
-- SUMMARY
-- ============================================================
-- Reports the end state plainly, so the outcome is visible without writing a
-- separate query. This runs in its own batch, after the three steps above, and
-- re-reads the catalog rather than trusting what those batches believed.
--
-- Transactions.Dealer is reported too -- not because this script touches it,
-- but because "the other Dealer column is still there" is exactly the thing a
-- reader of this log will want confirmed.

DECLARE @CoinColumnGone  BIT = CASE WHEN COL_LENGTH('Coins', 'Dealer') IS NULL THEN 1 ELSE 0 END;
DECLARE @CoinIndexGone   BIT = CASE WHEN NOT EXISTS (
                                        SELECT 1 FROM sys.indexes
                                        WHERE object_id = OBJECT_ID('Coins')
                                          AND name = 'IX_Coins_Dealer')
                                   THEN 1 ELSE 0 END;
DECLARE @TxnColumnThere  BIT = CASE WHEN COL_LENGTH('Transactions', 'Dealer') IS NULL THEN 0 ELSE 1 END;

PRINT '';
PRINT '--- Dealer columns after migration 006 ---';

IF @CoinColumnGone = 1
    PRINT 'Coins.Dealer .................... GONE.';
ELSE
    PRINT 'Coins.Dealer .................... STILL PRESENT - the drop did not take effect.';

IF @CoinIndexGone = 1
    PRINT 'IX_Coins_Dealer ................. GONE.';
ELSE
    PRINT 'IX_Coins_Dealer ................. STILL PRESENT - the drop did not take effect.';

IF @TxnColumnThere = 1
BEGIN
    PRINT 'Transactions.Dealer ............. PRESENT, as intended. Not touched by this script.';
END
ELSE
BEGIN
    PRINT 'Transactions.Dealer ............. MISSING - INVESTIGATE.';
    PRINT '                                  This script never removes it, so something else';
    PRINT '                                  did. The transaction form and GET /api/transactions';
    PRINT '                                  both depend on this column.';
END

PRINT '';

IF @CoinColumnGone = 1 AND @CoinIndexGone = 1
BEGIN
    PRINT 'Migration 006 complete. The coin-level dealer field is fully removed.';
END
ELSE
BEGIN
    PRINT 'Migration 006 did NOT finish cleanly. Re-run this script; every step is';
    PRINT 'guarded, so it will pick up wherever it left off.';
END

PRINT '';
PRINT 'Restart the API server afterwards so it is not holding a cached query plan';
PRINT 'built against the old column.';
GO
