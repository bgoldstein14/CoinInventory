-- ============================================================
-- 012-add-catalog-references.sql
-- Adds the Catalogs lookup table and Coins.CatalogId / Coins.CatalogNumber
-- ============================================================
--
-- WHY
-- ---
-- Ancients and world coins are identified by CATALOGUE REFERENCE far more
-- than by denomination. An unattributed Judaean bronze has no year, no
-- denomination and no grade -- three of the four things this application
-- knows a coin by -- but it does have "Hendin 1234". The same is true of
-- "Sear 6819", "RIC II.1 234" and "KM# 110".
--
-- *** THIS IS NOT A NEW FEATURE SO MUCH AS A HOME FOR EXISTING DATA. ***
-- The owner is already recording these references; he just has nowhere to put
-- them. src/app/services/image-matching/coin-signature.ts documents a LIVE
-- record whose `Variety` field reads "Sear 6819", and the image matcher
-- already carries fourteen catalogue prefixes in filename-vocabulary.ts
-- because those names turn up in the photo filenames. After this migration
-- the reference has its own two fields, and the Variety column can go back to
-- meaning what it says (VAM, DDO, Type 1).
--
-- *** NO EXISTING COIN IS CHANGED. ***
-- ------------------------------------
-- This script only ever CREATES: one table, fifteen seed rows, two nullable
-- columns and one foreign key. There is no UPDATE of Coins anywhere in it, so
-- no value that was in the database before it ran can be rewritten, trimmed
-- or nulled -- including the Variety text that currently holds some of these
-- references. Moving a reference out of Variety is the USER's decision, made
-- one coin at a time in the editor, because only he can tell "Sear 6819"
-- (a catalogue reference) from "Type 1 Reverse" (a real variety). An
-- automatic sweep that guessed would be editing his records on a hunch.
--
-- That also makes this migration trivially reversible by hand: drop the
-- constraint, drop the two columns, drop the table.
--
-- WHAT IS SEEDED, AND WHY THOSE FIFTEEN
-- -------------------------------------
-- The first fourteen are CATALOG_PREFIXES from
-- src/app/services/image-matching/filename-vocabulary.ts, expanded from the
-- matcher's lower-case tokens into display names. That list was built by
-- reading THIS COLLECTION's photo filenames, so it is not a guess about what
-- collectors use in general -- it is the set of catalogues this collection
-- actually uses, which is why the dropdown's top entry is usually right.
--
-- The fifteenth, Krause (KM), is the one addition: world-coin numbering,
-- which no filename mentions but which anyone cataloguing modern foreign
-- coins needs.
--
-- The names are duplicated here from TypeScript because SQL cannot import a
-- module. src/app/types/catalog-seed-parity.spec.ts reads BOTH files off disk
-- and fails the build if they ever disagree -- the same technique
-- sql-pm-reference-parity.spec.ts uses for migration 007's alloy table.
--
-- It is a SEED, not a closed set. The user adds, renames and removes
-- catalogues from Settings > Categories & Sets, exactly as he does
-- denominations and mint marks.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO: no auto-fill
-- ----------------------------------------------------------
-- Entering a catalogue and a number does NOT look anything up -- it does not
-- fill in the year, the type, the denomination or the composition. That was
-- investigated (2026-11-08) and deferred on AVAILABILITY grounds, not
-- licensing ones: of the catalogues above, only RIC and Crawford have an open
-- machine-readable source (OCRE and CRRO, via Nomisma, ODC-ODbL), and
-- numismatics.org answers HTTP 403 to automated requests. Sear, Hendin and
-- Krause -- the three the owner reaches for first -- have no queryable source
-- at all. A resolver that silently fills nothing for most of the collection
-- is worse than no resolver, so there is none, and no stub. §4.5 of
-- docs/superpowers/specs/2026-11-08-denomination-reference-model-design.md
-- sketches the shape if it is ever built.
--
-- ONE REFERENCE PER COIN, AND THAT IS A KNOWN LIMITATION
-- ------------------------------------------------------
-- Ancients frequently carry several at once ("RIC 123" AND "Cohen 45" AND
-- "Sear 6819"), so a child table is the eventually-correct model. It is
-- deliberately not this change: it multiplies the UI and the matcher work,
-- and one reference is already a large improvement over a free-text Variety.
-- The path from here is a Coins -> CoinCatalogRefs child table carrying the
-- same two columns; nothing in this migration blocks it.
--
-- WHY NVARCHAR(50) FOR THE NUMBER
-- --------------------------------
-- Generous for "1A", "6819", "II.1 234" and "RRC 44/5" without being a text
-- area. It is NOT free-text notes: the number is a key into a book, and a
-- field big enough for a sentence invites one. The length is mirrored by
-- CATALOG_NUMBER_MAX_LENGTH in src/app/types/catalog-reference.ts (which caps
-- the editor input) and by the NVarChar(50) binding in
-- server/db/coin-fields.ts. All three are asserted against this file and
-- against setup-database.sql by the specs beside them.
--
-- WHY BOTH COLUMNS ARE NULLABLE WITH NO DEFAULT
-- ----------------------------------------------
-- Almost no coin has a catalogue reference, and almost no coin ever will --
-- it matters for ancients and world coins, not for a Morgan dollar. NULL is
-- the correct, honest and overwhelmingly common state. A DEFAULT would
-- attribute every coin the owner has to a catalogue he never chose, which is
-- exactly the kind of confidently-wrong seeded data the design names as a
-- failure even when everything else works.
--
-- HOW TO RUN IT
-- -------------
--   sqlcmd -S localhost -d CoinInventory -E -i .\migrations\012-add-catalog-references.sql
--
-- Safe to run twice: every step is guarded on the thing it creates not
-- already being there, so a second run reports "nothing to do" and changes
-- nothing. It is also safe on a database freshly built from
-- setup-database.sql, where all of it already exists.
--
-- NOTE ON THE SEED GUARD. It is per NAME, not "insert everything if the table
-- is empty". A user who deleted `Kraay` must not find it resurrected by a
-- re-run, and a user who added `Peus` must not end up with fifteen
-- duplicates. One row, one guard.
--
-- WHY THE STEPS ARE SEPARATED BY `GO`
-- -----------------------------------
-- SQL Server compiles a whole batch before running any of it, so a batch that
-- both ADDs a column and then names that column fails to compile -- "Invalid
-- column name 'CatalogId'" -- even though the ADD would have run first. The
-- ALTER and the FOREIGN KEY that references it therefore MUST be in different
-- batches. The same applies to CREATE TABLE Catalogs and the INSERT that
-- seeds it. Do not merge them.
-- ============================================================

USE CoinInventory;
GO

-- ============================================================
-- 1. The Catalogs lookup table
-- ============================================================
-- Shaped like Denominations and MintMarks, on purpose: same IDENTITY key,
-- same SortOrder, same IsActive soft-delete flag, so it is maintained by the
-- same kind of screen through the same kind of routes.
IF OBJECT_ID('dbo.Catalogs', 'U') IS NULL
BEGIN
    CREATE TABLE Catalogs (
        CatalogId           INT                 IDENTITY(1,1) PRIMARY KEY,
        -- 60 characters: comfortable for "Krause (KM)" and for a user who
        -- expands an abbreviation to "RIC (Roman Imperial Coinage)".
        Name                NVARCHAR(60)        NOT NULL,
        -- Display order in the picker. Seeded 1..15 in the order the
        -- collection actually uses them, so `Sear` leads rather than `BMC`
        -- (which is what alphabetical order would give).
        SortOrder           INT                 NOT NULL
            CONSTRAINT DF_Catalogs_SortOrder DEFAULT 0,
        -- SOFT DELETE, matching every other lookup in this database. Coins
        -- keep pointing at a removed catalogue and keep reading "Sear 6819";
        -- only the picker hides it. A mistaken removal is undone by setting
        -- this back to 1, with nothing lost in between.
        IsActive            BIT                 NOT NULL
            CONSTRAINT DF_Catalogs_IsActive DEFAULT 1
    );

    PRINT 'Migration 012: created the Catalogs table.';
END
ELSE
BEGIN
    PRINT 'Migration 012: Catalogs table already exists - nothing to do.';
END
GO

-- ============================================================
-- 2. Seed the catalogues
-- ============================================================
-- Guarded per NAME (see the header). IDENTITY_INSERT is deliberately NOT
-- used: nothing anywhere depends on a catalogue having a particular id, and
-- forcing ids would break on a database where the user has already added one
-- of his own.
INSERT INTO Catalogs (Name, SortOrder, IsActive)
SELECT Seed.Name, Seed.SortOrder, 1
FROM (VALUES
    ('Sear',         1),   -- David Sear: Greek / Roman / Byzantine
    ('RIC',          2),   -- Roman Imperial Coinage
    ('Hendin',       3),   -- Guide to Biblical Coins (Judaea)
    ('RPC',          4),   -- Roman Provincial Coinage
    ('Svoronos',     5),   -- Ptolemaic
    ('BMC',          6),   -- British Museum Catalogue
    ('SNG',          7),   -- Sylloge Nummorum Graecorum
    ('Crawford',     8),   -- Roman Republican Coinage (RRC)
    ('Sydenham',     9),   -- The Coinage of the Roman Republic
    ('Cohen',       10),   -- Description historique des monnaies romaines
    ('RSC',         11),   -- Roman Silver Coinage
    ('Meshorer',    12),   -- Ancient Jewish Coinage
    ('TJC',         13),   -- A Treasury of Jewish Coins
    ('Kraay',       14),   -- Archaic and Classical Greek Coins
    ('Krause (KM)', 15)    -- Standard Catalog of World Coins (the one NOT from the matcher)
) AS Seed(Name, SortOrder)
WHERE NOT EXISTS (
    SELECT 1 FROM Catalogs WHERE Catalogs.Name = Seed.Name
);

PRINT 'Migration 012: seeded ' + CAST(@@ROWCOUNT AS NVARCHAR(20)) + ' catalogue(s) (0 means they were all already there).';
GO

-- ============================================================
-- 3. Coins.CatalogId
-- ============================================================
-- Nullable, no default. See the header: NULL is the correct state for
-- essentially every coin, and a default would attribute the whole collection
-- to a catalogue the owner never chose.
--
-- The FOREIGN KEY is NOT declared here. It names this column, and a batch
-- that both adds a column and references it fails to compile in its entirety.
-- It is step 5, below, after a GO.
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.Coins') AND name = 'CatalogId'
)
BEGIN
    ALTER TABLE Coins
        ADD CatalogId INT NULL;

    PRINT 'Migration 012: added Coins.CatalogId INT NULL.';
END
ELSE
BEGIN
    PRINT 'Migration 012: Coins.CatalogId already exists - nothing to do.';
END
GO

-- ============================================================
-- 4. Coins.CatalogNumber
-- ============================================================
-- The reference within the catalogue, stored EXACTLY as the user typed it:
-- "1A", "6819", "II.1 234", "RRC 44/5". Nothing in the application
-- upper-cases it, strips its punctuation or collapses its spaces -- a
-- reference the app tidied is a reference that no longer matches the book.
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.Coins') AND name = 'CatalogNumber'
)
BEGIN
    ALTER TABLE Coins
        ADD CatalogNumber NVARCHAR(50) NULL;

    PRINT 'Migration 012: added Coins.CatalogNumber NVARCHAR(50) NULL.';
END
ELSE
BEGIN
    PRINT 'Migration 012: Coins.CatalogNumber already exists - nothing to do.';
END
GO

-- ============================================================
-- 5. The foreign key
-- ============================================================
-- A SEPARATE BATCH because it names CatalogId, which step 3 created. SQL
-- Server compiles a batch before running any of it, so putting these
-- together fails with "Invalid column name 'CatalogId'" and leaves the
-- migration half-applied.
--
-- NO ON DELETE CASCADE, and that is the important word in this step.
-- Deleting a catalogue must never delete the owner's coins. Removal in the
-- UI is a soft delete (IsActive = 0) and the coins are untouched; even a
-- hand-run DELETE against this table should fail loudly on the constraint
-- rather than quietly take a hundred coins with it. ON DELETE SET NULL was
-- considered and rejected for the same reason -- it would silently discard
-- the attribution on every affected coin.
--
-- The constraint is NAMED rather than left to a generated name
-- (FK__Coins__CatalogI__1A2B3C4D), which differs on every database and would
-- have to be hunted for in sys.objects by any later migration.
IF NOT EXISTS (
    SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Coins_Catalog'
)
BEGIN
    ALTER TABLE Coins
        ADD CONSTRAINT FK_Coins_Catalog
            FOREIGN KEY (CatalogId) REFERENCES Catalogs(CatalogId);

    PRINT 'Migration 012: added FK_Coins_Catalog.';
END
ELSE
BEGIN
    PRINT 'Migration 012: FK_Coins_Catalog already exists - nothing to do.';
END
GO

-- ============================================================
-- SUMMARY
-- ============================================================
DECLARE @Catalogs    INT = (SELECT COUNT(*) FROM Catalogs WHERE IsActive = 1);
DECLARE @Total       INT = (SELECT COUNT(*) FROM Coins);
DECLARE @WithRef     INT = (SELECT COUNT(*) FROM Coins
                            WHERE CatalogId IS NOT NULL
                               OR (CatalogNumber IS NOT NULL AND LTRIM(RTRIM(CatalogNumber)) <> ''));
-- The coins whose Variety field LOOKS like a catalogue reference, i.e. the
-- ones this feature was built for. Reported, never changed -- the user moves
-- them himself, because only he can tell a reference from a real variety.
DECLARE @VarietyRefs INT = (SELECT COUNT(*) FROM Coins
                            WHERE Variety IS NOT NULL
                              AND (Variety LIKE 'Sear %'  OR Variety LIKE 'RIC %'
                                OR Variety LIKE 'Hendin %' OR Variety LIKE 'RPC %'
                                OR Variety LIKE 'Crawford %' OR Variety LIKE 'KM%'));

PRINT '';
PRINT '--- Coins after migration 012 ---';
PRINT 'Active catalogues ....................... ' + CAST(@Catalogs    AS NVARCHAR(20));
PRINT 'Total coins ............................. ' + CAST(@Total       AS NVARCHAR(20));
PRINT 'Coins with a catalogue reference ........ ' + CAST(@WithRef     AS NVARCHAR(20));
PRINT 'Coins whose Variety looks like one ...... ' + CAST(@VarietyRefs AS NVARCHAR(20));
PRINT '';
PRINT 'No coin was changed by this migration. The last figure above is a';
PRINT 'REPORT, not a conversion: those coins still hold their reference in';
PRINT 'the Variety field, and moving it into the new Catalogue Ref. fields is';
PRINT 'a decision for the owner, one coin at a time, in the editor.';
PRINT '';
PRINT 'Reload the app. The Catalogue picker and number box appear in the coin';
PRINT 'editor next to the certification number; the Catalogue Ref. grid column';
PRINT 'is OFF by default and can be switched on from the Columns panel.';
GO
