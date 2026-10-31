-- ============================================================
-- 005-drop-coin-tags.sql
-- Remove the CoinTags table  ->  the "tags" feature is gone
-- ============================================================
--
-- WHY
-- ---
-- A coin used to have a list of free-text tags -- "key date", "rainbow
-- toning", "investment grade" -- stored one row per tag in a CoinTags table.
-- The feature was plumbed through every layer: the table existed, GET
-- /api/coins read and grouped the rows, PUT /api/coins/:id replaced them,
-- free-text search looked inside them, and the inventory grid had a Tags
-- column with its own formatter.
--
-- Every layer except one. There was never any way to ENTER a tag. The coin
-- editor had no input for it, bulk edit did not offer the field, and neither
-- the CSV importer nor the Quicken importer could set one -- all three paths
-- hard-coded an empty list. So the Tags column could only ever render a dash,
-- for every coin, forever.
--
-- Faced with "build the missing editor" or "drop the idea", the owner chose to
-- drop it. This migration is the database half of that removal; the
-- application half has already deleted the queries, the field and the column.
--
-- IS IT SAFE TO DROP THE TABLE?
-- -----------------------------
-- As far as OTHER database objects are concerned, yes, and the direction of
-- the dependency is the reason. CoinTags held a foreign key POINTING AT Coins
-- (FK_CoinTags_Coin -> Coins.CoinId, ON DELETE CASCADE). Nothing pointed back:
-- no other table has a foreign key to CoinTags, and the schema contains no
-- views, triggers, functions or stored procedures at all, so nothing else can
-- be referring to it either. The only object that belongs to the table is its
-- own index, IX_CoinTags_CoinId, and DROP TABLE takes that with it
-- automatically. There is nothing to drop first and nothing left dangling
-- afterwards. (Dropping a table on the OTHER side of a foreign key -- Coins,
-- say -- would be a different story: SQL Server would refuse until the
-- referencing constraint was gone.)
--
-- As far as the DATA is concerned, that is the question this script refuses to
-- answer on its own -- see below.
--
-- ************************************************************
-- *** WHY THIS SCRIPT WILL NOT ALWAYS DROP THE TABLE ***
-- ************************************************************
-- A migration that silently destroys data the owner did not know he had is
-- unacceptable, even when we are fairly sure there is none.
--
-- The reasoning says CoinTags must be empty: no code path could ever insert a
-- row, so where would a tag have come from? But "must be" is a deduction about
-- the application, and the database is a separate thing. Rows could have
-- arrived from a hand-written INSERT in SSMS, from an experiment, from a
-- restored backup of a different database, or from some earlier version of the
-- app nobody remembers. Nobody can inspect this particular database from here
-- to check, and DROP TABLE is not undoable.
--
-- So the script COUNTS FIRST and only then decides:
--
--   1. Table missing      -> say so, do nothing. (Already migrated, or the
--                            database was built fresh from the new
--                            setup-database.sql, which no longer creates it.)
--   2. Table empty        -> drop it, and report that it was dropped.
--   3. Table has rows     -> DO NOT DROP. Print a loud warning with the row
--                            count, a SELECT to inspect the data, and the
--                            exact DROP TABLE statement to run afterwards.
--
-- Case 3 is a deliberate stop, not a failure. The app already ignores the
-- table completely, so leaving it in place costs nothing and breaks nothing --
-- it just sits there until the owner has looked at what is in it. Run this
-- script again after he has dealt with it and it will take case 2 or case 1.
--
-- HOW TO RUN IT
-- -------------
--   sqlcmd -S localhost -d CoinInventory -E -i .\migrations\005-drop-coin-tags.sql
--
-- ...or open it in SSMS / Azure Data Studio with CoinInventory selected and
-- press Execute. Running it twice is harmless: the second run finds the table
-- already gone and reports case 1.
-- ============================================================

USE CoinInventory;
GO

-- ------------------------------------------------------------
-- The decision
-- ------------------------------------------------------------
-- Everything below is one batch because the row count has to be read before
-- the branch is taken, and @RowCount has to survive from one to the other.
--
-- The guard reads sys.objects (via OBJECT_ID) rather than recording which
-- migrations have run. That makes the script self-describing: it asks the
-- database what actually exists and acts on the answer, so it is correct no
-- matter what order things were applied in.

DECLARE @RowCount INT;

IF OBJECT_ID('CoinTags', 'U') IS NULL
BEGIN
    -- ----- CASE 1: already gone --------------------------------------------
    PRINT 'Migration 005: CoinTags does not exist - nothing to do.';
    PRINT '               (Either this migration already ran, or the database';
    PRINT '                was built from the current setup-database.sql, which';
    PRINT '                no longer creates the table.)';
END
ELSE
BEGIN
    -- The table is there. Find out whether anything is in it BEFORE deciding.
    -- A plain COUNT(*) is the right tool here: it is exact, and the table is
    -- tiny by construction. (sys.partitions.rows would be faster but is only
    -- approximate, and "approximately empty" is not good enough when the
    -- consequence of being wrong is destroyed data.)
    SELECT @RowCount = COUNT(*) FROM CoinTags;

    IF @RowCount = 0
    BEGIN
        -- ----- CASE 2: empty, so drop it -----------------------------------
        -- DROP TABLE also removes IX_CoinTags_CoinId, the primary key
        -- PK_CoinTags, and the foreign key FK_CoinTags_Coin. Nothing points at
        -- this table, so nothing else needs touching.
        DROP TABLE CoinTags;

        PRINT 'Migration 005: CoinTags was empty - table DROPPED.';
        PRINT '               Its index (IX_CoinTags_CoinId), primary key and';
        PRINT '               foreign key went with it. Nothing referenced the';
        PRINT '               table, so no other object was affected.';
    END
    ELSE
    BEGIN
        -- ----- CASE 3: it has rows, so STOP --------------------------------
        -- Nothing is deleted. The app ignores the table either way, so leaving
        -- it costs nothing; what matters is that the owner gets to look at
        -- whatever is in there before it disappears.
        PRINT '';
        PRINT '*********************************************************************';
        PRINT '*** Migration 005: STOPPED - CoinTags IS NOT EMPTY                ***';
        PRINT '*********************************************************************';
        PRINT '';
        PRINT 'The table holds ' + CAST(@RowCount AS NVARCHAR(20)) + ' row(s), so it has NOT been dropped.';
        PRINT '';
        PRINT 'This is unexpected: no version of the application could create a tag,';
        PRINT 'so these rows came from somewhere else - a manual INSERT, a restored';
        PRINT 'backup, or an experiment. They are not destroyed without you seeing';
        PRINT 'them first.';
        PRINT '';
        PRINT 'Nothing is broken in the meantime. The application no longer reads or';
        PRINT 'writes CoinTags at all, so the table is simply inert. You can leave it';
        PRINT 'exactly as it is for as long as you like.';
        PRINT '';
        PRINT 'TO SEE WHAT IS IN IT, run:';
        PRINT '';
        PRINT '    SELECT t.CoinId,';
        PRINT '           t.Tag,';
        PRINT '           c.Year,';
        PRINT '           c.Denomination,';
        PRINT '           c.CoinType';
        PRINT '    FROM CoinTags AS t';
        PRINT '    LEFT JOIN Coins AS c ON c.CoinId = t.CoinId';
        PRINT '    ORDER BY c.Denomination, c.Year, t.Tag;';
        PRINT '';
        PRINT 'TO KEEP A COPY before removing the table, run:';
        PRINT '';
        PRINT '    SELECT * INTO CoinTags_Backup FROM CoinTags;';
        PRINT '';
        PRINT 'THEN, once you are satisfied, remove the table with:';
        PRINT '';
        PRINT '    DROP TABLE CoinTags;';
        PRINT '';
        PRINT '(Or just run this migration again - it will take the "empty" path';
        PRINT ' once the rows are gone, or the "already dropped" path if you ran';
        PRINT ' the DROP yourself.)';
        PRINT '';
        PRINT '*********************************************************************';
    END
END
GO

-- ============================================================
-- SUMMARY
-- ============================================================
-- Reports the end state plainly, so the outcome is visible without writing a
-- separate query. This runs in its own batch, after the decision above, and
-- re-reads the catalog rather than trusting what the previous batch believed.
DECLARE @StillThere BIT = CASE WHEN OBJECT_ID('CoinTags', 'U') IS NULL THEN 0 ELSE 1 END;
DECLARE @Remaining INT = NULL;

IF @StillThere = 1
    SELECT @Remaining = COUNT(*) FROM CoinTags;

PRINT '';
PRINT '--- CoinTags after migration 005 ---';

IF @StillThere = 0
BEGIN
    PRINT 'CoinTags ........................ GONE. The tags feature is fully removed.';
END
ELSE
BEGIN
    PRINT 'CoinTags ........................ STILL PRESENT, holding '
        + CAST(@Remaining AS NVARCHAR(20)) + ' row(s).';
    PRINT 'Action needed ................... review the rows, then DROP TABLE CoinTags;';
END

PRINT '';
PRINT 'Migration 005 complete. The API server does not read CoinTags either way,';
PRINT 'so no restart is required for this change.';
GO
