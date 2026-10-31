-- ============================================================
-- 008-weight-to-grams.sql
-- Coins.Weight STOPS MEANING TROY OUNCES AND STARTS MEANING GRAMS
-- ============================================================
--
-- *** READ THE WHOLE HEADER BEFORE RUNNING THIS. ***
-- *** IT IS THE MOST DANGEROUS MIGRATION IN THIS FOLDER. ***
--
-- Everything from 002 to 007 either changed the SHAPE of the database (a
-- column added, a precision widened, a table dropped) or FILLED IN blanks
-- (007). Both of those are recoverable in an obvious way, and both can be
-- re-run without consequence: a column that already exists is not added
-- twice, and a cell that is already filled is not filled again.
--
-- This one is different in kind. It does not change the shape of anything and
-- it does not restrict itself to blanks. It REINTERPRETS values that are
-- already there, by rewriting each of them. Before this script, every number
-- in Coins.Weight is a count of TROY OUNCES. After it, every number in
-- Coins.Weight is a count of GRAMS.
--
--
-- WHY
-- ---
-- Coins has always had two weight columns measuring different things in
-- different units, which is a trap the project has already been bitten by
-- once (it is the root of the melt-value bug written up in the README):
--
--     Weight         the coin's GROSS weight, alloy included -- troy ounces
--     PmWeightGrams  the weight of the PURE precious metal   -- grams
--
-- Two adjacent fields, both called "weight", in two different units, with
-- only a schema comment to tell them apart. The owner had been reading the
-- gross Weight field as grams all along. When the contradiction between the
-- documentation ("Gross weight in troy ounces") and his understanding was put
-- to him explicitly, he chose to move the column to GRAMS rather than correct
-- his reading of it -- so that both weight fields on a coin are in the same
-- unit and the pair can be compared, and divided, without a conversion in the
-- reader's head.
--
-- That choice is what this script implements. It is a deliberate decision,
-- not a bug fix, and the previous documentation was not wrong -- it described
-- the old unit correctly.
--
-- He also asked for the blanks to be filled while we were in here: "might as
-- well fix the coin weight (total weight in grams), PM weight (grams), PM %.
-- Let's do it all. Most is still missing in the DB." PmWeightGrams, PmPercent,
-- MetalContent and Composition are migration 007's job. The gross Weight
-- column -- and ONLY the gross Weight column -- is this script's job.
--
--
-- ============================================================
-- THE HAZARD, STATED PLAINLY
-- ============================================================
-- One troy ounce is 31.1034768 grams. So the same stored number means two
-- wildly different coins depending on which unit you believe:
--
--     0.7734  read as troy ounces  ->  24.06 g  -- a Morgan silver dollar
--     0.7734  read as grams        ->   0.77 g  -- a scrap of foil
--
-- That is a 31x understatement, and -- this is the part that makes it
-- dangerous rather than merely wrong -- it does not LOOK broken. It is a
-- small positive decimal in a column of small positive decimals. Nothing
-- turns red. Nobody notices until someone tries to weigh a coin against it.
--
-- So the existing values MUST be multiplied by 31.1034768. Changing the label
-- in the user interface without converting the data would silently restate
-- the entire collection as 1/31st of its true weight.
--
--
-- ============================================================
-- WHY THIS MIGRATION GUARDS ITSELF DIFFERENTLY FROM 002-007
-- ============================================================
-- *** DO NOT "SIMPLIFY" THE MARKER ROW AWAY. IT IS LOAD-BEARING. ***
--
-- Every other migration in this folder guards itself by ASKING THE DATABASE
-- WHAT SHAPE IT IS IN:
--
--     004 reads sys.columns  -- "is Weight already DECIMAL(12,5)?"
--     005 reads OBJECT_ID    -- "does the CoinTags table still exist?"
--     006 reads COL_LENGTH   -- "is the Dealer column still there?"
--     007 reads the row      -- "is this cell still empty?"
--
-- Those are all SELF-DESCRIBING. The database itself carries the answer, so
-- the scripts need no memory of what has been run. That is why none of them
-- has a marker, and why re-running any of them is harmless.
--
-- THAT TECHNIQUE CANNOT WORK HERE, and it is worth being precise about why,
-- because the fix looks redundant until you see the problem:
--
--   - The column TYPE does not change. It is DECIMAL(12,5) before and
--     DECIMAL(12,5) after. sys.columns is identical either side.
--   - No table, index or constraint is created or dropped. OBJECT_ID and
--     COL_LENGTH are identical either side.
--   - The cells are NOT NULL before and NOT NULL after, so 007's "is it
--     still empty?" test has nothing to bite on.
--   - And the VALUES cannot be used as evidence either. A coin weighing
--     0.7734 of something and a coin weighing 24.05582 of something are both
--     perfectly legitimate rows. There is no number, and no range of numbers,
--     that means "this has already been converted". A 5 g coin and a 5 ozt
--     coin both exist.
--
-- NOTHING ANYWHERE IN THE DATABASE DISTINGUISHES THE BEFORE STATE FROM THE
-- AFTER STATE. Only the MEANING changed, and meaning is not stored.
--
-- And the operation is NOT IDEMPOTENT: running it twice multiplies twice.
-- 0.7734 ozt becomes 24.05582 g on the first run and 748.17 g on the second
-- -- which, again, is a plausible-looking number. (748 g is about the weight
-- of a 25-coin roll of silver dollars. Nobody would spot it in a grid.)
--
-- Therefore this script has to REMEMBER that it ran, and the only place to
-- put that memory is the database. It writes a row into AppSettings:
--
--     SettingKey    = 'migration-008-weight-grams'
--     SettingValue  = <UTC timestamp> | <rows converted> | <factor used>
--
-- AppSettings is the existing key/value store (see setup-database.sql; the
-- Angular app uses it for theme and column preferences through
-- server/routes/data/settings.ts). It is an ordinary table with no special
-- status, which is exactly why it is safe to borrow: adding one row to it
-- cannot affect anything else, and the key is namespaced so it cannot collide
-- with a UI preference.
--
-- The conversion step reads that key FIRST and does nothing at all if it is
-- present. Delete the marker and the conversion will happen again -- which is
-- correct if you have genuinely restored the old values from the backup, and
-- catastrophic if you have not. There is no other brake.
--
--
-- ============================================================
-- THE MARKER IS WRITTEN IN THE SAME TRANSACTION AS THE CONVERSION
-- ============================================================
-- This matters more than it looks, and it is why the backup, the conversion
-- and the marker are a single BEGIN TRANSACTION ... COMMIT block rather than
-- three separately guarded steps in the house style of 006.
--
-- If the marker were written afterwards, in its own statement, there would be
-- a window -- however brief -- in which the data had been multiplied but the
-- marker had not been written. A crash, a lost connection or a Ctrl-C in that
-- window would leave a database that had been converted but did not know it,
-- and the next run of this script would multiply everything a second time.
-- That is precisely the disaster the marker exists to prevent, so the marker
-- must not be able to lag behind the thing it records.
--
-- With SET XACT_ABORT ON and one transaction around all three, there are only
-- two possible outcomes:
--
--     COMMIT     -> values converted AND backup taken AND marker written
--     ROLLBACK   -> none of those happened; the database is untouched
--
-- There is no third state, so the marker is always a truthful answer to "have
-- these numbers been multiplied?".
--
-- The blank-filling step (step 4) sits OUTSIDE that transaction, on purpose.
-- It is naturally idempotent -- it only ever writes to rows whose Weight is
-- still missing -- so it is safe to run on every invocation, and it SHOULD be
-- re-runnable: as 007 and the owner fill in more PmWeightGrams / PmPercent
-- values over time, re-running this file will derive the gross weights that
-- have newly become derivable. It is guarded on the marker being PRESENT,
-- because a value it writes is already in grams and must never be fed to the
-- conversion.
--
--
-- ============================================================
-- ORDERING: THIS MUST RUN **AFTER** 007
-- ============================================================
--     002 -> 003 -> 004 -> 005 -> 006 -> 007 -> 008
--                                        ^^^^^^^^^^
-- Step 4 derives a missing gross weight from PmWeightGrams and PmPercent.
-- Migration 007 is what populates those columns for the existing collection.
-- Run 008 first and step 4 finds almost nothing to work with, because the
-- inputs it needs are still blank.
--
-- Getting the order wrong is RECOVERABLE, which is worth knowing: just run
-- this file again after 007. The marker makes the conversion skip itself on
-- the second run, and step 4 -- which is outside the marker guard -- picks up
-- every row that 007 has since made derivable. No harm done.
--
--
-- ============================================================
-- THE BACKUP, AND HOW TO UNDO THIS
-- ============================================================
-- Before converting anything, step 2 snapshots the ENTIRE column:
--
--     SELECT CoinId, Weight INTO Coins_Weight_TroyOz_Backup FROM Coins;
--
-- Note there is no WHERE clause. Every row is captured, including the ones
-- whose Weight is NULL. That is deliberate and it is what makes the undo
-- complete: the NULL rows are exactly the ones step 4 may go on to FILL, so
-- without them in the snapshot there would be no record that those cells were
-- once empty, and a restore would leave invented values behind.
--
-- The table name says the unit out loud -- Coins_Weight_TroyOz_Backup -- so
-- that somebody who finds it in a year knows what is in it without having to
-- find this file.
--
-- TO RESTORE THE OLD TROY-OUNCE VALUES:
--
--     USE CoinInventory;
--
--     UPDATE c
--     SET    c.Weight = b.Weight
--     FROM   Coins AS c
--     INNER JOIN Coins_Weight_TroyOz_Backup AS b ON b.CoinId = c.CoinId;
--
--     DELETE FROM AppSettings WHERE SettingKey = 'migration-008-weight-grams';
--
-- The UPDATE puts back the troy-ounce figures AND re-blanks anything step 4
-- filled, because the snapshot holds the NULLs too. The DELETE removes the
-- marker, which re-arms this script. Do BOTH or neither: leaving the marker
-- in place after a restore means the column holds troy ounces while the
-- marker claims grams, and re-running will not fix it.
--
-- Coins added AFTER this migration ran will not appear in the backup table,
-- so the restore leaves them alone. Their weights were entered in grams
-- through a user interface labelled "(g)", so there is nothing to undo about
-- them -- but be aware that a restore therefore produces a column with MIXED
-- units, which is only acceptable as a step on the way to re-running this
-- file. It is not a resting state.
--
-- The backup table is NOT dropped by this script. It costs two columns per
-- coin and it is the only copy of the old numbers. Drop it by hand, once, if
-- and when you are certain:
--
--     DROP TABLE Coins_Weight_TroyOz_Backup;
--
--
-- ============================================================
-- WHAT THIS SCRIPT DOES **NOT** TOUCH
-- ============================================================
--   PmWeightGrams  -- already grams, already correct. Never written here.
--   PmPercent      -- read in step 4, never written. Migration 007 owns it.
--   MetalContent   -- not referenced. Migration 007 owns it.
--   Composition    -- not referenced. Migration 007 owns it.
--
-- MELT VALUE IS UNAFFECTED BY ANY OF THIS. The melt calculation
-- (src/app/services/inventory/inventory-metrics.ts, computeMeltValue) is
--
--     (pmWeightGrams / 31.1035) * spotPricePerTroyOunce
--
-- and the gross Weight column does not appear in it anywhere. It never did --
-- that is the whole point of the two fields being separate. So every melt
-- value in the application reads exactly the same before and after this
-- migration. Nothing about melt needs changing, and nothing about melt was
-- changed.
--
--
-- HOW TO RUN IT
-- -------------
--   sqlcmd -S localhost -d CoinInventory -E -i .\migrations\008-weight-to-grams.sql
--
-- ...or open it in SSMS / Azure Data Studio with CoinInventory selected and
-- press Execute. Read the output: step 0 reports what is about to happen, and
-- the summary at the end prints the resulting min / max / average so that a
-- unit mistake is visible at a glance. US coins run from about 0.5 g (a gold
-- dollar) to about 54 g (a Trade dollar is 27 g; a 5 oz ATB silver round is
-- 155 g). A column averaging 0.8, or 900, is wrong.
-- ============================================================

USE CoinInventory;
GO

SET XACT_ABORT ON;
GO


-- ============================================================
-- STEP 0: report the current state, before anything is written
-- ============================================================
-- Read-only. Its job is to put on the record what the column looked like going
-- in, so the log alone is enough to reconstruct what happened.
--
-- It also prints the current average, which is the single most useful number
-- here: a column of troy ounces averages well under 2, and a column of grams
-- averages tens. If this step prints an average of 25 on a database you
-- believe has never been converted, STOP -- somebody has already run this and
-- removed the marker, and converting again would be the 31x disaster.

DECLARE @Step0Total       INT;
DECLARE @Step0WithWeight  INT;
DECLARE @Step0Blank       INT;
DECLARE @Step0Avg         DECIMAL(12,5);
DECLARE @Step0MarkerSeen  INT;

SELECT @Step0Total      = COUNT(*),
       @Step0WithWeight = COUNT(CASE WHEN Weight IS NOT NULL AND Weight <> 0 THEN 1 END),
       @Step0Blank      = COUNT(CASE WHEN Weight IS NULL OR Weight = 0 THEN 1 END),
       @Step0Avg        = AVG(CASE WHEN Weight IS NOT NULL AND Weight <> 0 THEN Weight END)
FROM Coins;

SELECT @Step0MarkerSeen = COUNT(*)
FROM AppSettings
WHERE SettingKey = N'migration-008-weight-grams';

PRINT '';
PRINT '============================================================';
PRINT ' Migration 008: Coins.Weight, troy ounces -> grams';
PRINT '============================================================';
PRINT 'Coins in the table ................... ' + CAST(@Step0Total AS NVARCHAR(20));
PRINT 'With a Weight recorded ............... ' + CAST(@Step0WithWeight AS NVARCHAR(20));
PRINT 'With Weight blank or zero ............ ' + CAST(@Step0Blank AS NVARCHAR(20));
PRINT 'Average of the recorded weights ...... '
    + ISNULL(CAST(@Step0Avg AS NVARCHAR(30)), '(none recorded)');

IF @Step0MarkerSeen > 0
BEGIN
    PRINT '';
    PRINT 'The marker row IS PRESENT, so the conversion has already been done.';
    PRINT 'Steps 1-3 will skip. Step 4 (fill derivable blanks) will still run --';
    PRINT 'that is intentional, see the header.';
END
ELSE
BEGIN
    PRINT '';
    PRINT 'The marker row is ABSENT, so the conversion has NOT been done on this';
    PRINT 'database. Every recorded weight above is a TROY OUNCE figure and is';
    PRINT 'about to be multiplied by 31.1034768.';
    IF @Step0Avg IS NOT NULL AND @Step0Avg > 10
    BEGIN
        PRINT '';
        PRINT '*** WARNING: that average looks like GRAMS, not troy ounces. ***';
        PRINT '*** A collection of coins measured in troy ounces averages   ***';
        PRINT '*** well under 2. If these numbers are already grams, this   ***';
        PRINT '*** script is about to multiply them by 31 for a second      ***';
        PRINT '*** time. STOP and check before letting it continue.         ***';
        PRINT '';
        PRINT 'This is a WARNING, not a refusal -- a collection of large bullion';
        PRINT 'pieces could legitimately average over 10 troy ounces. Only you';
        PRINT 'know which it is.';
    END
END
PRINT '';
GO


-- ============================================================
-- STEPS 1, 2, 3 and 5 -- ONE ATOMIC BLOCK
--   1. guard on the marker
--   2. back the column up
--   3. convert troy ounces -> grams
--   5. write the marker
-- ============================================================
-- The brief numbers these 1, 2, 3 and 5, with the blank-fill as step 4 in
-- between. They are executed together here, and step 4 is moved after them,
-- for the reason set out at length in the header: the marker must not be able
-- to lag behind the multiplication it records, so it has to commit in the same
-- transaction. Step 4 does not need to be in that transaction, is idempotent
-- on its own, and in fact must run AFTER the conversion so that the gram
-- values it writes are never multiplied.
--
-- Each of the four still carries its own guard, in the house style of 006 --
-- the transaction is belt AND braces, not a replacement for the guards.

-- Both counters are declared up here, outside the TRY, and filled with SET
-- immediately after the statement they are counting. @@ROWCOUNT is reset by
-- the very next statement, so it has to be captured on the line after -- and
-- capturing it in a DECLARE ... = @@ROWCOUNT is the kind of thing that works
-- until the day it does not. SET on its own line is unambiguous.
DECLARE @BackedUp  INT = 0;
DECLARE @Converted INT = 0;

BEGIN TRY

    -- ----- preflight: AppSettings must exist -------------------------------
    -- Without it there is nowhere to record that the conversion happened, and
    -- an unrecorded conversion is worse than no conversion: the next run would
    -- multiply a second time. So this is a hard stop, not a warning.
    IF OBJECT_ID('AppSettings', 'U') IS NULL
    BEGIN
        PRINT 'Migration 008: FATAL - the AppSettings table does not exist.';
        PRINT '               This script records that it has run by writing a row';
        PRINT '               into AppSettings, and it refuses to convert anything';
        PRINT '               it cannot record. Run setup-database.sql (or create';
        PRINT '               the table) and try again.';
        THROW 50008, 'Migration 008 aborted: AppSettings table is missing.', 1;
    END

    IF COL_LENGTH('Coins', 'Weight') IS NULL
    BEGIN
        PRINT 'Migration 008: FATAL - Coins.Weight does not exist.';
        PRINT '               Has setup-database.sql been run against this database?';
        THROW 50008, 'Migration 008 aborted: Coins.Weight is missing.', 1;
    END

    -- ----- STEP 1: the guard ----------------------------------------------
    -- The one and only thing standing between this collection and a 31x error.
    IF EXISTS (SELECT 1 FROM AppSettings WHERE SettingKey = N'migration-008-weight-grams')
    BEGIN
        PRINT 'Migration 008 / steps 1-3: marker ''migration-008-weight-grams'' is';
        PRINT '                           already present. The conversion has run.';
        PRINT '                           SKIPPING - nothing is multiplied.';
    END
    ELSE
    BEGIN

        -- ----- the ambiguous state: backup exists but marker does not -----
        -- This cannot arise from a normal run or a normal failure, because the
        -- backup and the marker commit together. It means somebody has
        -- intervened by hand: taken the backup separately, deleted the marker,
        -- or restored a database mid-way. Overwriting the backup here would
        -- destroy the only copy of the original troy-ounce numbers, so this
        -- stops and asks for a human instead of guessing.
        IF OBJECT_ID('Coins_Weight_TroyOz_Backup', 'U') IS NOT NULL
        BEGIN
            PRINT 'Migration 008: FATAL - Coins_Weight_TroyOz_Backup already exists,';
            PRINT '               but the marker row does not. These two are written in';
            PRINT '               the same transaction, so this combination cannot happen';
            PRINT '               by itself -- somebody has intervened by hand.';
            PRINT '';
            PRINT '               Refusing to continue, because the two possible readings';
            PRINT '               need opposite actions:';
            PRINT '';
            PRINT '               (a) The conversion DID run and the marker was deleted.';
            PRINT '                   Coins.Weight is already grams. Put the marker back:';
            PRINT '                     INSERT INTO AppSettings (SettingKey, SettingValue)';
            PRINT '                     VALUES (N''migration-008-weight-grams'', N''restored by hand'');';
            PRINT '';
            PRINT '               (b) The conversion did NOT run and the backup was taken';
            PRINT '                   by hand beforehand. Coins.Weight is still troy ounces.';
            PRINT '                   Rename the old backup out of the way and re-run:';
            PRINT '                     EXEC sp_rename ''Coins_Weight_TroyOz_Backup'', ''Coins_Weight_TroyOz_Backup_old'';';
            PRINT '';
            PRINT '               Compare the average printed by step 0 against the header''s';
            PRINT '               guidance (troy ounces average under 2; grams average tens)';
            PRINT '               to work out which one you are looking at.';
            THROW 50008, 'Migration 008 aborted: backup table present without marker row.', 1;
        END

        BEGIN TRANSACTION;

        -- ----- STEP 2: back up the whole column ---------------------------
        -- No WHERE clause, on purpose. See the header: capturing the NULL rows
        -- as well is what lets a restore also undo step 4's fills.
        SELECT CoinId, Weight
        INTO   Coins_Weight_TroyOz_Backup
        FROM   Coins;

        SET @BackedUp = @@ROWCOUNT;

        PRINT 'Migration 008 / step 2: backed up ' + CAST(@BackedUp AS NVARCHAR(20))
            + ' row(s) into Coins_Weight_TroyOz_Backup.';

        -- ----- STEP 3: the conversion -------------------------------------
        -- 31.1034768 g per troy ounce. This is the exact definition of the
        -- troy ounce, not an approximation -- it is written in full rather than
        -- as the 31.1035 used in the melt calculation, because here it is
        -- rewriting stored data rather than computing a display value.
        --
        -- The arithmetic: DECIMAL(12,5) x the literal 31.1034768 produces a
        -- wide intermediate (SQL Server gives multiplication p1+p2+1 digits of
        -- precision), well inside the 38-digit maximum, which is then rounded
        -- back to the column's 5 decimals on assignment. So 0.77340 becomes
        -- 24.05582 -- no truncation, one rounding, at the end.
        --
        -- Overflow would need a weight above ~321,508 troy ounces (10 tonnes),
        -- which is not a coin. If it somehow happened the UPDATE would raise an
        -- arithmetic overflow, XACT_ABORT would roll the whole transaction back
        -- and the marker would never be written -- so the database would be
        -- left untouched and safe to retry.
        --
        -- The filter is `IS NOT NULL AND <> 0` rather than `> 0`:
        --   - NULL has no unit to convert.
        --   - 0 troy ounces is 0 grams, so converting it is a no-op; excluding
        --     it keeps the reported count honest and leaves it visible to
        --     step 4, which treats a zero gross weight as the blank it really
        --     is (no coin weighs nothing).
        --   - a NEGATIVE weight is nonsense data, but it is nonsense data IN
        --     TROY OUNCES, so it is converted along with everything else
        --     rather than being quietly left in the old unit. `> 0` would have
        --     stranded it.
        UPDATE Coins
        SET    Weight = CAST(Weight * 31.1034768 AS DECIMAL(12,5))
        WHERE  Weight IS NOT NULL
          AND  Weight <> 0;

        SET @Converted = @@ROWCOUNT;

        PRINT 'Migration 008 / step 3: CONVERTED ' + CAST(@Converted AS NVARCHAR(20))
            + ' weight(s) from troy ounces to grams (x 31.1034768).';

        -- ----- STEP 5: write the marker -----------------------------------
        -- Committed with the UPDATE above, so it can never be missing from a
        -- database whose numbers have been multiplied.
        --
        -- The value is informational only -- nothing reads it; the KEY is what
        -- matters. It records when, how many rows and with what factor, so the
        -- row itself explains what it is to somebody who finds it in
        -- AppSettings next to 'theme' and 'visibleColumns' and wonders.
        INSERT INTO AppSettings (SettingKey, SettingValue)
        VALUES (
            N'migration-008-weight-grams',
            CONVERT(NVARCHAR(30), SYSUTCDATETIME(), 126)
                + N'Z | Coins.Weight converted from troy ounces to grams'
                + N' | rows converted: ' + CAST(@Converted AS NVARCHAR(20))
                + N' | factor: 31.1034768'
                + N' | prior values in Coins_Weight_TroyOz_Backup'
        );

        PRINT 'Migration 008 / step 5: marker ''migration-008-weight-grams'' written.';

        COMMIT TRANSACTION;

        PRINT 'Migration 008 / steps 1-3,5: committed. Coins.Weight is now GRAMS.';
    END

END TRY
BEGIN CATCH
    -- XACT_ABORT ON means an error has already doomed the transaction; this
    -- just makes the rollback explicit and reports it, rather than leaving the
    -- caller to work out from a bare error number that nothing was applied.
    -- Note the three preflight THROWs above fire BEFORE any transaction is
    -- opened, so XACT_STATE() is 0 for them and there is nothing to roll back
    -- -- which is itself the correct outcome, since none of them had written
    -- anything yet.
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;

    PRINT '';
    PRINT 'Migration 008: NOTHING WAS APPLIED. No weight was multiplied, no marker';
    PRINT '               row was written, and the backup table was not created by';
    PRINT '               this run. Coins.Weight still holds whatever it held before';
    PRINT '               the script started, so it is safe to fix the cause and run';
    PRINT '               the file again.';
    PRINT '';
    PRINT '               (If the error below was the "backup table present without';
    PRINT '                marker" refusal, the backup table you can see was already';
    PRINT '                there -- this run did not make it and has not touched it.)';
    PRINT '';

    THROW;
END CATCH
GO


-- ============================================================
-- STEP 4: fill in gross weights that can be DERIVED
-- ============================================================
-- Numbered 4 in the brief, executed last. See the header for why: a value
-- written here is already in grams, and must therefore never be visible to
-- step 3's multiplication.
--
-- THE ARITHMETIC IS EXACT, NOT A LOOKUP OR AN ESTIMATE
-- ----------------------------------------------------
-- For a precious-metal coin the gross weight is not something that has to be
-- looked up in a reference table. It follows from two numbers the row already
-- holds, by the definition of what a percentage is:
--
--     PmWeightGrams = gross grams x (PmPercent / 100)
--
-- ...which rearranges to
--
--     gross grams   = PmWeightGrams / (PmPercent / 100)
--                   = PmWeightGrams x 100 / PmPercent
--
-- Worked through on a 1927 $20 Saint-Gaudens, the example used throughout
-- pm-reference.ts: PmWeightGrams is 30.09 and PmPercent is 90, so the gross
-- weight is 30.09 x 100 / 90 = 33.433 g. The catalogue figure is 33.436 g.
-- The small difference is the rounding already present in the 30.09, not an
-- error in the method -- and a gross weight accurate to three hundredths of a
-- gram is enormously better than the blank it replaces.
--
-- WHY NOTHING ELSE IS FILLED IN
-- -----------------------------
-- Base-metal coins -- a Lincoln cent, a clad quarter, a nickel -- have no
-- PmWeightGrams, so this arithmetic has no inputs and there is nothing in the
-- database from which their gross weight could be derived. The only way to
-- supply one would be a hard-coded table of catalogue weights keyed on
-- denomination and year, which is a different and much larger piece of work,
-- would duplicate reference data that already lives in the TypeScript (see
-- 007's header on exactly this point), and would be guessing wherever the
-- row's denomination or year is itself uncertain.
--
-- A blank weight is honest. An invented one is not, and is worse, because a
-- blank gets filled in later by somebody with a scale whereas a wrong number
-- is believed. So those rows are deliberately LEFT ALONE and counted as such
-- in the summary.
--
-- IDEMPOTENCE
-- -----------
-- This step writes only where the gross weight is still missing, so running it
-- repeatedly is harmless -- the rows it has already filled no longer match its
-- WHERE clause. It is deliberately NOT inside the marker guard, so that
-- re-running this file after 007 (or after hand-entering more PM data) picks
-- up rows that have newly become derivable.

IF NOT EXISTS (SELECT 1 FROM AppSettings WHERE SettingKey = N'migration-008-weight-grams')
BEGIN
    -- Defensive: if the conversion did not happen, the column is still troy
    -- ounces and writing grams into it would produce a column of MIXED units
    -- -- the single worst outcome available here, and one that no later run
    -- could untangle, because there would be no way to tell which rows were
    -- which.
    PRINT 'Migration 008 / step 4: SKIPPED - the conversion marker is absent, so';
    PRINT '                        Coins.Weight is still in troy ounces. Writing';
    PRINT '                        gram values into it now would mix the two units';
    PRINT '                        irreversibly.';
END
ELSE
BEGIN
    DECLARE @Fillable INT;

    -- The conditions, one at a time:
    --
    --   Weight IS NULL OR Weight = 0
    --       only fill what is actually missing. A zero counts as missing: no
    --       coin weighs nothing, so a 0 is a blank somebody typed, and it was
    --       deliberately passed over by step 3 for this reason.
    --
    --   PmWeightGrams IS NOT NULL AND PmWeightGrams > 0
    --       the numerator must be real. A zero or missing PM weight makes the
    --       sum either 0 or undefined.
    --
    --   PmPercent IS NOT NULL AND PmPercent > 0
    --       required by the brief, and necessary anyway: dividing by zero
    --       raises Msg 8134 and would abort the statement.
    --
    --   PmPercent <= 100
    --       not in the brief, added because a fineness above 100% is corrupt
    --       data and the sum would return a gross weight SMALLER than the pure
    --       metal inside it -- physically impossible. Such a row is excluded
    --       and left blank rather than given an impossible weight.
    SELECT @Fillable = COUNT(*)
    FROM Coins
    WHERE (Weight IS NULL OR Weight = 0)
      AND PmWeightGrams IS NOT NULL AND PmWeightGrams > 0
      AND PmPercent     IS NOT NULL AND PmPercent > 0 AND PmPercent <= 100;

    IF @Fillable = 0
    BEGIN
        PRINT 'Migration 008 / step 4: no blank weight can be derived from the';
        PRINT '                        PmWeightGrams / PmPercent pair - nothing to fill.';
        PRINT '                        (If that is a surprise, check that migration 007';
        PRINT '                         has been run: it is what populates those two.)';
    END
    ELSE
    BEGIN
        -- `* 100.0` rather than `* 100` keeps the whole expression in decimal
        -- arithmetic. The explicit CAST pins the result to the column's own
        -- DECIMAL(12,5) so the rounding happens once, here, visibly, rather
        -- than being left to an implicit conversion on assignment.
        UPDATE Coins
        SET    Weight = CAST(PmWeightGrams * 100.0 / PmPercent AS DECIMAL(12,5))
        WHERE (Weight IS NULL OR Weight = 0)
          AND PmWeightGrams IS NOT NULL AND PmWeightGrams > 0
          AND PmPercent     IS NOT NULL AND PmPercent > 0 AND PmPercent <= 100;

        PRINT 'Migration 008 / step 4: FILLED ' + CAST(@@ROWCOUNT AS NVARCHAR(20))
            + ' blank gross weight(s), derived as PmWeightGrams / (PmPercent / 100).';
    END
END
GO


-- ============================================================
-- SUMMARY
-- ============================================================
-- Re-reads everything from the table rather than trusting what the batches
-- above believed, in the house style of 004 and 006.
--
-- The min / max / average exist to make a unit mistake visible without anyone
-- having to write a query. A gram figure for a coin is a number you can sanity
-- check by eye, which a troy-ounce figure is not:
--
--     US gold dollar (smallest US coin) .....    1.67 g
--     Lincoln cent ..........................    2.50 g
--     Mercury dime ..........................    2.50 g
--     Morgan / Peace dollar .................   26.73 g
--     $20 Saint-Gaudens .....................   33.44 g
--     1 oz American Silver Eagle ............   31.10 g
--     5 oz ATB silver round .................  155.52 g
--
-- So: a minimum below about 0.5, or an average under 2, means the conversion
-- did not happen and the column is still troy ounces. A maximum in the
-- thousands means something has been multiplied twice.

DECLARE @Total       INT;
DECLARE @WithWeight  INT;
DECLARE @StillBlank  INT;
DECLARE @Derivable   INT;
DECLARE @MinW        DECIMAL(12,5);
DECLARE @MaxW        DECIMAL(12,5);
DECLARE @AvgW        DECIMAL(12,5);
DECLARE @MarkerValue NVARCHAR(MAX);
DECLARE @BackupRows  INT = NULL;

SELECT @Total      = COUNT(*),
       @WithWeight = COUNT(CASE WHEN Weight IS NOT NULL AND Weight > 0 THEN 1 END),
       @StillBlank = COUNT(CASE WHEN Weight IS NULL OR Weight <= 0 THEN 1 END),
       @MinW       = MIN(CASE WHEN Weight > 0 THEN Weight END),
       @MaxW       = MAX(CASE WHEN Weight > 0 THEN Weight END),
       @AvgW       = AVG(CASE WHEN Weight > 0 THEN Weight END)
FROM Coins;

-- How many of the remaining blanks COULD still be derived? On a clean run this
-- is 0. Anything else means step 4 was skipped or something new arrived since.
SELECT @Derivable = COUNT(*)
FROM Coins
WHERE (Weight IS NULL OR Weight <= 0)
  AND PmWeightGrams IS NOT NULL AND PmWeightGrams > 0
  AND PmPercent     IS NOT NULL AND PmPercent > 0 AND PmPercent <= 100;

-- The next two reads go through sp_executesql for the reason migration 006
-- spells out in its STEP 0: a batch is compiled as a whole before any of it
-- runs, so a plain reference to an object that is not there can fail the
-- WHOLE batch at compile time -- the guarding IF never gets a chance to be
-- false. Both of these objects are genuinely optional from this batch's point
-- of view:
--
--   AppSettings ...................... absent only on a broken database, but
--                                      this summary is exactly what somebody
--                                      debugging a broken database will want
--                                      to read, so it must not blow up.
--   Coins_Weight_TroyOz_Backup ....... absent whenever the conversion was
--                                      skipped or rolled back. That is a
--                                      completely normal second-run state.
--
-- Hiding the reference in a string defers it to execution time, where the
-- OBJECT_ID guard above it actually protects it.

IF OBJECT_ID('AppSettings', 'U') IS NOT NULL
    EXEC sp_executesql
        N'SELECT @Out = SettingValue FROM AppSettings
          WHERE SettingKey = N''migration-008-weight-grams'';',
        N'@Out NVARCHAR(MAX) OUTPUT',
        @Out = @MarkerValue OUTPUT;

IF OBJECT_ID('Coins_Weight_TroyOz_Backup', 'U') IS NOT NULL
    EXEC sp_executesql
        N'SELECT @Out = COUNT(*) FROM Coins_Weight_TroyOz_Backup;',
        N'@Out INT OUTPUT',
        @Out = @BackupRows OUTPUT;

PRINT '';
PRINT '--- Coins.Weight after migration 008 ---';
PRINT 'Unit ................................. GRAMS (was troy ounces)';
PRINT 'Coins in the table ................... ' + CAST(@Total AS NVARCHAR(20));
PRINT 'With a gross weight recorded ......... ' + CAST(@WithWeight AS NVARCHAR(20));
PRINT 'Left blank (not derivable) ........... ' + CAST(@StillBlank AS NVARCHAR(20));
PRINT '';
PRINT 'Lightest coin (g) .................... ' + ISNULL(CAST(@MinW AS NVARCHAR(30)), '(no weights)');
PRINT 'Heaviest coin (g) .................... ' + ISNULL(CAST(@MaxW AS NVARCHAR(30)), '(no weights)');
PRINT 'Average (g) .......................... ' + ISNULL(CAST(@AvgW AS NVARCHAR(30)), '(no weights)');
PRINT '';

IF @AvgW IS NOT NULL AND @AvgW < 2
BEGIN
    PRINT '*** The average is under 2 g. A collection of coins cannot average';
    PRINT '*** less than 2 grams -- a Lincoln cent alone is 2.5 g. This column';
    PRINT '*** almost certainly still holds TROY OUNCES. Check whether the';
    PRINT '*** marker row was written without the conversion running.';
    PRINT '';
END

IF @MaxW IS NOT NULL AND @MaxW > 2000
BEGIN
    PRINT '*** The heaviest entry is over 2000 g (4.4 lb). That is possible for';
    PRINT '*** a large bullion bar but not for a coin. Check that row, and check';
    PRINT '*** that nothing has been multiplied by 31.1034768 twice.';
    PRINT '';
END

IF @Derivable > 0
BEGIN
    PRINT '*** ' + CAST(@Derivable AS NVARCHAR(20)) + ' blank weight(s) COULD be derived but were not.';
    PRINT '*** Step 4 was skipped, or PM data arrived after it ran. Re-running';
    PRINT '*** this file is safe and will fill them: the conversion skips itself';
    PRINT '*** on the marker, and only step 4 does any work.';
    PRINT '';
END

IF @MarkerValue IS NULL
BEGIN
    PRINT 'Marker ............................... NOT PRESENT.';
    PRINT '  The conversion has NOT been applied. Coins.Weight is still troy';
    PRINT '  ounces, and the application now labels it grams -- so the UI is';
    PRINT '  currently understating every weight by a factor of 31. Find out why';
    PRINT '  the script did not complete and run it again.';
END
ELSE
BEGIN
    PRINT 'Marker ............................... PRESENT.';
    PRINT '  ' + @MarkerValue;
END

IF @BackupRows IS NULL
BEGIN
    PRINT 'Backup ............................... Coins_Weight_TroyOz_Backup NOT FOUND.';
    PRINT '  If the conversion ran, the original troy-ounce values are gone.';
END
ELSE
BEGIN
    PRINT 'Backup ............................... Coins_Weight_TroyOz_Backup, '
        + CAST(@BackupRows AS NVARCHAR(20)) + ' row(s).';
    PRINT '  Holds the pre-conversion troy-ounce values, NULLs included. Keep it';
    PRINT '  until you are satisfied; see the header for the restore statements.';
END

PRINT '';
PRINT 'Migration 008 complete. Restart the API server so it is not holding a';
PRINT 'cached query plan, and remember that the coin editor, the inventory grid';
PRINT 'and the CSV export now all label this field in grams.';
PRINT '';
GO
