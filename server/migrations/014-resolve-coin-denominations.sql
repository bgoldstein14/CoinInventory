-- ============================================================
-- 014-resolve-coin-denominations.sql
-- Fills in Coins.DenominationId, and reports what it could not
-- ============================================================
--
-- WHY
-- ---
-- Migration 011 gave coins a DenominationId and 013 gave the database
-- something to point at. This is the step that links them, and it is the
-- riskiest deliverable of the whole change: 105 live coins, imported over
-- years, by three different code paths that each spelled the denomination
-- their own way.
--
-- *** THE ONE RULE THIS FILE IS BUILT AROUND ***
-- ----------------------------------------------
--     Coins.Denomination IS NEVER WRITTEN. READ-ONLY THROUGHOUT.
--
-- Not tidied, not canonicalised, not blanked. The only column this script
-- assigns on Coins is DenominationId, and only where it is currently NULL.
-- That single rule is what makes every step of this change recoverable: if
-- the resolution below turns out to be wrong in any way, setting
-- DenominationId back to NULL restores the previous state exactly, and
-- nothing anybody ever typed has been lost. A migration that "normalised"
-- the text would destroy the only evidence of what the source said, for
-- good. It is asserted by
-- src/app/services/denominations/sql-denomination-resolution-parity.spec.ts.
--
-- HOW A COIN IS RESOLVED
-- ----------------------
-- Both sides -- the coin's text and every active denomination's Label --
-- are reduced to the same KEY, and matched on that. The key folding is
-- transcribed from src/app/components/coin-editor-form/denomination-aliases.ts
-- and is checked against it, entry for entry, by the parity spec named
-- above. That file already knows that '3CS', 'Three Cent Silver' and
-- 'Trime' are one coin, and that the QIF importer writes '5s' where the
-- lookup says '5/- (Crown)'. Writing a second alias table here would be a
-- second vocabulary to keep in step; this is a transcription with a test
-- holding it to the original.
--
-- Then, in this order and the order matters:
--
--   1. THE COIN'S COUNTRY GETS FIRST REFUSAL. If exactly one matching
--      denomination belongs to an issuer the coin's country names, that is
--      the answer -- even when the same text is ambiguous across the
--      database as a whole. 'Penny' is a label under Australia, New Zealand
--      and Ireland; scoped to one of them it is unambiguous and resolves.
--
--   2. OTHERWISE THE SEARCH WIDENS TO EVERY ISSUER. This is not a nicety,
--      it is the case that prompted the entire design: the QIF parser never
--      set a country, so the owner's MEXICAN 8-Reales coins are all stored
--      as 'United States'. A country-scoped-only match would resolve
--      nothing for precisely the coins this work exists to fix.
--
--   3. ANYTHING STILL AMBIGUOUS IS LEFT NULL. Great Britain, Australia and
--      South Africa all struck a Sovereign. A coin reading 'Sovereign'
--      whose country picks none of them has no right answer, and inventing
--      one files it under a country the owner never chose -- invisibly, and
--      for good. 'Other (Sovereign)' is honest; the wrong issuer is not.
--
-- WHY THE COUNTRY TEST IS NARROWER THAN THE APPLICATION'S
-- -------------------------------------------------------
-- The app compares countries through services/coin-countries.ts, which
-- knows that 'GB' and 'Great Britain' are the same place and carries
-- seventy-odd spelling patterns. T-SQL cannot call that, so this script
-- compares the coin's country against the issuer's Name and IsoCode and
-- nothing else -- which covers every spelling the live data actually holds,
-- because the QIF importer writes canonical names and the lookup table
-- writes ISO codes.
--
-- The application's resolver is written so that an EXACT match, where there
-- is one, is the whole answer -- which makes this narrower rule a SPECIAL
-- CASE of it rather than a rival. The consequence, asserted by a sweep over
-- the real seed in the parity spec, is:
--
--     THIS MIGRATION NEVER SETS AN ID THE APPLICATION WOULD NOT HAVE SET.
--     It may set fewer.
--
-- Fewer is the recoverable direction: the coin reads 'Other (8 Reales)',
-- the value appears in the report below, and a human decides.
--
-- THE REPORT IS THE POINT
-- -----------------------
-- Every distinct value this script could not resolve is PRINTed with a coin
-- count and a reason, and repeated as a result set for anyone running this
-- in SSMS. That list is the review artefact. "It resolved 83 of 105" is a
-- number nobody can act on; "9 coins say Sovereign and three issuers struck
-- one" is a decision somebody can make.
--
-- STOP AND READ IT before anything else is built on top of this migration.
--
-- PURE ASCII, ON PURPOSE
-- ----------------------
-- The folding has to recognise the cent sign (U+00A2), the vulgar one-half
-- (U+00BD) and the pound sign (U+00A3). Written literally, whether it did
-- would depend on sqlcmd reading this file in the right code page, which is
-- a miserable thing to debug. NCHAR() names them by code point instead and
-- the file stays pure ASCII -- migration 007 makes the same argument and the
-- parity spec enforces it.
--
-- HOW TO RUN IT
-- -------------
--   sqlcmd -S localhost -d CoinInventory -E -i .\migrations\014-resolve-coin-denominations.sql
--
-- Run 011-add-issuers-and-denomination-links.sql and then
-- 013-seed-issuers-and-denominations.sql first; this script stops with a
-- clear message if 011 has not been run. Safe to run twice: it only ever
-- fills an id that is currently NULL, so a second run neither overwrites a
-- link the user made in the editor nor thrashes one this script made.
--
-- TO UNDO IT COMPLETELY
-- ---------------------
--   UPDATE Coins SET DenominationId = NULL;
-- Nothing else changed.
-- ============================================================

USE CoinInventory;
GO

-- ============================================================
-- 0. Refuse to run before the schema exists
-- ============================================================
IF OBJECT_ID('dbo.Issuers', 'U') IS NULL
    OR NOT EXISTS (
        SELECT 1 FROM sys.columns
        WHERE object_id = OBJECT_ID('dbo.Coins') AND name = 'DenominationId'
    )
BEGIN
    RAISERROR('Migration 014: the schema is not ready. Run 011-add-issuers-and-denomination-links.sql, then 013-seed-issuers-and-denominations.sql, first.', 16, 1);
END
GO

-- ============================================================
-- 1. The alias table, transcribed
-- ============================================================
-- Every row below is an entry of DENOMINATION_ALIASES in
-- src/app/components/coin-editor-form/denomination-aliases.ts, and
-- sql-denomination-resolution-parity.spec.ts compares the two tables entry
-- for entry on every test run. A row added here and not there -- or there
-- and not here -- is the same coin reading two different ways depending on
-- which code path looked at it, which is the fault this whole change exists
-- to end.
--
-- The LEFT side is post-fold text; the RIGHT side is the folded form of a
-- real Label ('50c' is what '50' + cent-sign folds to, 'crown' is what
-- '5/- (Crown)' folds to). Nothing here names a Label directly, which is
-- what lets the lookup table be renamed or trimmed without this table
-- lying.
--
-- WHAT IS DELIBERATELY ABSENT, because the obvious mistake is to copy
-- migration 007's CASE wholesale:
--
--   'trade dollar' IS in 007, correctly: 007 is working out an ALLOY and a
--   Trade Dollar is 90% silver like every other dollar. This script is
--   working out a DENOMINATION, and the Trade Dollar is a distinct issue --
--   420 grains, struck for the Orient, not the 412.5-grain dollar the
--   lookup's '$1' row stands for.
--
--   'penny' means the US cent to an American and 1d to everyone else, and
--   those are not the same coin. The ISSUER model is what finally answers
--   it: 'Penny' is a real Label under Australia, New Zealand and Ireland,
--   and rule 1 above resolves it correctly whenever the coin's country says
--   which. A global alias would be wrong for somebody every time.
--
--   'eagle' on its own is three different coins -- a Gold Eagle, a Silver
--   Eagle and the classic $10 Eagle.
IF OBJECT_ID('tempdb..#Alias') IS NOT NULL DROP TABLE #Alias;

CREATE TABLE #Alias (
    Folded      NVARCHAR(200)   NOT NULL PRIMARY KEY,
    DenomKey    NVARCHAR(200)   NOT NULL
);

-- NOTE: 'nickel' and 'half dime' are deliberately NOT in this list.
-- They folded onto '5c' while that was the only five-cent row the database
-- seeded. Both are now seeded as their own United States denominations, and
-- three labels folding to one key would make every five-cent coin AMBIGUOUS,
-- which resolves to no link at all. The matching entries were removed from
-- src/app/components/coin-editor-form/denomination-aliases.ts in the same
-- change, and sql-denomination-resolution-parity.spec.ts fails if the two
-- lists ever drift apart.
--
-- Keep comments OUT of the VALUES list below: that spec parses these rows out
-- of this file, and an interleaved comment line makes it read a short table
-- and silently compare the wrong thing.
INSERT INTO #Alias (Folded, DenomKey) VALUES
(N'cent'             , N'1c'),
(N'one cent'         , N'1c'),
(N'large cent'       , N'1c'),
(N'half cent'        , N'halfc'),
(N'two cent'         , N'2c'),
(N'two cents'        , N'2c'),
(N'three cent silver', N'3cs'),
(N'trime'            , N'3cs'),
(N'three cent nickel', N'3cn'),
(N'five cents'       , N'5c'),
(N'dime'             , N'10c'),
(N'ten cents'        , N'10c'),
(N'twenty cent'      , N'20c'),
(N'twenty cents'     , N'20c'),
(N'quarter'          , N'25c'),
(N'quarter dollar'   , N'25c'),
(N'half dollar'      , N'50c'),
(N'fifty cents'      , N'50c'),
(N'dollar'           , N'$1'),
(N'one dollar'       , N'$1'),
(N'silver dollar'    , N'$1'),
(N'quarter eagle'    , N'$2.50'),
(N'three dollar'     , N'$3'),
(N'half eagle'       , N'$5'),
(N'double eagle'     , N'$20'),
(N'1/-'              , N'shilling'),
(N'2/- (florin)'     , N'florin'),
(N'2/6 (half crown)' , N'half crown'),
(N'5/- (crown)'      , N'crown'),
(N'halfcrown'        , N'half crown'),
(N'5s'               , N'crown'),
(N'1s'               , N'shilling');
GO

-- ============================================================
-- 2. Both sides of the comparison, in one table
-- ============================================================
-- The denomination Labels and the coins' stored text go into the SAME
-- staging table, with a Kind to tell them apart, for one reason: the
-- folding expression in step 3 then appears ONCE. Two copies of a fold
-- inside a single file is two things to keep in step, and the one that
-- drifts is the one nobody reads.
IF OBJECT_ID('tempdb..#Raw') IS NOT NULL DROP TABLE #Raw;

CREATE TABLE #Raw (
    Kind        CHAR(1)         NOT NULL,   -- 'D' = a Label, 'C' = coin text
    SourceId    INT             NULL,       -- DenominationId, for Kind 'D'
    IssuerId    INT             NULL,       -- the Label's issuer, for Kind 'D'
    CountryText NVARCHAR(100)   NULL,       -- the coin's Country, for Kind 'C'
    RawText     NVARCHAR(200)   NOT NULL,
    CoinCount   INT             NULL        -- how many coins say this, Kind 'C'
);

-- Only ACTIVE denominations. A soft-deleted row (design 4.4) must not pull
-- coins back onto a denomination the user removed.
INSERT INTO #Raw (Kind, SourceId, IssuerId, CountryText, RawText, CoinCount)
SELECT 'D', d.DenominationId, d.IssuerId, NULL, d.Label, NULL
FROM Denominations d
WHERE d.IsActive = 1;

-- DISTINCT (country, denomination) rather than one row per coin: the
-- question "what does this text mean?" has the same answer for all 23 coins
-- that say it, and the report wants the count anyway.
INSERT INTO #Raw (Kind, SourceId, IssuerId, CountryText, RawText, CoinCount)
SELECT 'C', NULL, NULL,
       ISNULL(LTRIM(RTRIM(c.Country)), N''),
       c.Denomination,
       COUNT(*)
FROM Coins c
WHERE c.Denomination IS NOT NULL
  AND LTRIM(RTRIM(c.Denomination)) <> N''
GROUP BY ISNULL(LTRIM(RTRIM(c.Country)), N''), c.Denomination;
GO

-- ============================================================
-- 3. The key -- fold, then alias, then the spelled-out rule
-- ============================================================
-- Exactly what denominationKey() does, in exactly that order:
--
--   FOLD      whitespace of every kind to a single space, the cent sign to
--             'c', the vulgar one-half to 'half', the pound sign to 'gbp',
--             lower case, runs of spaces collapsed, trimmed. So '50' +
--             cent-sign folds to '50c' and 'Half   Dollar' to 'half dollar'.
--
--   ALIAS     the table above, consulted on the folded text.
--
--   SPELLED   a RULE rather than a row, because '50 Cents' and '20 Dollars'
--             are a family and not a list: a leading number followed by
--             'cent(s)' or 'dollar(s)' becomes '50c' / '$20'. The number is
--             passed through verbatim, so '2.50 dollars' answers '$2.50'
--             and matches the Label, while '3 cents' answers '3c' and
--             matches nothing -- which is RIGHT, because the three-cent
--             silver and the three-cent nickel are both real and a bare
--             "3 cent" does not say which.
--
--   OTHERWISE the folded text itself.
--
-- The space-collapsing uses NCHAR(1) and NCHAR(2) as markers. Control
-- characters cannot occur in a denomination, so the trick cannot collide
-- with real data the way the usual '<>' marker could.
IF OBJECT_ID('tempdb..#Keyed') IS NOT NULL DROP TABLE #Keyed;

CREATE TABLE #Keyed (
    Kind        CHAR(1)         NOT NULL,
    SourceId    INT             NULL,
    IssuerId    INT             NULL,
    CountryText NVARCHAR(100)   NULL,
    RawText     NVARCHAR(200)   NOT NULL,
    CoinCount   INT             NULL,
    DenomKey    NVARCHAR(200)   NOT NULL
);

INSERT INTO #Keyed (Kind, SourceId, IssuerId, CountryText, RawText, CoinCount, DenomKey)
SELECT r.Kind, r.SourceId, r.IssuerId, r.CountryText, r.RawText, r.CoinCount,
       COALESCE(a.DenomKey, sp.Spelled, f.Flat)
FROM #Raw r
CROSS APPLY (
    SELECT Flat = LTRIM(RTRIM(
        REPLACE(REPLACE(REPLACE(
            LOWER(
                REPLACE(REPLACE(REPLACE(
                    REPLACE(REPLACE(REPLACE(REPLACE(
                        r.RawText,
                        NCHAR(9),   N' '),
                        NCHAR(10),  N' '),
                        NCHAR(13),  N' '),
                        NCHAR(160), N' '),
                    NCHAR(162), N'c'),
                    NCHAR(189), N'half'),
                    NCHAR(163), N'gbp')
            ),
        N' ', NCHAR(1) + NCHAR(2)),
        NCHAR(2) + NCHAR(1), N''),
        NCHAR(1) + NCHAR(2), N' ')
    ))
) AS f
LEFT JOIN #Alias a ON a.Folded = f.Flat
CROSS APPLY (
    SELECT
        Head = CASE
            WHEN f.Flat LIKE N'%cents'   THEN LTRIM(RTRIM(LEFT(f.Flat, LEN(f.Flat) - 5)))
            WHEN f.Flat LIKE N'%cent'    THEN LTRIM(RTRIM(LEFT(f.Flat, LEN(f.Flat) - 4)))
            WHEN f.Flat LIKE N'%dollars' THEN LTRIM(RTRIM(LEFT(f.Flat, LEN(f.Flat) - 7)))
            WHEN f.Flat LIKE N'%dollar'  THEN LTRIM(RTRIM(LEFT(f.Flat, LEN(f.Flat) - 6)))
        END,
        Unit = CASE
            WHEN f.Flat LIKE N'%cent' OR f.Flat LIKE N'%cents'     THEN N'c'
            WHEN f.Flat LIKE N'%dollar' OR f.Flat LIKE N'%dollars' THEN N'$'
        END
) AS h
CROSS APPLY (
    -- The four refusals are the regular expression's, one clause each:
    -- it must start with a digit, contain only digits and dots, carry at
    -- most one dot, and not end on one.
    SELECT Spelled = CASE
        WHEN h.Head IS NULL              THEN NULL
        WHEN h.Head NOT LIKE N'[0-9]%'   THEN NULL
        WHEN h.Head LIKE N'%[^0-9.]%'    THEN NULL
        WHEN h.Head LIKE N'%.%.%'        THEN NULL
        WHEN h.Head LIKE N'%.'           THEN NULL
        WHEN h.Unit = N'c'               THEN h.Head + N'c'
        ELSE N'$' + h.Head
    END
) AS sp;
GO

-- ============================================================
-- 4. The decision
-- ============================================================
-- MatchCount  -- active denominations whose Label folds to the same key.
-- ScopedCount -- how many of those belong to an issuer this coin's country
--                names exactly, by Name or by IsoCode.
--
-- One row per distinct (country, text) pair, and the CASE is the three
-- rules of the header in the order they are written there.
IF OBJECT_ID('tempdb..#Resolved') IS NOT NULL DROP TABLE #Resolved;

CREATE TABLE #Resolved (
    CountryText NVARCHAR(100)   NOT NULL,
    DenomText   NVARCHAR(200)   NOT NULL,
    CoinCount   INT             NOT NULL,
    DenomKey    NVARCHAR(200)   NOT NULL,
    MatchCount  INT             NOT NULL,
    ScopedCount INT             NOT NULL,
    ResolvedId  INT             NULL
);

INSERT INTO #Resolved (CountryText, DenomText, CoinCount, DenomKey, MatchCount, ScopedCount, ResolvedId)
SELECT t.CountryText, t.RawText, t.CoinCount, t.DenomKey,
       m.MatchCount, s.ScopedCount,
       CASE
           -- 1. the country names exactly one matching row: that is it,
           --    even where the same text is ambiguous database-wide.
           WHEN s.ScopedCount = 1 THEN s.ScopedId
           -- 2. the country named none: widen to every issuer. THE 8 REALES
           --    CASE -- those coins all say 'United States'.
           WHEN s.ScopedCount = 0 AND m.MatchCount = 1 THEN m.MatchId
           -- 3. still more than one. Leave it NULL and report it.
           ELSE NULL
       END
FROM #Keyed t
CROSS APPLY (
    SELECT MatchCount = COUNT(*), MatchId = MIN(k.SourceId)
    FROM #Keyed k
    WHERE k.Kind = 'D' AND k.DenomKey = t.DenomKey
) AS m
CROSS APPLY (
    SELECT ScopedCount = COUNT(*), ScopedId = MIN(k.SourceId)
    FROM #Keyed k
    INNER JOIN Issuers i ON i.IssuerId = k.IssuerId
    WHERE k.Kind = 'D' AND k.DenomKey = t.DenomKey
      AND (i.Name = t.CountryText OR i.IsoCode = t.CountryText)
) AS s
WHERE t.Kind = 'C';
GO

-- ============================================================
-- 5. Write the ids -- and NOTHING else
-- ============================================================
-- The only assignment this script makes to the Coins table. Note what is
-- not here: Denomination, Country, and everything else.
--
-- "WHERE c.DenominationId IS NULL" does two jobs. It makes a second run a
-- no-op, and it means a link the user made by hand in the editor is never
-- overwritten by a script's opinion.
DECLARE @Linked INT;

UPDATE c
SET DenominationId = t.ResolvedId
FROM Coins c
INNER JOIN #Resolved t
    ON ISNULL(LTRIM(RTRIM(c.Country)), N'') = t.CountryText
   AND c.Denomination = t.DenomText
WHERE c.DenominationId IS NULL
  AND t.ResolvedId IS NOT NULL;

SET @Linked = @@ROWCOUNT;

PRINT 'Migration 014: linked ' + CAST(@Linked AS NVARCHAR(20)) + ' coin(s) to a denomination.';
GO

-- ============================================================
-- 6. THE REPORT -- the review artefact
-- ============================================================
-- Every distinct value that could not be resolved, with how many coins say
-- it and WHY it failed. The two reasons want different actions:
--
--   "no denomination matches this text"  the seed is missing something, or
--                                        the text is a coin TYPE rather
--                                        than a denomination.
--   "ambiguous ..."                      the denomination exists under
--                                        several issuers and the coin's
--                                        country does not say which. Set
--                                        the country, or pick it by hand.
--
-- Reported twice on purpose: PRINT for sqlcmd, and a result set at the end
-- for anyone running this in SSMS, where PRINT output hides on another tab.
IF OBJECT_ID('tempdb..#Unresolved') IS NOT NULL DROP TABLE #Unresolved;

CREATE TABLE #Unresolved (
    RowNum  INT             IDENTITY(1,1) PRIMARY KEY,
    Line    NVARCHAR(400)   NOT NULL
);

INSERT INTO #Unresolved (Line)
SELECT LEFT(
        N'  ' + r.DenomText
        + N'  [' + CASE WHEN r.CountryText = N'' THEN N'no country' ELSE r.CountryText END + N']'
        + N'  ... ' + CAST(r.CoinCount AS NVARCHAR(20)) + N' coin(s)  -- '
        + CASE
            WHEN r.MatchCount = 0  THEN N'no denomination matches this text'
            WHEN r.ScopedCount > 1 THEN N'ambiguous: ' + CAST(r.ScopedCount AS NVARCHAR(20))
                                        + N' rows under this country fold to the same key'
            ELSE                        N'ambiguous: ' + CAST(r.MatchCount AS NVARCHAR(20))
                                        + N' issuers use this denomination and the country names none of them'
          END, 400)
FROM #Resolved r
WHERE r.ResolvedId IS NULL
ORDER BY r.CoinCount DESC, r.DenomText;
GO

DECLARE @Rows    INT = (SELECT COUNT(*) FROM #Unresolved);
DECLARE @Affected INT = (SELECT ISNULL(SUM(CoinCount), 0) FROM #Resolved WHERE ResolvedId IS NULL);
DECLARE @Index   INT = 1;
DECLARE @Line    NVARCHAR(400);

PRINT '';
PRINT '============================================================';
PRINT ' Denomination values that could not be resolved';
PRINT '============================================================';

IF @Rows = 0
BEGIN
    PRINT '  (none -- every coin with a denomination was linked)';
END
ELSE
BEGIN
    WHILE @Index <= @Rows
    BEGIN
        SELECT @Line = Line FROM #Unresolved WHERE RowNum = @Index;
        PRINT @Line;
        SET @Index = @Index + 1;
    END

    PRINT '';
    PRINT '  ' + CAST(@Rows AS NVARCHAR(20)) + ' distinct value(s), '
        + CAST(@Affected AS NVARCHAR(20)) + ' coin(s).';
    PRINT '  These coins keep their text and read as "Other (<text>)" in the';
    PRINT '  app. Nothing has been lost; pick a denomination for them in the';
    PRINT '  editor, or add the missing one, and they link straight back up.';
END
GO

-- ============================================================
-- SUMMARY
-- ============================================================
DECLARE @Total   INT = (SELECT COUNT(*) FROM Coins);
DECLARE @WithText INT = (SELECT COUNT(*) FROM Coins WHERE Denomination IS NOT NULL AND LTRIM(RTRIM(Denomination)) <> N'');
DECLARE @WithId  INT = (SELECT COUNT(*) FROM Coins WHERE DenominationId IS NOT NULL);

PRINT '';
PRINT '--- After migration 014 ---';
PRINT 'Coins ........................... ' + CAST(@Total    AS NVARCHAR(20));
PRINT '  ... with a denomination typed . ' + CAST(@WithText AS NVARCHAR(20));
PRINT '  ... now linked to a lookup row  ' + CAST(@WithId   AS NVARCHAR(20));
PRINT '';
PRINT 'Coins.Denomination was not written. To undo this migration entirely:';
PRINT '    UPDATE Coins SET DenominationId = NULL;';
GO

-- The same report as a result set, for SSMS.
SELECT
    Denomination = r.DenomText,
    Country      = CASE WHEN r.CountryText = N'' THEN N'(none)' ELSE r.CountryText END,
    Coins        = r.CoinCount,
    FoldedKey    = r.DenomKey,
    Candidates   = r.MatchCount,
    InCountry    = r.ScopedCount
FROM #Resolved r
WHERE r.ResolvedId IS NULL
ORDER BY r.CoinCount DESC, r.DenomText;
GO

DROP TABLE #Alias;
DROP TABLE #Raw;
DROP TABLE #Keyed;
DROP TABLE #Resolved;
DROP TABLE #Unresolved;
GO
