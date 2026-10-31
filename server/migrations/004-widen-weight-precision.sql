-- ============================================================
-- 004-widen-weight-precision.sql
-- Coins.Weight and Coins.PmWeightGrams  ->  DECIMAL(12,5)
-- ============================================================
--
-- WHY
-- ---
-- Both of the Coins table's weight columns were DECIMAL(10,4) -- four decimal
-- places -- while the coin editor offers five. The fifth digit was silently
-- rounded away on save: type 0.12345, reopen the coin, read 0.1235. The form
-- was promising precision the database would not keep.
--
-- Rather than reduce what the editor displays, the columns are widened to
-- match it. Nothing currently stored needs the extra digit -- every figure in
-- the reference table (services/pm-reference.ts) is quoted to two decimals,
-- e.g. 30.09 g for a $20 Saint-Gaudens -- so this is about the fields no
-- longer lying about what they will keep.
--
--   Weight         the coin's GROSS weight, in troy ounces
--   PmWeightGrams  the weight of the PURE precious metal, in grams
--
-- Those two measure different things in different units, which is worth
-- stating because confusing them is exactly the bug that made every melt
-- value wrong (see computeMeltValue in services/inventory/inventory-metrics).
--
-- WHY (12,5) AND NOT (10,5)
-- -------------------------
-- DECIMAL(p,s) splits p total digits into s after the point and p-s before it.
-- The old (10,4) allowed six digits ahead of the point. Keeping p at 10 while
-- raising s to 5 would leave only five, which NARROWS the integer side: a
-- stored value of 100000 or more would fail the conversion and abort the
-- ALTER. Going to (12,5) raises the integer capacity to seven instead, which
-- makes this a pure widening that cannot fail on any existing row. The extra
-- digits are free -- (10,4) and (12,5) occupy the same 9-byte storage class.
--
-- IS THIS SAFE ON LIVE DATA?
-- --------------------------
-- Yes, and that is the point of doing it this way rather than rebuilding the
-- table. Increasing both precision and scale is a widening conversion: SQL
-- Server rewrites each value in place, padding with a trailing zero (0.1235
-- becomes 0.12350). No value can overflow and nothing is truncated or
-- rounded. The table is not dropped, no data is copied out and back, and no
-- rows are touched beyond the in-place rewrite.
--
-- Neither column is indexed, and neither carries a constraint, computed
-- column or default, so there is nothing to drop and recreate around the
-- ALTER statements. (A DECIMAL column participating in an index or a CHECK
-- would need that object dropped first -- check sys.indexes and
-- sys.check_constraints before attempting the same elsewhere.)
--
-- NULL is restated explicitly on both. ALTER COLUMN does NOT inherit existing
-- nullability: omit it and the column becomes NOT NULL, at which point the
-- statement fails against every row where the weight is unknown -- which is
-- most of them.
--
-- HOW TO RUN IT
-- -------------
--   sqlcmd -S localhost -d CoinInventory -E -i .\migrations\004-widen-weight-precision.sql
--
-- ...or open it in SSMS / Azure Data Studio with CoinInventory selected and
-- press Execute. Running it twice is harmless: each guard reads the column's
-- current precision and scale, so a second run reports "nothing to do".
-- ============================================================

USE CoinInventory;
GO

-- A tiny helper pattern used twice below. The guard reads each column's ACTUAL
-- precision and scale out of the catalog rather than tracking which migrations
-- have run. That makes the script self-describing -- it asks the database what
-- shape the column is in and acts only if it is not already correct -- and it
-- means the file is a no-op on a database built fresh from setup-database.sql,
-- where both columns are created at (12,5).

-- ----- Coins.Weight (gross weight, troy ounces) -----
IF EXISTS (
    SELECT 1
    FROM sys.columns AS c
    WHERE c.object_id = OBJECT_ID('Coins')
      AND c.name = 'Weight'
      AND (c.precision <> 12 OR c.scale <> 5)
)
BEGIN
    ALTER TABLE Coins
        ALTER COLUMN Weight DECIMAL(12, 5) NULL;

    PRINT 'Migration 004: widened Coins.Weight to DECIMAL(12,5).';
END
ELSE IF COL_LENGTH('Coins', 'Weight') IS NULL
BEGIN
    -- Should never happen: the column is part of the baseline schema. Reported
    -- rather than ignored, because silently doing nothing would leave the app
    -- writing to a column that does not exist.
    PRINT 'Migration 004: WARNING - Coins.Weight does not exist. Has setup-database.sql been run?';
END
ELSE
BEGIN
    PRINT 'Migration 004: Coins.Weight is already DECIMAL(12,5) - nothing to do.';
END
GO

-- ----- Coins.PmWeightGrams (pure precious metal, grams) -----
IF EXISTS (
    SELECT 1
    FROM sys.columns AS c
    WHERE c.object_id = OBJECT_ID('Coins')
      AND c.name = 'PmWeightGrams'
      AND (c.precision <> 12 OR c.scale <> 5)
)
BEGIN
    ALTER TABLE Coins
        ALTER COLUMN PmWeightGrams DECIMAL(12, 5) NULL;

    PRINT 'Migration 004: widened Coins.PmWeightGrams to DECIMAL(12,5).';
END
ELSE IF COL_LENGTH('Coins', 'PmWeightGrams') IS NULL
BEGIN
    PRINT 'Migration 004: WARNING - Coins.PmWeightGrams does not exist. Has setup-database.sql been run?';
END
ELSE
BEGIN
    PRINT 'Migration 004: Coins.PmWeightGrams is already DECIMAL(12,5) - nothing to do.';
END
GO

-- ============================================================
-- SUMMARY
-- ============================================================
-- Prints the resulting shape of both columns so the outcome is visible without
-- writing a separate query, along with how many coins actually carry each
-- figure. A zero count is not a failure -- it just means no coin records that
-- value yet.
DECLARE @WeightPrecision INT, @WeightScale INT, @PmPrecision INT, @PmScale INT;

SELECT @WeightPrecision = c.precision, @WeightScale = c.scale
FROM sys.columns AS c
WHERE c.object_id = OBJECT_ID('Coins') AND c.name = 'Weight';

SELECT @PmPrecision = c.precision, @PmScale = c.scale
FROM sys.columns AS c
WHERE c.object_id = OBJECT_ID('Coins') AND c.name = 'PmWeightGrams';

DECLARE @WithWeight INT =
    (SELECT COUNT(*) FROM Coins WHERE Weight IS NOT NULL AND Weight > 0);
DECLARE @WithPmWeight INT =
    (SELECT COUNT(*) FROM Coins WHERE PmWeightGrams IS NOT NULL AND PmWeightGrams > 0);

PRINT '';
PRINT '--- Coins weight columns after migration 004 ---';
PRINT 'Weight .......................... DECIMAL(' + CAST(@WeightPrecision AS NVARCHAR(10))
    + ',' + CAST(@WeightScale AS NVARCHAR(10)) + ')   rows with a value: '
    + CAST(@WithWeight AS NVARCHAR(20));
PRINT 'PmWeightGrams ................... DECIMAL(' + CAST(@PmPrecision AS NVARCHAR(10))
    + ',' + CAST(@PmScale AS NVARCHAR(10)) + ')   rows with a value: '
    + CAST(@WithPmWeight AS NVARCHAR(20));
PRINT '';
PRINT 'Migration 004 complete. Restart the API server so it picks up the change.';
GO
