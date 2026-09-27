-- ============================================================
-- 002-add-image-source-path.sql
-- Adds CoinImages.SourcePath — the path of the ORIGINAL image file
-- ============================================================
--
-- WHY THIS FILE EXISTS
-- --------------------
-- server/setup-database.sql is the "build it from scratch" script. It starts by
-- DROPPING every table, so it can only ever be used on an empty/disposable
-- database. Running it against a populated inventory would destroy the user's
-- coins. This folder holds the other kind of script: small, idempotent changes
-- that can be applied to a live database with data already in it.
--
-- This is the first migration file. The numbering starts at 002 because
-- setup-database.sql is effectively migration 001 — the baseline schema that
-- every later file in this folder is a delta against. Future changes should
-- continue the sequence (003-..., 004-...) and follow the same two rules:
--
--   1. Guard every statement so re-running the file is harmless. There is no
--      migration-tracking table in this project, so "safe to run twice" is what
--      takes its place.
--   2. Never drop or rewrite a column that holds user data.
--
-- HOW TO RUN IT
-- -------------
-- From a terminal on the machine hosting SQL Server (pick whichever client is
-- installed — both are equivalent here):
--
--   sqlcmd -S "BRUCE_PC\SQLEXPRESS" -d CoinInventory -E -i server\migrations\002-add-image-source-path.sql
--   -- or, with the newer cross-platform client:
--   sqlcmd -S "BRUCE_PC\SQLEXPRESS" -d CoinInventory -E -i server/migrations/002-add-image-source-path.sql -C
--
-- ...or just open it in SQL Server Management Studio / Azure Data Studio with
-- the CoinInventory database selected and press Execute. It prints a line
-- saying what it did, and running it a second time is a no-op.
--
-- WHAT IT ADDS
-- ------------
-- CoinImages.ImageData holds a downscaled base64 copy of each photo, which is
-- what the app displays. SourcePath records where the original full-resolution
-- file (up to ~46 MB) actually sits on disk, so the app can:
--
--   * show the user where the file came from, and
--   * offer a clickable link that opens the full-scale image, served by
--     GET /api/images/file?path=<absolute path>
--
-- The column is NULLABLE and that is deliberate — every image already in the
-- table was imported before this column existed, so its original path is
-- unknown. Those rows keep working; the UI simply shows no link for them.
-- ============================================================

USE CoinInventory;
GO

-- COL_LENGTH returns NULL when the column does not exist, which makes it the
-- cheapest "have I already run?" check available. ALTER TABLE ... ADD is not
-- itself idempotent (a second run fails with "column names must be unique"),
-- so the guard is what makes this file safe to execute repeatedly.
IF COL_LENGTH('CoinImages', 'SourcePath') IS NULL
BEGIN
    ALTER TABLE CoinImages
        ADD SourcePath NVARCHAR(400) NULL;

    PRINT 'Migration 002: added CoinImages.SourcePath (NVARCHAR(400) NULL).';
END
ELSE
BEGIN
    PRINT 'Migration 002: CoinImages.SourcePath already exists - nothing to do.';
END
GO
