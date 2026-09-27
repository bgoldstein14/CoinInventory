-- ============================================================
-- 003-multiple-images-per-coin.sql
-- Makes the CoinImages table fully ready for many photos per coin
-- ============================================================
--
-- READ THIS FIRST: WHAT WAS AND WAS NOT ALREADY THERE
-- ---------------------------------------------------
-- "Multiple pictures per coin" is not a new capability being bolted on here.
-- CoinImages has been a CHILD table since the baseline schema: one ROW per
-- photo, keyed by its own ImageId identity, pointing back at a coin via CoinId,
-- with SortOrder deciding display order. Storing ten photos for one coin has
-- always been ten rows. There is no single-image column to widen and no
-- one-image-per-coin constraint to remove.
--
-- What the batch image import actually needs on top of that is smaller, but it
-- is real, and it is what this file does:
--
--   1. SourcePath must exist  - each photo records where its ORIGINAL file
--      lives, so ten photos on one coin are ten distinguishable files rather
--      than ten anonymous blobs. (This is migration 002's column. It is
--      repeated here, see "RELATIONSHIP TO 002" below.)
--
--   2. SortOrder must be trustworthy  - with one or two images per coin,
--      duplicate SortOrder values were invisible. With eight or ten per coin
--      they are not: 'ORDER BY SortOrder' over several rows that all say 0
--      returns them in whatever order the engine finds cheapest, so the gallery
--      can shuffle Obverse and Reverse between page loads. This file renumbers
--      each coin's photos 0, 1, 2, ... so the order is deterministic.
--
--   3. The per-coin lookup must stay cheap  - the app's hot image query is
--      'WHERE CoinId = @id ORDER BY SortOrder'. The existing index covers only
--      CoinId, so the server has to sort the matching rows every time. Widening
--      the index to (CoinId, SortOrder) lets it read them already in order.
--      Barely measurable at two rows per coin; worth having at ten across a
--      few thousand coins.
--
-- RELATIONSHIP TO 002
-- -------------------
-- Migration 002 added CoinImages.SourcePath. If you have already run it, the
-- guard below sees the column and skips that step - running both in order is
-- safe and is the normal path. If you have NOT run it, this file adds the
-- column itself, so 003 alone is sufficient and you can ignore 002 entirely.
-- That redundancy is deliberate: the two changes ship together, and a database
-- that got the index but not the column would be a confusing half state.
--
-- HOW TO RUN IT
-- -------------
-- From a terminal on the machine hosting SQL Server:
--
--   sqlcmd -S "BRUCE_PC\SQLEXPRESS" -d CoinInventory -E -i server\migrations\003-multiple-images-per-coin.sql
--
-- ...or open it in SQL Server Management Studio / Azure Data Studio with the
-- CoinInventory database selected and press Execute.
--
-- Every step is guarded, so running it twice is harmless - the second run
-- prints "nothing to do" for each step and changes nothing. No column is
-- dropped and no image data is deleted; the only write to existing rows is the
-- SortOrder renumbering in step 2, which reorders nothing that was already
-- unambiguous. It is safe to run on a live database with the app connected,
-- though the app should be restarted afterwards so it is not holding a cached
-- query plan built against the old index.
--
-- The script prints a summary at the end so you can see the result without
-- writing your own query.
-- ============================================================

USE CoinInventory;
GO

-- ============================================================
-- STEP 0 - Make sure CoinImages exists at all
-- ============================================================
-- This should never fire on your database: the table has been part of the
-- schema from the start, and the app could not have stored a single photo
-- without it. It exists so that this file is self-sufficient on a database
-- built from an older or partial script, rather than failing halfway with
-- "Invalid object name 'CoinImages'".
--
-- The shape here is identical to setup-database.sql's, including the
-- ON DELETE CASCADE, which is what makes deleting a coin also delete its
-- photos instead of leaving orphaned rows behind.
IF OBJECT_ID('CoinImages', 'U') IS NULL
BEGIN
    CREATE TABLE CoinImages (
        ImageId             INT                 IDENTITY(1,1) PRIMARY KEY,
        CoinId              UNIQUEIDENTIFIER    NOT NULL,       -- Which coin this image belongs to
        ImageData           NVARCHAR(MAX)       NULL,           -- Base64 data URL (downscaled copy)
        SortOrder           INT                 NOT NULL DEFAULT 0,  -- Display order within the coin
        SourcePath          NVARCHAR(400)       NULL,           -- Absolute path of the original file
        CONSTRAINT FK_CoinImages_Coin
            FOREIGN KEY (CoinId) REFERENCES Coins(CoinId) ON DELETE CASCADE
    );

    PRINT 'Migration 003 step 0: created the CoinImages table (it was missing).';
END
ELSE
BEGIN
    PRINT 'Migration 003 step 0: CoinImages table already exists - nothing to do.';
END
GO

-- ============================================================
-- STEP 1 - CoinImages.SourcePath
-- ============================================================
-- Records where each photo's ORIGINAL full-resolution file sits on the machine
-- hosting the app. ImageData is only a downscaled copy for display, so this is
-- what lets the UI show the user which file a photo came from and offer a link
-- that opens the full-scale image (served by GET /api/images/file?path=...).
--
-- The column is NULLABLE on purpose. Every photo already in the table was
-- imported before the column existed, so its original path is genuinely
-- unknown - and "unknown" is not the same as "empty string". Those rows keep
-- working exactly as they did; the UI simply shows no link for them.
--
-- COL_LENGTH returns NULL for a column that does not exist, which makes it the
-- cheapest "have I already run this?" test available. The guard is what makes
-- the step safe to repeat, since ALTER TABLE ... ADD is not itself idempotent -
-- a second run would fail with "column names in each table must be unique".
--
-- These are paths on the HOST machine - the one running the API server, which
-- is what actually opens the file - and on the host the photo library sits on a
-- local drive, so they look like D:\Coin Pictures\1921-morgan-obverse.jpg. A
-- path that is only valid on some other machine is worse than no path at all:
-- it stores cleanly and then reports every image as missing.
--
-- NVARCHAR(400) is sized generously for that, with room to spare for deep
-- subfolders, and it still covers the longer UNC form (\\server\share\...) that
-- a developer workstation may use to reach the same files. It is also small
-- enough to sit in an index key if a later migration ever needs one, which
-- NVARCHAR(MAX) would not be.
IF COL_LENGTH('CoinImages', 'SourcePath') IS NULL
BEGIN
    ALTER TABLE CoinImages
        ADD SourcePath NVARCHAR(400) NULL;

    PRINT 'Migration 003 step 1: added CoinImages.SourcePath (NVARCHAR(400) NULL).';
END
ELSE
BEGIN
    PRINT 'Migration 003 step 1: CoinImages.SourcePath already exists - nothing to do.';
END
GO
-- The GO above matters: SQL Server compiles a whole batch before running any of
-- it, so a later statement in THIS batch that named SourcePath would fail to
-- compile on a database where the column was just added. Ending the batch here
-- means everything below is compiled against the post-ALTER table.

-- ============================================================
-- STEP 2 - Renumber SortOrder so each coin's photos have a definite order
-- ============================================================
-- The problem this fixes: nothing has ever stopped two photos of the same coin
-- from sharing a SortOrder. The value defaults to 0, and older insert paths did
-- not always assign one, so a coin can easily hold several rows all claiming
-- position 0. 'ORDER BY SortOrder' then leaves their relative order up to the
-- query plan, and the gallery is free to show Reverse first today and Obverse
-- first tomorrow.
--
-- The fix: within each coin, hand out 0, 1, 2, ... in the order the rows sort
-- TODAY. ROW_NUMBER() with PARTITION BY CoinId restarts the count for every
-- coin, which is exactly the "position within this coin" we want.
--
-- ORDER BY SortOrder, ImageId is the important detail. Sorting by SortOrder
-- first preserves every ordering choice that was already unambiguous - photos
-- deliberately placed at 0, 1, 2 keep those positions and are not written at
-- all. ImageId only breaks ties among rows that already collided, and because
-- it is an ascending identity, it resolves them to insertion order: the photo
-- added first stays first. That is both the least surprising outcome and a
-- stable one, so a second run of this script produces the same numbering.
--
-- The '- 1' makes the sequence zero-based, matching what the application
-- assigns for new images (see routes/coins/images.ts, which starts from
-- MAX(SortOrder) + 1).
--
-- WHERE SortOrder <> NewOrder is what makes this idempotent and cheap: on a
-- database that is already correctly numbered, zero rows are updated. Running
-- the script repeatedly never churns the table. (No NULL check is needed -
-- SortOrder is NOT NULL.)
WITH NumberedImages AS (
    SELECT
        SortOrder,
        ROW_NUMBER() OVER (PARTITION BY CoinId ORDER BY SortOrder, ImageId) - 1 AS NewOrder
    FROM CoinImages
)
UPDATE NumberedImages
    SET SortOrder = NewOrder
    WHERE SortOrder <> NewOrder;

-- @@ROWCOUNT is the number of photos that were actually sitting in an ambiguous
-- position, which is a genuinely useful thing to see: 0 means ordering was
-- already sound, and a large number explains any gallery shuffling you noticed.
PRINT 'Migration 003 step 2: renumbered SortOrder for ' + CAST(@@ROWCOUNT AS NVARCHAR(20))
    + ' image row(s) (0 means ordering was already unambiguous).';
GO

-- ============================================================
-- STEP 3 - Widen the per-coin index to cover the sort
-- ============================================================
-- The app's hot image query is:
--
--   SELECT ImageId, ImageData, SortOrder, SourcePath
--   FROM CoinImages WHERE CoinId = @id ORDER BY SortOrder
--
-- IX_CoinImages_CoinId gets the engine to the right rows but says nothing about
-- their order, so the plan has to sort them after fetching. Making the index
-- (CoinId, SortOrder) means the rows come off the index already in display
-- order and the sort disappears from the plan entirely.
--
-- The new index is created BEFORE the old one is dropped so there is no moment
-- where CoinId lookups have no index to use. Dropping the old one afterwards is
-- safe because (CoinId, SortOrder) has CoinId as its leading column: anything
-- IX_CoinImages_CoinId could answer, the wider index answers too. Keeping both
-- would only add write cost on every photo inserted or deleted.
--
-- Both statements are guarded by a sys.indexes lookup rather than a bare
-- CREATE/DROP, so the step is safe to repeat. Note the object_id filter - index
-- names are only unique per table, so checking the name alone could match an
-- index on some other table.
--
-- Deliberately NOT added here: a unique index on (CoinId, SourcePath) to stop
-- the same file being attached to one coin twice. It is tempting, and the
-- import does already de-duplicate on the client, but a UNIQUE constraint turns
-- any duplicate that slips through into a hard SQL error - and because the
-- image insert runs as one transaction, a single duplicate would abort the
-- whole batch rather than being skipped. Silently re-attaching one photo is a
-- much smaller problem than a 200-photo import failing at file 150. If
-- server-side de-duplication is wanted later it belongs in the insert logic,
-- where a duplicate can be dropped without killing the batch.
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_CoinImages_CoinId_SortOrder'
      AND object_id = OBJECT_ID('CoinImages')
)
BEGIN
    CREATE INDEX IX_CoinImages_CoinId_SortOrder
        ON CoinImages (CoinId, SortOrder);

    PRINT 'Migration 003 step 3a: created IX_CoinImages_CoinId_SortOrder.';
END
ELSE
BEGIN
    PRINT 'Migration 003 step 3a: IX_CoinImages_CoinId_SortOrder already exists - nothing to do.';
END
GO

IF EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_CoinImages_CoinId'
      AND object_id = OBJECT_ID('CoinImages')
)
BEGIN
    DROP INDEX IX_CoinImages_CoinId ON CoinImages;

    PRINT 'Migration 003 step 3b: dropped the now-redundant IX_CoinImages_CoinId.';
END
ELSE
BEGIN
    PRINT 'Migration 003 step 3b: IX_CoinImages_CoinId already absent - nothing to do.';
END
GO

-- ============================================================
-- SUMMARY - what the table looks like now
-- ============================================================
-- Printed so you can confirm the migration did what you expected without
-- writing a query. Read it as: how many photos are stored, how many coins have
-- photos at all, the largest number of photos on any single coin (this is the
-- "multiple pictures per coin" claim, demonstrated rather than asserted), and
-- how many photos still have no recorded source path.
--
-- That last number will be high immediately after running this - every photo
-- imported before SourcePath existed has NULL, and always will. It only goes
-- down as photos are re-imported through the batch importer, which records the
-- path as it attaches each file.
DECLARE @TotalImages      INT = (SELECT COUNT(*) FROM CoinImages);
DECLARE @CoinsWithImages  INT = (SELECT COUNT(DISTINCT CoinId) FROM CoinImages);
DECLARE @MaxPerCoin       INT = ISNULL((
    SELECT MAX(PerCoin) FROM (
        SELECT COUNT(*) AS PerCoin FROM CoinImages GROUP BY CoinId
    ) AS Counts
), 0);
DECLARE @MissingPaths     INT = (SELECT COUNT(*) FROM CoinImages WHERE SourcePath IS NULL);

PRINT '';
PRINT '--- CoinImages after migration 003 ---';
PRINT 'Total image rows ................ ' + CAST(@TotalImages     AS NVARCHAR(20));
PRINT 'Coins that have photos .......... ' + CAST(@CoinsWithImages AS NVARCHAR(20));
PRINT 'Most photos on a single coin .... ' + CAST(@MaxPerCoin      AS NVARCHAR(20));
PRINT 'Photos with no source path ...... ' + CAST(@MissingPaths    AS NVARCHAR(20))
    + '  (expected for anything imported before migration 002/003)';
PRINT '';
PRINT 'Migration 003 complete. Restart the API server so it picks up the new index.';
GO
