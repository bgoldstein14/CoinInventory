-- ============================================================
-- 007-infer-coin-metal-data.sql
-- Fill in Coins.MetalContent, Composition, PmWeightGrams and PmPercent
-- for existing coins, inferred from the detail the row already carries
-- ============================================================
--
-- *** THIS IS A DATA MIGRATION, NOT A SCHEMA MIGRATION ***
-- Everything from 002 to 006 changed the SHAPE of the database: a column
-- added, a precision widened, a table dropped. Not one of them looked inside a
-- row. This one is the opposite. It changes no column, no index and no
-- constraint; it touches nothing but the VALUES in four nullable columns. Read
-- its guards with that in mind: 002-006 ask "does this object exist yet?",
-- while this one asks "is this cell empty, and does the rest of the row
-- actually DETERMINE what belongs in it?".
--
-- ============================================================
-- WHY
-- ============================================================
-- The owner, on the metal:
--
--     "Can we do a one-time fix for metal content. Most coins with PM don't
--      have a choice. Let's fix it at the database level with a one-time
--      script. The metal content can be inferred by all the context given by
--      the coin detail already there."
--
-- He is right, and the point is worth restating precisely: for most coins the
-- metal is not genuinely unknown. It is already implied by the denomination,
-- the year, the coin type or the category sitting in the same row. A $20
-- Saint-Gaudens cannot be made of anything but gold. A 1916 Mercury dime
-- cannot be made of anything but silver. This script writes down what the row
-- already implies, wherever the implication is unambiguous.
--
-- Then, on Composition -- a column he had asked to have DROPPED, "because you
-- never filled it in" -- he changed his mind once it became clear it could be
-- populated: "Maybe if you fill it in for all coins, that would be good
-- then... we'd need something to initialize it, preferably from the database
-- side as a one-shot SQL."
--
-- And finally, on the numbers: "might as well fix the coin weight (total
-- weight in grams), PM weight (grams), PM %. Let's do it all. Most is still
-- missing in the DB."
--
-- ------------------------------------------------------------
-- SCOPE: FOUR COLUMNS IN, ONE COLUMN DELIBERATELY OUT
-- ------------------------------------------------------------
-- WRITES:  Coins.MetalContent     the coarse classification ('Gold', 'Clad')
--          Coins.Composition      the alloy description ('90% Gold, 10% Copper')
--          Coins.PmWeightGrams    PURE precious metal, in grams
--          Coins.PmPercent        alloy fineness as a percentage
--
-- DOES NOT WRITE:  Coins.Weight
--
-- *** Coins.Weight IS NOT THIS SCRIPT'S BUSINESS. DO NOT ADD IT HERE. ***
-- That column currently holds the coin's GROSS weight in TROY OUNCES, and the
-- owner has separately decided to change its units to GRAMS. That is not a
-- fill-in-the-blanks job like this one -- it means multiplying every existing
-- value by 31.1035, which is a one-way transformation of data that is already
-- there, and which is impossible to distinguish afterwards from a value that
-- was always in grams. Run it twice and every weight is 31x too big with
-- nothing in the row to reveal it.
--
-- That is why it lives in its own file, migration 008, written separately so
-- it can be reasoned about, previewed and reverted entirely on its own.
-- Bundling a destructive unit conversion into a cautious blank-filler would
-- mean the two could only ever be rolled back together.
--
-- Note also that Weight and PmWeightGrams measure DIFFERENT THINGS in
-- DIFFERENT UNITS -- gross coin versus pure precious metal, ounces versus
-- grams. Confusing them is exactly the bug that once made every melt value in
-- this app wrong (see computeMeltValue in services/inventory/inventory-metrics).
--
-- ============================================================
-- READ THIS FIRST: COMPOSITION IS ALMOST ALWAYS EMPTY, SO IT IS
-- **NOT** THE RULE THAT CARRIES THIS SCRIPT
-- ============================================================
-- It is tempting -- and it would be wrong -- to read the evidence ladder in
-- STEP 3, see that Composition is consulted first, and conclude that most rows
-- were classified from their composition text. They will not be. Almost none
-- of them will be.
--
-- Composition is the strongest evidence that exists, because it states the
-- alloy outright, and that is why it sits at the top. But in the owner's
-- ACTUAL database the column is essentially blank. The application only began
-- writing composition strings very recently, through the precious-metal
-- inference on import. Everything loaded before that change -- which is nearly
-- the whole inventory, and precisely the rows this script exists to fix -- has
-- Composition blank for exactly the same reason it has MetalContent blank:
-- nothing ever filled it in.
--
-- So the composition rules are kept because they cost nothing and are the most
-- reliable answer available WHEN a value is there (rows imported since the
-- change will have one, as will anything the owner typed). But the work of
-- this migration is done by:
--
--     DENOMINATION, YEAR, COIN TYPE and CATEGORY.
--
-- Those are therefore developed to the same standard of care, not left as a
-- thin fallback. STEP 5's preview and STEP 9's summary both break the result
-- down BY KIND OF EVIDENCE, so you can see at a glance how much of the outcome
-- rests on something hard (a denomination and a year) and how much on
-- something soft (a category name), rather than taking this paragraph's word
-- for it.
--
-- ============================================================
-- WHERE THE NUMBERS COME FROM, AND HOW YOU KNOW THEY ARE RIGHT
-- ============================================================
-- Every alloy fact in this file -- every metal, every composition string,
-- every gram weight, every percentage -- is a VERBATIM COPY of
-- src/app/services/pm-reference.ts. Nothing here was derived from numismatic
-- knowledge, recalled, or rounded. STEP 2 below is a straight transcription of
-- that file's PM_REFERENCE_DATA array into a temporary table, one SQL row per
-- TypeScript entry, in the same order.
--
-- Transcribing several dozen decimal numbers by hand into another language is
-- exactly the kind of task that produces one wrong digit nobody notices until
-- a melt value is quietly wrong by a hundred dollars. So the copy is not
-- trusted -- IT IS MECHANICALLY CHECKED:
--
--     src/app/services/sql-pm-reference-parity.spec.ts
--
-- That spec reads THIS FILE off disk, parses the rows out of STEP 2, and
-- asserts that every single one agrees with pm-reference.ts -- same
-- denominations, same year ranges, same metals, same composition strings
-- character for character, same weights to five decimal places, same
-- percentages, same `requiresHint` flags, same number of rows, nothing extra
-- and nothing missing. It then goes further and checks the SQL's RESOLUTION
-- RULES against `lookupCoinAlloy` itself, including the cases where that
-- function deliberately refuses to answer.
--
-- One wrong digit here turns the frontend test suite red. That spec is the
-- entire reason it is acceptable to have these numbers written down twice.
--
--     IF YOU EDIT pm-reference.ts, RE-RUN `npm test`. IF IT GOES RED,
--     REGENERATE STEP 2 FROM THE TYPESCRIPT -- DO NOT HAND-PATCH IT.
--
-- Why the strings in particular must match character for character: a row
-- filled by this script has to be INDISTINGUISHABLE from a row filled by the
-- application. If SQL writes "90% gold, 10% copper" while the Quicken import
-- writes "90% Gold, 10% Copper", the column now holds two spellings of one
-- alloy, and grouping, filtering and the exact-match composition lookup in
-- STEP 3 all quietly stop working on half the inventory.
--
-- ============================================================
-- THE DESIGN: REPRODUCE pm-reference.ts's RESOLVER, DO NOT REINVENT IT
-- ============================================================
-- The obvious way to write this script would have been a long CASE expression
-- full of hand-written rules -- "$20 means gold", "a quarter dated 1964 or
-- earlier is silver". That was rejected. A second set of rules is a second
-- thing to get wrong, and nothing would have checked it.
--
-- Instead STEP 2 copies pm-reference.ts's DATA, and STEP 3 reimplements
-- pm-reference.ts's `resolveEntry` FUNCTION in SQL:
--
--   1. Take every reference entry whose denomination matches this coin and
--      whose country matches (or which names no country).
--   2. If we have a metal hint, keep only entries in that metal. If we do not,
--      hide the entries flagged `requiresHint`.
--   3. Prefer entries whose year range actually contains this coin's year.
--      Fall back to undated entries (the British Sovereign, whose
--      specification never changed) only when no dated entry matches.
--   4. IF WHAT SURVIVED NAMES MORE THAN ONE METAL, ANSWER NOTHING. The
--      year/denomination pair genuinely did not determine the alloy.
--
-- This buys something important for free. Every deliberate refusal in
-- pm-reference.ts is expressed as an ABSENCE or an OVERLAP in the data, so
-- copying the data copies the refusals exactly, with no extra code:
--
--   * 1942 nickel ........ no 1942 row exists (cupronickel AND 35% silver were
--                          both struck that year). Step 3 finds nothing.
--   * 1982 cent .......... no 1982 row exists (bronze AND copper-plated zinc).
--   * 1971-78 Eisenhower . no rows for those years (clad business strikes AND
--                          40% silver collector issues).
--   * bare $1, 1849-1889 . TWO rows match, one Gold and one Silver, so rule 4
--                          above refuses. This is the gold-dollar versus
--                          silver-dollar collision.
--   * 1856-57 cent ....... the copper large cent (1793-1857) and the
--                          copper-nickel small cent (1856-1863) overlap, so
--                          rule 4 refuses.
--   * 1866-73 five cents . the silver half dime (1853-1873) and the
--                          copper-nickel nickel (1866-1941) overlap; refused.
--
-- Those are every case the owner asked to be left alone, and not one of them
-- needed a special rule. They fall out of the design. Verified by the parity
-- spec, which asserts the SQL refuses wherever `lookupCoinAlloy` refuses.
--
-- ------------------------------------------------------------
-- SO WHAT DOES THIS SCRIPT ADD, OVER THE IN-APP BACKFILL?
-- ------------------------------------------------------------
-- Two things, and they are the reason it is worth running at all.
--
-- FIRST, IT CLEANS UP THE INPUTS. The reference lookup needs a canonical
-- denomination, a canonical country and a usable year. Real rows do not have
-- those: the denomination might say "Quarter" or "Half Eagle" instead of "25c"
-- or "$5", the country might say 'US' or 'United States' or nothing at all,
-- and the year might say '1878-S' or '1776-1976'. STEP 3 normalises all of it
-- before asking.
--
-- SECOND, AND MORE IMPORTANTLY, IT SUPPLIES THE METAL HINT. Look at
-- `pmFieldsToFill` in pm-fill.ts: the in-app backfill passes the coin's
-- EXISTING MetalContent into the lookup as a `metalHint`, and a hint is
-- exactly what breaks the two ties the resolver otherwise refuses -- the
-- 1849-1889 "$1", and the 1992-or-later silver proof dime and quarter. But on
-- a coin whose MetalContent is blank there is no hint to pass, so the in-app
-- backfill cannot resolve those coins AT ALL. It leaves them, forever.
--
-- This script derives a hint from the rest of the row -- an explicit "Gold" in
-- the coin type, a "Silver Dollars" category, a design name that only ever
-- existed in one metal -- and hands THAT to the resolver. That is precisely
-- what the owner meant by "inferred by all the context given by the coin
-- detail already there", and it is why running this first UNLOCKS rows rather
-- than merely racing the in-app backfill to them.
--
--     RUN THIS SCRIPT, THEN RUN THE PM BACKFILL IN THE SETTINGS DIALOG.
--     The backfill will pick up anything this script could not reach, using
--     the same tested engine.
--
-- ------------------------------------------------------------
-- RELATED, AND WORTH READING FIRST: metal-inference.ts
-- ------------------------------------------------------------
-- src/app/services/metal-inference.ts answers the same "what metal is this?"
-- question in TypeScript, for the import path, and it is unit tested. Several
-- of its conclusions were adopted here rather than rediscovered:
--
--   * THE "CAC GOLD" TRAP. "CAC Gold" is Certified Acceptance Corporation's
--     top STICKER TIER, not a metal, and it sits on silver coins constantly
--     ("1875 20c - PCGS XF40 CAC Gold" is a 90% silver twenty-cent piece).
--     The phrase is scrubbed before any metal word is read. See the comment on
--     the `t2` apply in STEP 3.
--
--   * BASE-METAL WORDS IN A COIN TYPE ARE A DENOMINATION, NOT AN ALLOY. A
--     "Jefferson Nickel" dated 1943 is 35% SILVER and a "Three Cent Nickel" is
--     75% copper, so the word "nickel" in a type name is ignored entirely.
--     Only the four precious metals are read out of a type name.
--
--   * CATEGORY IS THE OWNER'S FILING CABINET, NOT THE COIN. metal-inference.ts
--     refuses to read it at all. This script is slightly more permissive --
--     see the long note on the outcome rules in STEP 3 for exactly how far,
--     and why.
--
-- The duplication between that file and this one is real but narrow: it is
-- confined to the HINT ladder (which design names imply which metal), and the
-- hint only ever narrows a lookup whose answers come from pm-reference.ts.
-- The alloy facts themselves are not duplicated -- they are transcribed once,
-- into STEP 2, and checked by the parity spec.
--
-- ============================================================
-- THE OUTPUT VOCABULARY FOR MetalContent IS FIXED
-- ============================================================
-- setup-database.sql seeds a MetalContents lookup table with exactly fifteen
-- values, and the coin editor renders Metal as a <select> fed from it:
--
--     Gold, Silver, Platinum, Palladium, Copper, Nickel, Copper-Nickel,
--     Bronze, Brass, Zinc, Steel, Aluminum, Nickel-Brass, Clad, Other
--
-- Writing anything else -- "Cupronickel", "90% Silver", "gold" in lower case
-- -- would put a value in the column that the dropdown cannot display, so the
-- editor would show a BLANK Metal field for a coin that has one. Every value
-- this script can produce is one of those fifteen, and STEP 4 REFUSES TO
-- CONTINUE if that ever stops being true.
--
-- ============================================================
-- THE COMPOSITION TRAP: THOSE STRINGS NAME MORE THAN ONE METAL
-- ============================================================
-- This matters only for the minority of rows that already HAVE a composition
-- -- which STEP 3 reads backwards, to recover a metal hint from it -- but it
-- is the subtlest thing in the file.
--
-- The strings pm-reference.ts writes name SEVERAL metals each:
--
--     90% Gold, 10% Copper
--     91.67% Gold, 8.33% Silver and Copper
--     89.92% Gold, 10.08% Silver and Copper
--
-- A naive `WHERE Composition LIKE '%Copper%' THEN 'Copper'` classifies every
-- one of those GOLD coins as copper. `LIKE '%Silver%'` classifies the second
-- and third as silver. Both are wrong, and both are wrong SILENTLY.
--
-- The usual fix is "take the first metal named, because these are written
-- majority-first". That was CHECKED against every composition string in
-- pm-reference.ts rather than assumed. It is right for the gold and silver
-- alloys above -- and it is NOT right everywhere. Two counter-examples exist
-- in the reference table:
--
--   (a) FIRST-NAMED IS NOT THE LARGEST SHARE:
--           '40% Silver clad (80% silver outer layers, 21% silver core)'
--       Silver is named first but is only 40% of the coin by mass; the other
--       60% is copper. Here "first named" gives the RIGHT answer (Silver) and
--       "largest percentage" would give the WRONG one (Copper). That is why
--       the positional rule orders on POSITION IN THE STRING, not magnitude.
--
--   (b) FIRST-NAMED IS THE LARGEST SHARE AND IS STILL WRONG:
--           '56% Copper, 35% Silver, 9% Manganese (wartime alloy)'
--       The 1943-45 "war nickel". Copper is named first AND is the majority at
--       56%, so BOTH rules answer Copper -- and both are wrong. The coin is
--       classified Silver throughout this project, because the 35% silver is
--       the only part anybody cares about and it is what drives the melt
--       value.
--
--   And a third family, where "which metals are named?" is the wrong question
--   altogether, because the alloy has a NAME of its own that the dropdown
--   expects instead of its ingredients:
--
--       'Copper-Nickel clad (75% Cu / 25% Ni over pure copper core)' -> Clad
--       '75% Copper, 25% Nickel'                  -> Copper-Nickel, not Copper
--       '95% Copper, 5% Tin and Zinc'             -> Bronze,        not Copper
--       'Copper-plated zinc (97.5% Zn, 2.5% Cu)'  -> Zinc,          not Copper
--       'Manganese brass (88.5% Cu, 6% Zn, 3.5% Mn, 2% Ni)' -> Brass
--
-- STEP 3 answers all of this with a two-layer reader. LAYER 1 is an EXACT
-- lookup against the 22 distinct composition strings transcribed in STEP 2,
-- each mapped to the metal pm-reference.ts itself assigns -- so every
-- machine-written row is resolved with no guessing whatsoever, and cases (a)
-- and (b) are simply looked up rather than reasoned about. LAYER 2 is a set of
-- word-based heuristics that only ever see text the exact table did NOT
-- recognise (something the owner typed, or something the CSV importer brought
-- in), ordered so the named alloys and the special cases are tested BEFORE the
-- positional "first metal named" rule gets a chance to answer.
--
-- ============================================================
-- THE GOVERNING PRINCIPLE: WHEN IN DOUBT, WRITE NOTHING
-- ============================================================
-- Copied, deliberately, from the top of pm-reference.ts:
--
--     A WRONG PURITY SILENTLY PRODUCES A WRONG MELT VALUE.
--     A BLANK FIELD IS VISIBLE AND THE USER CAN FIX IT.
--
-- PmWeightGrams and MetalContent feed `computeMeltValue`. A misclassified coin
-- does not raise an error or a warning -- it produces a confident dollar
-- figure that is wrong, on a screen the owner trusts. A blank produces an
-- honest dash. The blank is strictly better. The same goes for Composition: a
-- wrong alloy description is worse than an honest gap, and worse again because
-- anything that later reads the column -- including this script's own
-- composition reader on a future run -- would treat it as evidence.
--
-- The four columns are decided INDEPENDENTLY. Plenty of evidence settles the
-- metal without settling the alloy: "the Category says Gold" is good enough to
-- write 'Gold' and nowhere near good enough to write a fineness or a gram
-- weight. Those coins get a metal and nothing else. Likewise a base-metal coin
-- genuinely HAS no precious-metal weight, so its PmWeightGrams and PmPercent
-- stay blank -- writing 0 would be a recorded fact rather than an absence, a
-- distinction pm-fill.ts is careful about and this script matches.
--
-- ============================================================
-- SAFETY
-- ============================================================
--   * ONLY BLANKS ARE FILLED, PER COLUMN. A coin whose Metal was typed in by
--     hand but whose Composition is empty gets the composition and keeps the
--     metal. Nothing already in any of the four columns is ever overwritten --
--     the owner's typing outranks this script's inference. STEP 7's UPDATE
--     re-checks emptiness at the moment it writes, not just when it planned.
--
--   * ZERO IS A VALUE, NOT A BLANK. A PmWeightGrams of 0 is a number somebody
--     put there and it is left alone, exactly as `isPmFieldBlank` in pm-fill.ts
--     treats it. Only NULL counts as empty for the two numeric columns.
--
--   * A STORED METAL THAT CONTRADICTS THE RESOLVER STOPS THE WHOLE ROW. If a
--     row already says 'Silver' and the lookup concludes 'Clad', the script
--     does not quietly write the clad composition and weights onto it.
--     Deferring to the owner in one column while overruling him in another
--     would produce a self-contradictory row. The row is skipped entirely and
--     counted under "conflicts with the metal already recorded".
--
--   * A BACKUP IS TAKEN FIRST. STEP 6 copies the affected ids and ALL FOUR
--     prior values into Coins_MetalData_Backup before a single row changes.
--     The undo statement is printed by STEP 6 and repeated by STEP 9.
--
--   * YOU SEE IT BEFORE IT HAPPENS. STEP 5 prints the full breakdown -- per
--     metal, per kind of evidence, per column, and the leave-alone count --
--     BEFORE the update runs, so the effect is in the log rather than
--     discovered afterwards.
--
--   * ALL OR NOTHING. STEP 7 wraps the UPDATE in an explicit transaction with
--     SET XACT_ABORT ON and a TRY/CATCH, so a failure part way through rolls
--     back rather than leaving the table half-converted.
--
--   * IDEMPOTENT. Run it twice and the second run finds nothing to do: the
--     cells it filled are no longer blank, so they are not selected. It
--     reports "0 rows to update" and changes nothing. It also refuses to
--     clobber an existing backup table.
--
-- ============================================================
-- HOW TO RUN IT
-- ============================================================
--   sqlcmd -S localhost -d CoinInventory -E -i .\migrations\007-infer-coin-metal-data.sql
--
-- ...or open it in SSMS / Azure Data Studio with CoinInventory selected and
-- press Execute.
--
-- RUN THE WHOLE FILE, TOP TO BOTTOM, IN ONE CONNECTION. The steps communicate
-- through #temp tables, which live for the length of the SESSION, so executing
-- one highlighted step on its own will not work.
--
-- Afterwards, open Settings in the app and run the PM backfill. No API restart
-- is needed -- nothing about the schema changed, only the data.
--
-- ============================================================
-- IT HAS NOT BEEN EXECUTED
-- ============================================================
-- This file was written without access to a database. It has NEVER BEEN RUN --
-- not against the owner's data, not against an empty CoinInventory, not at all
-- -- and no line of its output below has been observed by anybody.
--
-- What HAS been verified is the data: the parity spec described above runs in
-- the normal frontend test suite and checks every number in STEP 2 against
-- pm-reference.ts. So the facts are checked and the SQL is not. Read the STEP
-- 5 preview before letting it write.
-- ============================================================

USE CoinInventory;
GO

SET NOCOUNT ON;
GO

-- ============================================================
-- STEP 0: is the database the shape this script expects?
-- ============================================================
-- Cheap, read-only, and it turns a confusing failure three batches later into
-- one clear line now. Nothing here halts the script; the later steps are each
-- guarded in their own right.

IF OBJECT_ID('Coins', 'U') IS NULL
    PRINT 'Migration 007: WARNING - the Coins table does not exist. Has setup-database.sql been run?';
ELSE
BEGIN
    IF COL_LENGTH('Coins', 'MetalContent')  IS NULL PRINT 'Migration 007: WARNING - Coins.MetalContent is missing.';
    IF COL_LENGTH('Coins', 'Composition')   IS NULL PRINT 'Migration 007: WARNING - Coins.Composition is missing.';
    IF COL_LENGTH('Coins', 'PmWeightGrams') IS NULL PRINT 'Migration 007: WARNING - Coins.PmWeightGrams is missing.';
    IF COL_LENGTH('Coins', 'PmPercent')     IS NULL PRINT 'Migration 007: WARNING - Coins.PmPercent is missing.';

    IF  COL_LENGTH('Coins', 'MetalContent')  IS NOT NULL
    AND COL_LENGTH('Coins', 'Composition')   IS NOT NULL
    AND COL_LENGTH('Coins', 'PmWeightGrams') IS NOT NULL
    AND COL_LENGTH('Coins', 'PmPercent')     IS NOT NULL
        PRINT 'Migration 007: all four target columns are present.';
END

-- Migration 004 widened PmWeightGrams to DECIMAL(12,5). If it has not been run
-- the column is still DECIMAL(10,4) and the fifth decimal of every weight this
-- script writes would be silently rounded away on the way in -- which is the
-- exact bug 004 exists to fix, reappearing through a different door. Reported
-- rather than enforced, because the values involved (30.09000, 0.67500) all
-- happen to fit in four decimals; it is the principle that is worth flagging.
IF EXISTS (SELECT 1 FROM sys.columns
           WHERE object_id = OBJECT_ID('Coins') AND name = 'PmWeightGrams'
             AND (precision <> 12 OR scale <> 5))
BEGIN
    PRINT '';
    PRINT 'Migration 007: NOTE - Coins.PmWeightGrams is not DECIMAL(12,5) yet.';
    PRINT '               Run migrations/004-widen-weight-precision.sql first so the';
    PRINT '               weights written below keep their full precision.';
    PRINT '';
END

IF OBJECT_ID('MetalContents', 'U') IS NULL
BEGIN
    PRINT 'Migration 007: NOTE - the MetalContents lookup table is missing, so STEP 4';
    PRINT '               will validate against the fifteen seeded values written into';
    PRINT '               this file instead of against the table.';
END
GO

-- ============================================================
-- STEP 1: clear out any temp tables left by an earlier run
-- ============================================================
-- A #temp table lives for the length of the CONNECTION, not the batch, which
-- is what lets STEPs 2 through 10 share one set of decisions. The flip side is
-- that running this file twice down one connection would find them already
-- there, so they are dropped first.
--
-- This sits in its OWN BATCH on purpose. DROP TABLE resolves its target when
-- it runs, but CREATE TABLE and SELECT ... INTO are checked when the batch is
-- COMPILED -- put both in one batch and SQL Server can object that the name
-- already exists before the DROP has had a chance to execute. One GO between
-- them removes the question entirely. (Same family of trap as the one written
-- up at length in the header of 006-drop-coin-dealer.sql.)

IF OBJECT_ID('tempdb..#PmReference')  IS NOT NULL DROP TABLE #PmReference;
IF OBJECT_ID('tempdb..#CoinPlan')     IS NOT NULL DROP TABLE #CoinPlan;
GO

-- ============================================================
-- STEP 2: pm-reference.ts, transcribed
-- ============================================================
-- *** GENERATED, NOT WRITTEN. DO NOT EDIT BY HAND. ***
--
-- Every row below is one entry of PM_REFERENCE_DATA from
-- src/app/services/pm-reference.ts, in the same order, with the same values.
-- The numbers were COPIED by reading that file, not recalled from numismatic
-- knowledge, and src/app/services/sql-pm-reference-parity.spec.ts re-reads
-- this very block on every test run and fails if a single character of it has
-- drifted.
--
-- TO REGENERATE: change pm-reference.ts, re-run `npm test`, and if the parity
-- spec goes red, re-emit this block from the TypeScript rather than patching
-- it here. The spec prints the exact mismatch.
--
-- COLUMN NOTES
--   EntryOrder     position in PM_REFERENCE_DATA. Used as the tie-break when
--                  two rows survive resolution, mirroring the TypeScript's
--                  `pool[0]`, which takes the first in array order.
--   DenomKey       the entry's `denomination`, folded to ASCII and lower case
--                  by the same rules STEP 3 applies to Coins.Denomination:
--                  cent sign -> 'c', one-half -> 'half', pound -> 'gbp'.
--                  So '50c' is the half dollar and 'half sovereign' is the
--                  British half sovereign.
--   YearMin/Max    NULL for an entry with no `yearRange` (the Sovereign, whose
--                  specification never changed since 1817). NULL here means
--                  "matches any year", and such entries are used only as a
--                  fallback -- see STEP 3.
--   PmWeightGrams  PURE precious metal in GRAMS, not the coin's gross weight.
--                  NULL for base-metal entries, which genuinely have none.
--   PmPercent      alloy fineness as a percentage (90 = 90% fine).
--   Country        lower-cased `country`. NULL would mean "any country"; every
--                  current entry names one.
--   RequiresHint   1 for entries that are INVISIBLE unless the caller supplies
--                  a matching metal hint. Used for issues that share a face
--                  value and a year with a much commoner coin: the 90% silver
--                  proof dimes and quarters struck from 1992 on, which are
--                  indistinguishable by date from the ordinary clad ones.

CREATE TABLE #PmReference (
    EntryOrder     INT             NOT NULL PRIMARY KEY,
    DenomKey       NVARCHAR(50)    NOT NULL,
    YearMin        INT             NULL,
    YearMax        INT             NULL,
    Metal          NVARCHAR(50)    NOT NULL,
    Composition    NVARCHAR(200)   NOT NULL,
    PmWeightGrams  DECIMAL(12,5)   NULL,
    PmPercent      DECIMAL(5,2)    NULL,
    Country        NVARCHAR(50)    NULL,
    RequiresHint   BIT             NOT NULL
);
GO

INSERT INTO #PmReference
    (EntryOrder, DenomKey, YearMin, YearMax, Metal, Composition, PmWeightGrams, PmPercent, Country, RequiresHint)
VALUES
    (  1, N'$1'             , 1849, 1889, N'Gold'          , N'90% Gold, 10% Copper'                                   ,   1.50000,  90.00, N'united states'  , 0),
    (  2, N'$2.50'          , 1796, 1833, N'Gold'          , N'91.67% Gold, 8.33% Silver and Copper'                   ,   4.01000,  91.67, N'united states'  , 0),
    (  3, N'$2.50'          , 1834, 1839, N'Gold'          , N'89.92% Gold, 10.08% Silver and Copper'                  ,   3.76000,  89.92, N'united states'  , 0),
    (  4, N'$2.50'          , 1840, 1929, N'Gold'          , N'90% Gold, 10% Copper'                                   ,   3.76000,  90.00, N'united states'  , 0),
    (  5, N'$3'             , 1854, 1889, N'Gold'          , N'90% Gold, 10% Copper'                                   ,   4.52000,  90.00, N'united states'  , 0),
    (  6, N'$5'             , 1795, 1833, N'Gold'          , N'91.67% Gold, 8.33% Silver and Copper'                   ,   8.02000,  91.67, N'united states'  , 0),
    (  7, N'$5'             , 1834, 1838, N'Gold'          , N'89.92% Gold, 10.08% Silver and Copper'                  ,   7.52000,  89.92, N'united states'  , 0),
    (  8, N'$5'             , 1839, 1929, N'Gold'          , N'90% Gold, 10% Copper'                                   ,   7.52000,  90.00, N'united states'  , 0),
    (  9, N'$10'            , 1795, 1804, N'Gold'          , N'91.67% Gold, 8.33% Silver and Copper'                   ,  16.04000,  91.67, N'united states'  , 0),
    ( 10, N'$10'            , 1838, 1933, N'Gold'          , N'90% Gold, 10% Copper'                                   ,  15.05000,  90.00, N'united states'  , 0),
    ( 11, N'$20'            , 1849, 1933, N'Gold'          , N'90% Gold, 10% Copper'                                   ,  30.09000,  90.00, N'united states'  , 0),
    ( 12, N'$1'             , 1794, 1935, N'Silver'        , N'90% Silver, 10% Copper'                                 ,  24.06000,  90.00, N'united states'  , 0),
    ( 13, N'50c'            , 1794, 1852, N'Silver'        , N'89.24% Silver, 10.76% Copper'                           ,  12.03000,  89.24, N'united states'  , 0),
    ( 14, N'50c'            , 1853, 1872, N'Silver'        , N'90% Silver, 10% Copper'                                 ,  11.20000,  90.00, N'united states'  , 0),
    ( 15, N'50c'            , 1873, 1964, N'Silver'        , N'90% Silver, 10% Copper'                                 ,  11.25000,  90.00, N'united states'  , 0),
    ( 16, N'50c'            , 1965, 1970, N'Silver'        , N'40% Silver clad (80% silver outer layers, 21% silver core)',   4.60000,  40.00, N'united states'  , 0),
    ( 17, N'50c'            , 1971, 2100, N'Clad'          , N'Copper-Nickel clad (75% Cu / 25% Ni over pure copper core)',      NULL,   NULL, N'united states'  , 0),
    ( 18, N'25c'            , 1796, 1852, N'Silver'        , N'89.24% Silver, 10.76% Copper'                           ,   6.01000,  89.24, N'united states'  , 0),
    ( 19, N'25c'            , 1853, 1872, N'Silver'        , N'90% Silver, 10% Copper'                                 ,   5.60000,  90.00, N'united states'  , 0),
    ( 20, N'25c'            , 1873, 1964, N'Silver'        , N'90% Silver, 10% Copper'                                 ,   5.63000,  90.00, N'united states'  , 0),
    ( 21, N'25c'            , 1965, 2100, N'Clad'          , N'Copper-Nickel clad (75% Cu / 25% Ni over pure copper core)',      NULL,   NULL, N'united states'  , 0),
    ( 22, N'25c'            , 1992, 2100, N'Silver'        , N'90% Silver, 10% Copper (silver proof issue)'            ,   5.63000,  90.00, N'united states'  , 1),
    ( 23, N'10c'            , 1796, 1852, N'Silver'        , N'89.24% Silver, 10.76% Copper'                           ,   2.41000,  89.24, N'united states'  , 0),
    ( 24, N'10c'            , 1853, 1872, N'Silver'        , N'90% Silver, 10% Copper'                                 ,   2.24000,  90.00, N'united states'  , 0),
    ( 25, N'10c'            , 1873, 1964, N'Silver'        , N'90% Silver, 10% Copper'                                 ,   2.25000,  90.00, N'united states'  , 0),
    ( 26, N'10c'            , 1965, 2100, N'Clad'          , N'Copper-Nickel clad (75% Cu / 25% Ni over pure copper core)',      NULL,   NULL, N'united states'  , 0),
    ( 27, N'10c'            , 1992, 2100, N'Silver'        , N'90% Silver, 10% Copper (silver proof issue)'            ,   2.25000,  90.00, N'united states'  , 1),
    ( 28, N'20c'            , 1875, 1878, N'Silver'        , N'90% Silver, 10% Copper'                                 ,   4.50000,  90.00, N'united states'  , 0),
    ( 29, N'5c'             , 1794, 1852, N'Silver'        , N'89.24% Silver, 10.76% Copper'                           ,   1.20000,  89.24, N'united states'  , 0),
    ( 30, N'5c'             , 1853, 1873, N'Silver'        , N'90% Silver, 10% Copper'                                 ,   1.12000,  90.00, N'united states'  , 0),
    ( 31, N'3cs'            , 1851, 1853, N'Silver'        , N'75% Silver, 25% Copper'                                 ,   0.60000,  75.00, N'united states'  , 0),
    ( 32, N'3cs'            , 1854, 1873, N'Silver'        , N'90% Silver, 10% Copper'                                 ,   0.67500,  90.00, N'united states'  , 0),
    ( 33, N'5c'             , 1866, 1941, N'Copper-Nickel' , N'75% Copper, 25% Nickel'                                 ,      NULL,   NULL, N'united states'  , 0),
    ( 34, N'5c'             , 1943, 1945, N'Silver'        , N'56% Copper, 35% Silver, 9% Manganese (wartime alloy)'   ,   1.75000,  35.00, N'united states'  , 0),
    ( 35, N'5c'             , 1946, 2100, N'Copper-Nickel' , N'75% Copper, 25% Nickel'                                 ,      NULL,   NULL, N'united states'  , 0),
    ( 36, N'1c'             , 1793, 1857, N'Copper'        , N'100% Copper (large cent)'                               ,      NULL,   NULL, N'united states'  , 0),
    ( 37, N'1c'             , 1856, 1863, N'Copper-Nickel' , N'88% Copper, 12% Nickel'                                 ,      NULL,   NULL, N'united states'  , 0),
    ( 38, N'1c'             , 1864, 1942, N'Bronze'        , N'95% Copper, 5% Tin and Zinc'                            ,      NULL,   NULL, N'united states'  , 0),
    ( 39, N'1c'             , 1943, 1943, N'Steel'         , N'Zinc-coated steel'                                      ,      NULL,   NULL, N'united states'  , 0),
    ( 40, N'1c'             , 1944, 1981, N'Bronze'        , N'95% Copper, 5% Zinc'                                    ,      NULL,   NULL, N'united states'  , 0),
    ( 41, N'1c'             , 1983, 2100, N'Zinc'          , N'Copper-plated zinc (97.5% Zn, 2.5% Cu)'                 ,      NULL,   NULL, N'united states'  , 0),
    ( 42, N'2c'             , 1864, 1873, N'Bronze'        , N'95% Copper, 5% Tin and Zinc'                            ,      NULL,   NULL, N'united states'  , 0),
    ( 43, N'3cn'            , 1865, 1889, N'Copper-Nickel' , N'75% Copper, 25% Nickel'                                 ,      NULL,   NULL, N'united states'  , 0),
    ( 44, N'halfc'          , 1793, 1857, N'Copper'        , N'100% Copper'                                            ,      NULL,   NULL, N'united states'  , 0),
    ( 45, N'$1'             , 1979, 1999, N'Clad'          , N'Copper-Nickel clad (75% Cu / 25% Ni over pure copper core)',      NULL,   NULL, N'united states'  , 0),
    ( 46, N'$1'             , 2000, 2100, N'Brass'         , N'Manganese brass (88.5% Cu, 6% Zn, 3.5% Mn, 2% Ni)'      ,      NULL,   NULL, N'united states'  , 0),
    ( 47, N'sovereign'      , NULL, NULL, N'Gold'          , N'91.67% Gold, 8.33% Copper (22 carat crown gold)'        ,   7.32000,  91.67, N'great britain'  , 0),
    ( 48, N'half sovereign' , NULL, NULL, N'Gold'          , N'91.67% Gold, 8.33% Copper (22 carat crown gold)'        ,   3.66000,  91.67, N'great britain'  , 0),
    ( 49, N'crown'          , 1707, 1919, N'Silver'        , N'92.5% Silver, 7.5% Copper (sterling)'                   ,  26.16000,  92.50, N'great britain'  , 0),
    ( 50, N'half crown'     , 1707, 1919, N'Silver'        , N'92.5% Silver, 7.5% Copper (sterling)'                   ,  13.08000,  92.50, N'great britain'  , 0),
    ( 51, N'florin'         , 1849, 1919, N'Silver'        , N'92.5% Silver, 7.5% Copper (sterling)'                   ,  10.46000,  92.50, N'great britain'  , 0),
    ( 52, N'shilling'       , 1707, 1919, N'Silver'        , N'92.5% Silver, 7.5% Copper (sterling)'                   ,   5.23000,  92.50, N'great britain'  , 0),
    ( 53, N'crown'          , 1920, 1946, N'Silver'        , N'50% Silver, 40% Copper, 10% Nickel'                     ,  14.14000,  50.00, N'great britain'  , 0),
    ( 54, N'half crown'     , 1920, 1946, N'Silver'        , N'50% Silver, 40% Copper, 10% Nickel'                     ,   7.07000,  50.00, N'great britain'  , 0),
    ( 55, N'florin'         , 1920, 1946, N'Silver'        , N'50% Silver, 40% Copper, 10% Nickel'                     ,   5.66000,  50.00, N'great britain'  , 0),
    ( 56, N'shilling'       , 1920, 1946, N'Silver'        , N'50% Silver, 40% Copper, 10% Nickel'                     ,   2.83000,  50.00, N'great britain'  , 0),
    ( 57, N'crown'          , 1947, 2100, N'Copper-Nickel' , N'75% Copper, 25% Nickel'                                 ,      NULL,   NULL, N'great britain'  , 0),
    ( 58, N'half crown'     , 1947, 1970, N'Copper-Nickel' , N'75% Copper, 25% Nickel'                                 ,      NULL,   NULL, N'great britain'  , 0),
    ( 59, N'florin'         , 1947, 1970, N'Copper-Nickel' , N'75% Copper, 25% Nickel'                                 ,      NULL,   NULL, N'great britain'  , 0),
    ( 60, N'shilling'       , 1947, 1970, N'Copper-Nickel' , N'75% Copper, 25% Nickel'                                 ,      NULL,   NULL, N'great britain'  , 0),
    ( 61, N'100 soles'      , 1950, 1970, N'Gold'          , N'90% Gold, 10% Copper'                                   ,  42.13000,  90.00, N'peru'           , 0),
    ( 62, N'50 soles'       , 1950, 1970, N'Gold'          , N'90% Gold, 10% Copper'                                   ,  21.06000,  90.00, N'peru'           , 0),
    ( 63, N'20 soles'       , 1950, 1970, N'Gold'          , N'90% Gold, 10% Copper'                                   ,   8.43000,  90.00, N'peru'           , 0),
    ( 64, N'10 soles'       , 1950, 1970, N'Gold'          , N'90% Gold, 10% Copper'                                   ,   4.21000,  90.00, N'peru'           , 0),
    ( 65, N'5 soles'        , 1950, 1970, N'Gold'          , N'90% Gold, 10% Copper'                                   ,   2.11000,  90.00, N'peru'           , 0);
GO

DECLARE @RefRows INT = (SELECT COUNT(*) FROM #PmReference);
PRINT 'Migration 007: loaded ' + CAST(@RefRows AS NVARCHAR(10))
    + ' alloy entries transcribed from pm-reference.ts.';
IF @RefRows = 0
    PRINT 'Migration 007: WARNING - no reference entries loaded. Nothing can be inferred.';
GO

-- ============================================================
-- STEP 3: decide, for every coin, what (if anything) to write
-- ============================================================
-- This is the whole brain of the migration. It writes NOTHING -- it only works
-- out, row by row, what the evidence supports. STEP 5 shows you the result,
-- STEP 7 applies it, STEP 9 reports on it, all from this one table.
--
-- That split is borrowed from pm-backfill.ts, which separates `planPmBackfill`
-- (pure: returns what WOULD happen) from `runPmBackfill` (writes exactly
-- that). It is what makes the preview honest: the numbers you approve in
-- STEP 5 are not a separate estimate that might disagree with the update --
-- they are literally the rows the update then applies.
--
-- EVERY coin lands in this table, including the ones nothing will be written
-- for, so that "what did it skip, and why?" is answerable from the same place
-- as "what did it fill in?".
--
-- ------------------------------------------------------------
-- THE FOUR WAYS A COIN CAN BE RESOLVED, IN ORDER
-- ------------------------------------------------------------
-- R1  REFERENCE MATCH. The denomination, country and year (plus a metal hint,
--     if we have one) select exactly one entry in #PmReference. This gives all
--     four values and is the only rule that can produce a composition, a gram
--     weight or a percentage. Everything below it yields a metal and nothing
--     else.
--
-- R2  CONTRADICTION. The lookup found nothing WITH the hint but would have
--     found something WITHOUT it. That means the metal implied by this row
--     disagrees with what the reference table says the coin is made of -- a
--     "Silver Dollars" category on a 1979 Susan B. Anthony, say, which is
--     copper-nickel clad. Nothing is written, and the row is counted so the
--     owner can look at it. Deliberately ABOVE R3 and R4, so a contradicted
--     hint can never go on to be used as an answer.
--
-- R3  UNIFORM METAL FOR THE DENOMINATION. Every reference entry that exists
--     for this denomination names the SAME metal, so the year cannot change
--     the answer and we do not need one. This is what makes "$20 is gold" work
--     on a coin whose year is missing or unreadable.
--
--     Note this rule is DERIVED FROM THE DATA, not asserted by hand: it holds
--     for $2.50, $3, $5, $10, $20 and the Peruvian Soles (all Gold), for 3CS
--     and 20c (all Silver), for 3CN (Copper-Nickel), 2c (Bronze), the half
--     cent (Copper) and the Sovereign (Gold) -- and it correctly does NOT hold
--     for $1, 1c, 5c, 10c, 25c or 50c, every one of which changed metal at
--     some point. Nobody had to list those exceptions; the data knows.
--
-- R4  METAL ONLY, FROM THE HINT. The reference table has NO entry for this
--     denomination at all -- an American Silver Eagle, a Krugerrand, a British
--     farthing -- so it cannot help, but something on the row names a metal
--     outright. Write just the metal.
--
--     The "no entry at all" condition is doing real work. Where the table DOES
--     cover a denomination but declines for a particular year, that decline is
--     deliberate (the 1942 nickel, the 1982 cent, the 1971-78 Eisenhower
--     dollar), and this rule must not talk over it. Requiring the denomination
--     to be entirely unknown is what guarantees it cannot.
--
-- Anything that reaches the bottom is left alone, and its row records why.
--
-- ------------------------------------------------------------
-- WHERE THE HINT COMES FROM
-- ------------------------------------------------------------
-- The hint ladder is the `hint` OUTER APPLY below: a table of rules, each
-- carrying a priority, the metal it concludes, a description of the evidence,
-- and the condition under which it fires. The lowest-numbered match wins.
-- Written this way, the ladder reads top-down exactly as it behaves, every
-- rule sits next to its own explanation, and "what evidence classified this
-- coin?" becomes a column rather than something to reconstruct later.
--
--    10        the metal already recorded on the coin (the owner's own word)
--    20- 79    composition text
--   100-149    a metal named outright in the coin type or denomination
--   150-199    a design name that only ever existed in one metal
--   200-249    the category
--
-- A hint is EVIDENCE, not an answer. It narrows the reference lookup, and the
-- reference table remains free to refuse -- which is exactly what keeps a
-- "Silver Dollars" category from turning an Eisenhower dollar into silver.

SELECT
    c.CoinId,
    PriorMetal       = c.MetalContent,
    PriorComposition = c.Composition,
    PriorPmWeight    = c.PmWeightGrams,
    PriorPmPercent   = c.PmPercent,
    CoinYear         = c.Year,
    c.Denomination,
    c.CoinType,
    c.Category,
    c.Country,
    DenomKey         = k.DenomKey,
    YearNum          = y.YearNum,
    HintMetal        = hint.Metal,
    HintEvidence     = hint.Evidence,
    Outcome          = o.Outcome,
    Evidence         = o.Evidence,
    InferredMetal       = o.Metal,
    InferredComposition = o.Composition,
    InferredPmWeight    = o.PmWeightGrams,
    InferredPmPercent   = o.PmPercent,
    w.MetalIsBlank, w.CompIsBlank, w.PmWeightIsBlank, w.PmPercentIsBlank,
    -- The four values STEP 7 will actually write. NULL means "leave that
    -- column exactly as it is".
    WriteMetal      = CASE WHEN w.MetalIsBlank     = 1 THEN o.Metal         END,
    WriteComp       = CASE WHEN w.CompIsBlank      = 1 THEN o.Composition   END,
    WritePmWeight   = CASE WHEN w.PmWeightIsBlank  = 1 THEN o.PmWeightGrams END,
    WritePmPercent  = CASE WHEN w.PmPercentIsBlank = 1 THEN o.PmPercent     END,
    FieldsToWrite   = CASE WHEN w.MetalIsBlank     = 1 AND o.Metal         IS NOT NULL THEN 1 ELSE 0 END
                    + CASE WHEN w.CompIsBlank      = 1 AND o.Composition   IS NOT NULL THEN 1 ELSE 0 END
                    + CASE WHEN w.PmWeightIsBlank  = 1 AND o.PmWeightGrams IS NOT NULL THEN 1 ELSE 0 END
                    + CASE WHEN w.PmPercentIsBlank = 1 AND o.PmPercent     IS NOT NULL THEN 1 ELSE 0 END
INTO #CoinPlan
FROM Coins AS c

/* ---- normalised text --------------------------------------------------
 * Everything downstream reads these instead of the raw columns, so the
 * trimming and lower-casing happens once and cannot be remembered in one rule
 * and forgotten in another.
 *
 * DescrPadded is the coin's own DESCRIPTION: coin type, denomination, variety.
 * Category is NOT in it, and that omission is deliberate -- the category is
 * the owner's filing decision, not a statement about the object, and it is
 * handled separately and later.
 *
 * The REPLACEs turn ',' '.' '-' and '/' into spaces, and the result is wrapped
 * in a leading and trailing space. That gives a poor-man word boundary:
 * searching for ' gold ' matches "Gold Eagle", "1849-O $1 Gold." and
 * "G$1, gold" but not "Goldberg" (the auction house), which a bare
 * CHARINDEX(N'gold', ...) would happily match. The cost is that hyphenated
 * names must be searched in their de-hyphenated form: ' saint gaudens ', not
 * ' saint-gaudens '.
 */
CROSS APPLY (
    SELECT
        CompTrim     = LTRIM(RTRIM(COALESCE(c.Composition, N''))),
        CompLower    = LOWER(LTRIM(RTRIM(COALESCE(c.Composition, N'')))),
        CatLower     = LOWER(LTRIM(RTRIM(COALESCE(c.Category, N'')))),
        DenRaw       = LTRIM(RTRIM(COALESCE(c.Denomination, N''))),
        CountryLower = LOWER(LTRIM(RTRIM(COALESCE(c.Country, N'')))),
        DescrFlat    = N' ' + REPLACE(REPLACE(REPLACE(REPLACE(
                           LOWER(COALESCE(c.CoinType, N'') + N' '
                               + COALESCE(c.Denomination, N'') + N' '
                               + COALESCE(c.Variety, N'')),
                           N',', N' '), N'.', N' '), N'-', N' '), N'/', N' ') + N' '
) AS t

/* ---- THE "CAC GOLD" TRAP ----------------------------------------------
 * *** THIS IS NOT A METAL. *** "CAC Gold" (or "Gold CAC") is the top sticker
 * tier awarded by Certified Acceptance Corporation, and it sits on SILVER
 * coins all the time:
 *
 *     "1875 20c - PCGS XF40 CAC Gold"   <- a 90% SILVER twenty-cent piece
 *
 * Read naively, the word "Gold" in that string would classify a silver coin
 * as gold and then hand it a gold hint, which is about as bad as this script
 * can get things. So the phrase is rewritten to plain "cac" before any metal
 * word is looked for.
 *
 * This is belt and braces rather than the only defence: the Quicken importer's
 * `detectMetalHint` already scrubs it, and so does `scrubCacGoldSticker` in
 * src/app/services/metal-inference.ts. It is repeated here because CoinType
 * and Variety are free text and nothing stops the phrase being pasted in.
 * Credit where due -- this trap was found and documented by metal-inference.ts,
 * not by this file.
 *
 * The scrub runs AFTER the punctuation fold above, so "CAC-Gold" has already
 * become "cac gold" by the time it is matched.
 */
CROSS APPLY (
    SELECT DescrPadded = REPLACE(REPLACE(t.DescrFlat,
                             N' cac gold ', N' cac '),
                             N' gold cac ', N' cac ')
) AS t2

/* ---- denomination, reduced to an ASCII key ----------------------------
 * The seeded denominations contain three characters that are not ASCII: the
 * cent sign (U+00A2), the vulgar one-half (U+00BD) and the pound sign
 * (U+00A3). Writing them literally into this file would make the script's
 * correctness depend on sqlcmd reading the file in the right code page, which
 * is a miserable thing to have to debug. NCHAR() names them by code point
 * instead, so THE FILE ITSELF STAYS PURE ASCII and cannot be mangled in
 * transit.
 *
 * STEP 2's DenomKey column was folded by exactly these rules, so the two sides
 * meet in the middle. Folding also has a happy side effect: the hand-typed
 * forms match too.
 *       '10' + cent sign    -> '10c'              (so a typed "10c" works)
 *       half + cent sign    -> 'halfc'
 *       half + ' Sovereign' -> 'half sovereign'
 */
CROSS APPLY (
    SELECT DenomNorm = LOWER(REPLACE(REPLACE(REPLACE(
                           t.DenRaw, NCHAR(162), N'c'), NCHAR(189), N'half'), NCHAR(163), N'gbp'))
) AS k0

/* ---- denomination aliases ---------------------------------------------
 * The coin editor's dropdown produces the canonical forms, but the CSV
 * importer accepts free text and older rows were typed by hand, so the
 * spelled-out names are folded onto the same keys. Anything not listed falls
 * through unchanged; it then matches no reference entry, which is the safe
 * outcome rather than a wrong one.
 *
 * "Penny" is deliberately NOT mapped. It means the US cent to an American and
 * the British penny to everyone else, and their alloys part company in 1943
 * (zinc-coated steel in Philadelphia, still bronze in London). A coin labelled
 * only "Penny" is therefore left alone.
 *
 * "Eagle" on its own is deliberately NOT mapped either. A Gold Eagle, a Silver
 * Eagle and the classic $10 Eagle are three different coins in three different
 * metals; the specific forms below are safe, the bare word is not.
 */
CROSS APPLY (
    SELECT DenomKey = CASE k0.DenomNorm
        -- United States, spelled out
        WHEN N'cent'               THEN N'1c'
        WHEN N'one cent'           THEN N'1c'
        WHEN N'large cent'         THEN N'1c'
        WHEN N'half cent'          THEN N'halfc'
        WHEN N'two cent'           THEN N'2c'
        WHEN N'two cents'          THEN N'2c'
        WHEN N'three cent silver'  THEN N'3cs'
        WHEN N'trime'              THEN N'3cs'
        WHEN N'three cent nickel'  THEN N'3cn'
        WHEN N'nickel'             THEN N'5c'
        WHEN N'five cents'         THEN N'5c'
        WHEN N'half dime'          THEN N'5c'
        WHEN N'dime'               THEN N'10c'
        WHEN N'ten cents'          THEN N'10c'
        WHEN N'twenty cent'        THEN N'20c'
        WHEN N'twenty cents'       THEN N'20c'
        WHEN N'quarter'            THEN N'25c'
        WHEN N'quarter dollar'     THEN N'25c'
        WHEN N'half dollar'        THEN N'50c'
        WHEN N'fifty cents'        THEN N'50c'
        WHEN N'dollar'             THEN N'$1'
        WHEN N'one dollar'         THEN N'$1'
        WHEN N'silver dollar'      THEN N'$1'
        WHEN N'trade dollar'       THEN N'$1'
        WHEN N'quarter eagle'      THEN N'$2.50'
        WHEN N'three dollar'       THEN N'$3'
        WHEN N'half eagle'         THEN N'$5'
        WHEN N'double eagle'       THEN N'$20'
        -- Great Britain
        WHEN N'1/-'                THEN N'shilling'
        WHEN N'2/- (florin)'       THEN N'florin'
        WHEN N'2/6 (half crown)'   THEN N'half crown'
        WHEN N'5/- (crown)'        THEN N'crown'
        WHEN N'halfcrown'          THEN N'half crown'
        ELSE k0.DenomNorm
    END
) AS k

/* ---- the year, as a number we are willing to rely on -------------------
 * Year is NVARCHAR(50) and holds whatever anybody typed: '1878', '1878-S',
 * '1862/1' (an overdate), '1776-1976' (the Bicentennial), 'n.d.', or nothing
 * at all. Nearly every reference entry turns on the year, so misreading it
 * would be worse than having no rules.
 *
 * TWO FOUR-DIGIT RUNS MEANS WE DO NOT HAVE A YEAR. This is the subtle one. A
 * Bicentennial half dollar is dated '1776-1976'. Reading its "leading year"
 * gives 1776, which sits comfortably inside the 90%-silver window, so a naive
 * parse would classify a copper-nickel clad Bicentennial half as SILVER, with
 * 11.25 g of silver in it. Rather than special-case that one coin, any Year
 * containing two separate four-digit runs is treated as having no single
 * definite year, and the coin is left for a human. '1878-S' and '1862/1' are
 * unaffected -- neither contains a second four-digit run.
 *
 * (pm-reference.ts's own `parseLeadingYear` does take the leading year of a
 * range. This script is deliberately stricter, because it is writing to the
 * database unattended rather than pre-filling a form the user is looking at.)
 *
 * The 1600-2100 clamp discards typos and four-digit numbers that are not years.
 */
CROSS APPLY (
    SELECT YearRaw = LTRIM(RTRIM(COALESCE(c.Year, N'')))
) AS y0
CROSS APPLY (
    SELECT
        IsRanged    = CASE WHEN PATINDEX(N'%[0-9][0-9][0-9][0-9]%[0-9][0-9][0-9][0-9]%', y0.YearRaw) > 0
                           THEN 1 ELSE 0 END,
        LeadingYear = CASE WHEN LEFT(y0.YearRaw, 4) LIKE N'[0-9][0-9][0-9][0-9]'
                           THEN TRY_CONVERT(INT, LEFT(y0.YearRaw, 4)) END
) AS y1
CROSS APPLY (
    SELECT YearNum = CASE WHEN y1.IsRanged = 0 AND y1.LeadingYear BETWEEN 1600 AND 2100
                          THEN y1.LeadingYear END
) AS y

/* ---- country, mapped onto the three nations the reference table knows --
 * The database is inconsistent here and always has been: the coin editor
 * writes 'United States' while the seeded Denominations rows use 'US' and
 * 'GB'. (There is a whole comment about that mismatch in
 * components/coin-editor-form/denomination-countries.ts.) Both spellings are
 * accepted.
 *
 * A BLANK or unrecognised country becomes NULL, which the lookups below treat
 * as "match any country". That is safe here because no denomination key is
 * claimed by two nations: the US keys are '25c', '$20' and friends, the GB
 * keys are 'florin', 'crown', 'sovereign', and Peru's are the Soles. The two
 * sets do not intersect, so a blank country cannot pull in the wrong entry.
 */
CROSS APPLY (
    SELECT Nation = CASE
        WHEN t.CountryLower IN (N'us', N'usa', N'u.s.', N'u.s.a.', N'united states',
                                N'united states of america', N'america') THEN N'united states'
        WHEN t.CountryLower IN (N'gb', N'uk', N'g.b.', N'u.k.', N'great britain',
                                N'united kingdom', N'britain', N'england') THEN N'great britain'
        WHEN t.CountryLower = N'peru' THEN N'peru'
    END
) AS nat

/* ---- layer 1 of the composition reader: the exact lookup ---------------
 * Matches the coin's composition text against the 22 distinct strings
 * pm-reference.ts can produce, and recovers the metal that file assigns to it.
 * This is a JOIN back onto the transcribed table rather than a second list, so
 * it cannot disagree with STEP 2, and the parity spec covers both at once.
 *
 * Every one of the hard cases described in the header is simply LOOKED UP
 * here rather than reasoned about: the war nickel's '56% Copper, 35% Silver...'
 * comes back Silver, 'Copper-Nickel clad (...)' comes back Clad, and
 * 'Copper-plated zinc (...)' comes back Zinc. No positional rule required.
 */
OUTER APPLY (
    SELECT TOP (1) pr.Metal
    FROM #PmReference AS pr
    WHERE t.CompTrim <> N''
      AND pr.Composition = t.CompTrim
    ORDER BY pr.EntryOrder
) AS cmap

/* ---- layer 2 of the composition reader: where each metal word appears --
 * Only reached for composition text the exact lookup did not recognise, i.e.
 * something typed by hand or imported from CSV. CHARINDEX returns 0 for "not
 * present"; NULLIF turns that into NULL so MIN() below ignores it.
 *
 * 'tin' is deliberately absent from this list: it is a substring of
 * "pla-tin-um" and of "plating", so searching for it directly would be a bug.
 * Bronze is detected from the phrase 'tin and' instead.
 */
CROSS APPLY (
    SELECT
        pGold      = NULLIF(CHARINDEX(N'gold',      t.CompLower), 0),
        pSilver    = NULLIF(CHARINDEX(N'silver',    t.CompLower), 0),
        pPlatinum  = NULLIF(CHARINDEX(N'platinum',  t.CompLower), 0),
        pPalladium = NULLIF(CHARINDEX(N'palladium', t.CompLower), 0),
        pCopper    = NULLIF(CHARINDEX(N'copper',    t.CompLower), 0),
        pNickel    = NULLIF(CHARINDEX(N'nickel',    t.CompLower), 0),
        pZinc      = NULLIF(CHARINDEX(N'zinc',      t.CompLower), 0),
        pSteel     = NULLIF(CHARINDEX(N'steel',     t.CompLower), 0),
        pBrass     = NULLIF(CHARINDEX(N'brass',     t.CompLower), 0),
        pAluminum  = NULLIF(CHARINDEX(N'alumin',    t.CompLower), 0)
) AS cp
CROSS APPLY (
    SELECT FirstMetalPos = (
        SELECT MIN(v) FROM (VALUES
            (cp.pGold), (cp.pSilver), (cp.pPlatinum), (cp.pPalladium), (cp.pCopper),
            (cp.pNickel), (cp.pZinc), (cp.pSteel), (cp.pBrass), (cp.pAluminum)
        ) AS positions(v))
) AS cf

/* ---- the metal already on the coin, canonicalised ---------------------
 * The stored MetalContent is used as a hint, so it has to match a #PmReference
 * Metal value EXACTLY or the lookup will find nothing and the coin will be
 * reported as a self-contradiction. A hand-typed "cupronickel" is not a
 * disagreement with the reference table; it is the same answer spelled
 * differently. The aliases below are the same ones `canonicalMetal` accepts in
 * src/app/services/metal-inference.ts.
 *
 * *** 'Other' IS MAPPED TO NO HINT AT ALL, AND THIS MATTERS A LOT HERE. ***
 * 'Other' is a placeholder meaning "not classified", not a claim about the
 * coin -- and setup-database.sql's own legacy backfill block sets a great many
 * rows to it. Treating it as a hint would filter the reference lookup down to
 * entries whose metal is literally 'Other' (there are none), the lookup would
 * fail, and every one of those coins would then be reported as "conflict"
 * instead of being resolved. Ignoring it is what lets those rows be fixed.
 * Note the coin KEEPS its 'Other' -- the column is not blank, so nothing
 * overwrites it -- but it can still gain a composition and a weight.
 *
 * Anything unrecognised also becomes no hint rather than a bad one.
 */
CROSS APPLY (
    SELECT StoredMetal = CASE LOWER(LTRIM(RTRIM(COALESCE(c.MetalContent, N''))))
        WHEN N'gold'          THEN N'Gold'
        WHEN N'silver'        THEN N'Silver'
        WHEN N'platinum'      THEN N'Platinum'
        WHEN N'palladium'     THEN N'Palladium'
        WHEN N'copper'        THEN N'Copper'
        WHEN N'nickel'        THEN N'Nickel'
        WHEN N'copper-nickel' THEN N'Copper-Nickel'
        WHEN N'bronze'        THEN N'Bronze'
        WHEN N'brass'         THEN N'Brass'
        WHEN N'zinc'          THEN N'Zinc'
        WHEN N'steel'         THEN N'Steel'
        WHEN N'aluminum'      THEN N'Aluminum'
        WHEN N'nickel-brass'  THEN N'Nickel-Brass'
        WHEN N'clad'          THEN N'Clad'
        -- spellings the dropdown does not use but a human might type
        WHEN N'cupronickel'   THEN N'Copper-Nickel'
        WHEN N'cupro-nickel'  THEN N'Copper-Nickel'
        WHEN N'copper nickel' THEN N'Copper-Nickel'
        WHEN N'copper-nickle' THEN N'Copper-Nickel'
        WHEN N'nickel brass'  THEN N'Nickel-Brass'
        WHEN N'aluminium'     THEN N'Aluminum'
        -- 'other', '' and anything unrecognised fall through to NULL
        ELSE NULL
    END
) AS sm

/* ---- THE HINT LADDER --------------------------------------------------
 * One row per rule: priority, the metal it concludes, a description of the
 * evidence (which ends up in the preview and the summary), and the condition.
 * Lowest priority number wins. Gaps in the numbering are intentional, so a
 * rule can be slipped between two others without renumbering anything.
 *
 * Remember what a hint IS: evidence that narrows the reference lookup. It is
 * not, by itself, an answer. The reference table stays free to refuse, and
 * that is what stops a "Silver Dollars" category from turning an Eisenhower
 * dollar into silver.
 */
OUTER APPLY (
    SELECT TOP (1) h.Metal, h.Evidence
    FROM (VALUES
        /* --- 10: the owner's own word ----------------------------------
         * A metal already in the column outranks everything this script can
         * work out, so it is consulted first. (It will not be WRITTEN -- the
         * column is not blank -- but it tells the lookup which of two
         * same-denomination entries to pick, which is how a coin whose metal
         * was typed in by hand still gains a composition and a weight.) */
        ( 10, CAST(sm.StoredMetal AS NVARCHAR(50)),
              CAST(N'Metal already recorded on the coin' AS NVARCHAR(80)),
              CASE WHEN sm.StoredMetal IS NOT NULL THEN 1 ELSE 0 END),

        /* --- 20: composition, exact match ------------------------------ */
        ( 20, cmap.Metal, N'Composition (exact alloy match)',
              CASE WHEN cmap.Metal IS NOT NULL THEN 1 ELSE 0 END),

        /* --- 30-79: composition, free text -----------------------------
         * Order matters enormously here. See the long trap note in the file
         * header; these rules exist only for text the exact lookup missed.
         *
         * 30  The wartime nickel alloy, FIRST, because it is the one string
         *     where both "first metal named" and "largest share" answer
         *     Copper and both are wrong.
         * 40-43  The positional rule: whichever precious metal is named
         *     EARLIEST wins. Correct for '90% Gold, 10% Copper' and also for
         *     '40% Silver clad (...)', where silver is named first despite
         *     being only 40% by mass.
         * 50+ The alloys with names of their own, most specific first:
         *     nickel-brass before brass, steel before zinc (because
         *     'Zinc-coated steel' contains both), plated-zinc before bronze. */
        ( 30, N'Silver', N'Composition (wartime silver alloy)',
              CASE WHEN CHARINDEX(N'wartime', t.CompLower) > 0
                     OR (CHARINDEX(N'manganese', t.CompLower) > 0
                         AND CHARINDEX(N'silver', t.CompLower) > 0
                         AND CHARINDEX(N'brass', t.CompLower) = 0)
                   THEN 1 ELSE 0 END),
        ( 40, N'Gold',      N'Composition (first metal named)',
              CASE WHEN cp.pGold      IS NOT NULL AND cp.pGold      = cf.FirstMetalPos THEN 1 ELSE 0 END),
        ( 41, N'Silver',    N'Composition (first metal named)',
              CASE WHEN cp.pSilver    IS NOT NULL AND cp.pSilver    = cf.FirstMetalPos THEN 1 ELSE 0 END),
        ( 42, N'Platinum',  N'Composition (first metal named)',
              CASE WHEN cp.pPlatinum  IS NOT NULL AND cp.pPlatinum  = cf.FirstMetalPos THEN 1 ELSE 0 END),
        ( 43, N'Palladium', N'Composition (first metal named)',
              CASE WHEN cp.pPalladium IS NOT NULL AND cp.pPalladium = cf.FirstMetalPos THEN 1 ELSE 0 END),
        ( 50, N'Clad', N'Composition (named alloy)',
              CASE WHEN CHARINDEX(N'clad', t.CompLower) > 0 THEN 1 ELSE 0 END),
        ( 52, N'Nickel-Brass', N'Composition (named alloy)',
              CASE WHEN CHARINDEX(N'nickel-brass', t.CompLower) > 0
                     OR CHARINDEX(N'nickel brass', t.CompLower) > 0 THEN 1 ELSE 0 END),
        ( 54, N'Brass', N'Composition (named alloy)',
              CASE WHEN cp.pBrass IS NOT NULL THEN 1 ELSE 0 END),
        ( 56, N'Steel', N'Composition (named alloy)',
              CASE WHEN cp.pSteel IS NOT NULL THEN 1 ELSE 0 END),
        ( 58, N'Zinc', N'Composition (named alloy)',
              CASE WHEN CHARINDEX(N'plated zinc', t.CompLower) > 0 THEN 1 ELSE 0 END),
        ( 60, N'Bronze', N'Composition (named alloy)',
              CASE WHEN CHARINDEX(N'bronze', t.CompLower) > 0
                     OR (cp.pCopper IS NOT NULL AND CHARINDEX(N'tin and', t.CompLower) > 0)
                     OR (cp.pCopper IS NOT NULL AND cp.pZinc IS NOT NULL
                         AND cp.pNickel IS NULL) THEN 1 ELSE 0 END),
        ( 62, N'Copper-Nickel', N'Composition (named alloy)',
              CASE WHEN CHARINDEX(N'copper-nickel', t.CompLower) > 0
                     OR CHARINDEX(N'cupronickel',   t.CompLower) > 0
                     OR CHARINDEX(N'cupro-nickel',  t.CompLower) > 0
                     OR (cp.pCopper IS NOT NULL AND cp.pNickel IS NOT NULL)
                   THEN 1 ELSE 0 END),
        ( 64, N'Copper',   N'Composition (named alloy)', CASE WHEN cp.pCopper   IS NOT NULL THEN 1 ELSE 0 END),
        ( 66, N'Nickel',   N'Composition (named alloy)', CASE WHEN cp.pNickel   IS NOT NULL THEN 1 ELSE 0 END),
        ( 68, N'Zinc',     N'Composition (named alloy)', CASE WHEN cp.pZinc     IS NOT NULL THEN 1 ELSE 0 END),
        ( 70, N'Aluminum', N'Composition (named alloy)', CASE WHEN cp.pAluminum IS NOT NULL THEN 1 ELSE 0 END),

        /* --- 100-149: a metal named outright in the coin's description --
         * The word-boundary padding described above is what keeps this from
         * matching "Goldberg". It reads CoinType, Denomination and Variety --
         * never Notes, which is free prose and far too loose, and never
         * Category, which is handled separately and much lower down. */
        (100, N'Gold',      N'Coin type or denomination names the metal',
              CASE WHEN CHARINDEX(N' gold ',      t2.DescrPadded) > 0 THEN 1 ELSE 0 END),
        (102, N'Silver',    N'Coin type or denomination names the metal',
              CASE WHEN CHARINDEX(N' silver ',    t2.DescrPadded) > 0 THEN 1 ELSE 0 END),
        (104, N'Platinum',  N'Coin type or denomination names the metal',
              CASE WHEN CHARINDEX(N' platinum ',  t2.DescrPadded) > 0 THEN 1 ELSE 0 END),
        (106, N'Palladium', N'Coin type or denomination names the metal',
              CASE WHEN CHARINDEX(N' palladium ', t2.DescrPadded) > 0 THEN 1 ELSE 0 END),

        /* --- 150-199: designs and series that only ever existed in one metal
         * Every name here is checked against the whole series, not one issue.
         *
         * GOLD: the Double / Half / Quarter Eagle are the $20, $5 and $2.50;
         * Saint-Gaudens designed only the $20 and the $10; the Indian Princess
         * is the gold dollar and the $3; the Sovereign, the Guinea and the
         * Krugerrand are gold by definition.
         *
         * SILVER: Morgan, Peace and Trade are dollars; Barber struck the dime,
         * quarter and half; Mercury the dime; Walking Liberty the half;
         * Standing Liberty the quarter; Franklin the half; Liberty Seated the
         * whole subsidiary silver range -- every one of them 90% silver and
         * nothing else. Maundy money has been sterling since the 17th century.
         *
         * COPPER-NICKEL: the Buffalo and Shield nickels and the Flying Eagle
         * cent. "Gold Buffalo" (the 24-carat bullion coin) is caught by rule
         * 100 above, which runs first, so it is not mistaken for a nickel.
         *
         * NOT LISTED, on purpose: Indian Head (a bronze cent AND a $5 and $10
         * gold piece), Liberty Head (a nickel AND four gold denominations),
         * Coronet (a large cent AND the classic gold series), Draped Bust,
         * Capped Bust, Classic Head, Braided Hair and Flowing Hair (all used
         * across both copper and silver), and Lincoln / Jefferson / Roosevelt
         * / Washington / Kennedy / Eisenhower (all of which changed metal
         * part way through their run, which is the reference table's job to
         * sort out by year, not this ladder's). */
        (150, N'Gold', N'Coin type (a design or series struck only in gold)',
              CASE WHEN CHARINDEX(N' double eagle ',   t2.DescrPadded) > 0
                     OR CHARINDEX(N' half eagle ',     t2.DescrPadded) > 0
                     OR CHARINDEX(N' quarter eagle ',  t2.DescrPadded) > 0
                     OR CHARINDEX(N' saint gaudens ',  t2.DescrPadded) > 0
                     OR CHARINDEX(N' st gaudens ',     t2.DescrPadded) > 0
                     OR CHARINDEX(N' gaudens ',        t2.DescrPadded) > 0
                     OR CHARINDEX(N' indian princess ',t2.DescrPadded) > 0
                     OR CHARINDEX(N' sovereign ',      t2.DescrPadded) > 0
                     OR CHARINDEX(N' guinea ',         t2.DescrPadded) > 0
                     OR CHARINDEX(N' krugerrand ',     t2.DescrPadded) > 0
                   THEN 1 ELSE 0 END),
        (152, N'Silver', N'Coin type (a design or series struck only in silver)',
              CASE WHEN CHARINDEX(N' morgan ',           t2.DescrPadded) > 0
                     OR CHARINDEX(N' peace ',            t2.DescrPadded) > 0
                     OR CHARINDEX(N' trade dollar ',     t2.DescrPadded) > 0
                     OR CHARINDEX(N' barber ',           t2.DescrPadded) > 0
                     OR CHARINDEX(N' mercury ',          t2.DescrPadded) > 0
                     OR CHARINDEX(N' walking liberty ',  t2.DescrPadded) > 0
                     OR CHARINDEX(N' standing liberty ', t2.DescrPadded) > 0
                     OR CHARINDEX(N' franklin ',         t2.DescrPadded) > 0
                     OR CHARINDEX(N' liberty seated ',   t2.DescrPadded) > 0
                     OR CHARINDEX(N' seated liberty ',   t2.DescrPadded) > 0
                     OR CHARINDEX(N' maundy ',           t2.DescrPadded) > 0
                     OR CHARINDEX(N' trime ',            t2.DescrPadded) > 0
                   THEN 1 ELSE 0 END),
        (154, N'Copper-Nickel', N'Coin type (a design struck only in copper-nickel)',
              CASE WHEN CHARINDEX(N' buffalo ',      t2.DescrPadded) > 0
                     OR CHARINDEX(N' shield ',       t2.DescrPadded) > 0
                     OR CHARINDEX(N' flying eagle ', t2.DescrPadded) > 0
                   THEN 1 ELSE 0 END),

        /* --- 200-249: the category, last and weakest --------------------
         * The owner's filing, not a statement about the object: an Eisenhower
         * dollar can perfectly well sit in a category called "Silver Dollars"
         * while being copper-nickel clad. It is allowed to act as a hint --
         * the reference table arbitrates and will refuse where the category is
         * wrong -- but it is the last thing consulted and the outcome below
         * fences where it is allowed to stand on its own. */
        (200, N'Gold',      N'Category', CASE WHEN CHARINDEX(N'gold',      t.CatLower) > 0 THEN 1 ELSE 0 END),
        (202, N'Silver',    N'Category', CASE WHEN CHARINDEX(N'silver',    t.CatLower) > 0 THEN 1 ELSE 0 END),
        (204, N'Platinum',  N'Category', CASE WHEN CHARINDEX(N'platinum',  t.CatLower) > 0 THEN 1 ELSE 0 END),
        (206, N'Palladium', N'Category', CASE WHEN CHARINDEX(N'palladium', t.CatLower) > 0 THEN 1 ELSE 0 END)
    ) AS h(Priority, Metal, Evidence, Matches)
    WHERE h.Matches = 1
      AND h.Metal IS NOT NULL
      AND h.Metal <> N''
    ORDER BY h.Priority
) AS hint

/* ---- the reference lookup, WITH the hint applied -----------------------
 * This is `resolveEntry` from pm-reference.ts, rewritten in SQL. Steps 1-3 of
 * that function are the WHERE clause; step 4 -- the refusal -- is the
 * MetalCount test in `pick` below.
 *
 * Note how the hint is applied: WITH one, only entries in that metal survive,
 * which is what makes an 1849 "$1 Gold" resolve to the gold dollar and not the
 * silver dollar. WITHOUT one, the `requiresHint` entries stay hidden, so a
 * 1999 quarter resolves to the clad issue and not the silver proof.
 */
OUTER APPLY (
    SELECT MatchCount = COUNT(*), MetalCount = COUNT(DISTINCT pr.Metal), FirstEntry = MIN(pr.EntryOrder)
    FROM #PmReference AS pr
    WHERE pr.DenomKey = k.DenomKey
      AND y.YearNum IS NOT NULL
      AND (nat.Nation IS NULL OR pr.Country IS NULL OR pr.Country = nat.Nation)
      AND (   (hint.Metal IS NULL     AND pr.RequiresHint = 0)
           OR (hint.Metal IS NOT NULL AND pr.Metal = hint.Metal))
      AND pr.YearMin IS NOT NULL
      AND y.YearNum BETWEEN pr.YearMin AND pr.YearMax
) AS datedPool

/* Undated entries -- the British Sovereign, whose specification has not moved
 * since 1817 -- are a FALLBACK ONLY, used when no dated entry matched. Same
 * precedence as the TypeScript. */
OUTER APPLY (
    SELECT MatchCount = COUNT(*), MetalCount = COUNT(DISTINCT pr.Metal), FirstEntry = MIN(pr.EntryOrder)
    FROM #PmReference AS pr
    WHERE pr.DenomKey = k.DenomKey
      AND y.YearNum IS NOT NULL
      AND (nat.Nation IS NULL OR pr.Country IS NULL OR pr.Country = nat.Nation)
      AND (   (hint.Metal IS NULL     AND pr.RequiresHint = 0)
           OR (hint.Metal IS NOT NULL AND pr.Metal = hint.Metal))
      AND pr.YearMin IS NULL
) AS undatedPool

CROSS APPLY (
    SELECT
        ChosenEntry = CASE WHEN datedPool.MatchCount   > 0 THEN datedPool.FirstEntry
                           WHEN undatedPool.MatchCount > 0 THEN undatedPool.FirstEntry END,
        -- THE REFUSAL. If what survived names more than one metal, the
        -- year/denomination pair genuinely did not determine the alloy. This
        -- single comparison is what leaves the 1849-1889 "$1", the 1856-57
        -- cent and the 1866-73 five-cent piece alone.
        PoolMetals  = CASE WHEN datedPool.MatchCount   > 0 THEN datedPool.MetalCount
                           WHEN undatedPool.MatchCount > 0 THEN undatedPool.MetalCount
                           ELSE 0 END
) AS pick

OUTER APPLY (
    SELECT pr.Metal, pr.Composition, pr.PmWeightGrams, pr.PmPercent
    FROM #PmReference AS pr
    WHERE pick.PoolMetals = 1
      AND pr.EntryOrder = pick.ChosenEntry
) AS ref

/* ---- the same lookup, IGNORING the hint, purely to detect a contradiction
 * If this finds an answer and the hinted lookup did not, the metal implied by
 * the row disagrees with what the coin is actually made of. That is worth
 * surfacing rather than silently resolving either way: it is how a "Silver
 * Dollars" category sitting on a 1979 Susan B. Anthony gets reported instead
 * of quietly becoming either silver or clad.
 */
OUTER APPLY (
    SELECT MatchCount = COUNT(*), MetalCount = COUNT(DISTINCT pr.Metal)
    FROM #PmReference AS pr
    WHERE pr.DenomKey = k.DenomKey
      AND y.YearNum IS NOT NULL
      AND (nat.Nation IS NULL OR pr.Country IS NULL OR pr.Country = nat.Nation)
      AND pr.RequiresHint = 0
      AND pr.YearMin IS NOT NULL
      AND y.YearNum BETWEEN pr.YearMin AND pr.YearMax
) AS unhinted

/* ---- what the reference table knows about this DENOMINATION as a whole --
 * Two facts, both used by rule R3 and R4 in the outcome below:
 *   EntryCount  0 means the table has never heard of this denomination, which
 *               is the only situation in which a bare metal hint is allowed to
 *               stand on its own.
 *   MetalCount  1 means every issue of this denomination that the table knows
 *               about is the same metal, so the year cannot change the answer.
 */
OUTER APPLY (
    SELECT EntryCount = COUNT(*), MetalCount = COUNT(DISTINCT pr.Metal), OnlyMetal = MIN(pr.Metal)
    FROM #PmReference AS pr
    WHERE k.DenomKey <> N''
      AND pr.DenomKey = k.DenomKey
      AND (nat.Nation IS NULL OR pr.Country IS NULL OR pr.Country = nat.Nation)
) AS denom

/* ---- THE OUTCOME ------------------------------------------------------
 * R1 reference match -> all four values.
 * R2 contradiction   -> nothing, reported.
 * R3 uniform metal   -> metal only.
 * R4 hint alone      -> metal only, and only where the table has never heard
 *                       of the denomination.
 * otherwise          -> nothing, with a reason.
 *
 * *** A CATEGORY IS NEVER ALLOWED TO BE THE WHOLE ANSWER. ***
 * R4 explicitly excludes a hint that came from the Category, and that
 * exclusion is the one place this script defers to a judgement made elsewhere
 * in the project. src/app/services/metal-inference.ts -- which answers the
 * same "what metal is this?" question in TypeScript, and is unit tested --
 * refuses to read `category` AT ALL, on the grounds that:
 *
 *     "A coin filed under a 'Gold Coins' category is a statement about the
 *      owner's filing cabinet, not about the coin. Collections routinely
 *      contain a silver token or a copper medal in a gold folder."
 *
 * The owner's own example is the sharp one: an Eisenhower dollar sitting in a
 * category called "Silver Dollars" is usually copper-nickel clad.
 *
 * This script is slightly less strict, and deliberately so. It DOES let a
 * category act as a hint in R1, because there the reference table has to
 * corroborate it -- the category only chooses between entries that already
 * exist for that denomination and year, and where the category is wrong the
 * lookup finds nothing and R2 reports the disagreement. What it must never do
 * is supply a metal with nothing to check it against, which is exactly what
 * R4 would be. Hence the exclusion.
 *
 * Every row where a category did any work is labelled as such in the Evidence
 * column, so STEP 5's breakdown shows precisely how many coins leaned on one.
 */
CROSS APPLY (
    SELECT
        Outcome = CASE
            WHEN ref.Metal IS NOT NULL THEN N'Filled'
            WHEN hint.Metal IS NOT NULL AND unhinted.MatchCount > 0 AND unhinted.MetalCount = 1
                 THEN N'Skipped - conflict'
            WHEN denom.MetalCount = 1 AND denom.EntryCount > 0 THEN N'Filled'
            WHEN hint.Metal IS NOT NULL AND COALESCE(denom.EntryCount, 0) = 0
                 AND hint.Evidence <> N'Category'
                 THEN N'Filled'
            WHEN pick.PoolMetals > 1 THEN N'Skipped - two alloys share this date'
            WHEN k.DenomKey = N'' THEN N'Skipped - no denomination'
            WHEN y.YearNum IS NULL AND COALESCE(denom.EntryCount, 0) > 0
                 THEN N'Skipped - no single readable year'
            WHEN COALESCE(denom.EntryCount, 0) = 0 THEN N'Skipped - denomination not in the reference table'
            ELSE N'Skipped - the reference table has no entry for this year'
        END,
        Evidence = CASE
            WHEN ref.Metal IS NOT NULL AND hint.Metal IS NULL THEN N'Denomination + year'
            WHEN ref.Metal IS NOT NULL THEN N'Denomination + year, narrowed by: ' + hint.Evidence
            WHEN hint.Metal IS NOT NULL AND unhinted.MatchCount > 0 AND unhinted.MetalCount = 1
                 THEN N'Contradicted by the reference table'
            WHEN denom.MetalCount = 1 AND denom.EntryCount > 0
                 THEN N'Denomination alone (every known issue is the same metal)'
            WHEN hint.Metal IS NOT NULL AND COALESCE(denom.EntryCount, 0) = 0
                 AND hint.Evidence <> N'Category'
                 THEN N'Metal only, from: ' + hint.Evidence
            ELSE N'None'
        END,
        Metal = CASE
            WHEN ref.Metal IS NOT NULL THEN ref.Metal
            WHEN hint.Metal IS NOT NULL AND unhinted.MatchCount > 0 AND unhinted.MetalCount = 1 THEN NULL
            WHEN denom.MetalCount = 1 AND denom.EntryCount > 0 THEN denom.OnlyMetal
            WHEN hint.Metal IS NOT NULL AND COALESCE(denom.EntryCount, 0) = 0
                 AND hint.Evidence <> N'Category'
                 THEN hint.Metal
        END,
        -- Only a full reference match can produce these three. Nothing else
        -- knows the alloy, and nothing else is allowed to guess at it.
        Composition   = ref.Composition,
        PmWeightGrams = ref.PmWeightGrams,
        PmPercent     = ref.PmPercent
) AS o

/* ---- which cells are empty --------------------------------------------
 * For the two text columns, NULL and whitespace both count as empty.
 *
 * For the two NUMERIC columns, ONLY NULL counts as empty. A PmWeightGrams of
 * 0 is a number somebody or something put there; it is not an absence, and it
 * is left alone exactly as `isPmFieldBlank` in pm-fill.ts leaves it alone.
 * (Contrast spot PRICES, where this app does treat 0 as "no price" -- sound,
 * because gold does not trade at zero. A coin's precious-metal weight
 * genuinely can be zero, so that shortcut is not available here.)
 */
CROSS APPLY (
    SELECT
        MetalIsBlank     = CASE WHEN LTRIM(RTRIM(COALESCE(c.MetalContent, N''))) = N'' THEN 1 ELSE 0 END,
        CompIsBlank      = CASE WHEN LTRIM(RTRIM(COALESCE(c.Composition,  N''))) = N'' THEN 1 ELSE 0 END,
        PmWeightIsBlank  = CASE WHEN c.PmWeightGrams IS NULL THEN 1 ELSE 0 END,
        PmPercentIsBlank = CASE WHEN c.PmPercent     IS NULL THEN 1 ELSE 0 END
) AS w;
GO

CREATE INDEX IX_CoinPlan_Write ON #CoinPlan (FieldsToWrite);
GO

-- ============================================================
-- STEP 4: refuse to write a metal the editor cannot display
-- ============================================================
-- Coins.MetalContent is NVARCHAR(50) with no CHECK constraint, so the database
-- will cheerfully accept "Cupronickel" or "gold" -- and the coin editor, whose
-- Metal control is a <select> fed from the MetalContents lookup, would then
-- render a BLANK field for a coin that has a metal. That is a silent,
-- confusing failure, so it is caught here instead.
--
-- The fifteen values below are the exact list setup-database.sql seeds. They
-- are written out rather than only read from MetalContents so the check still
-- works on a database where that table is missing; where it IS present, both
-- are checked and a disagreement between them is reported too.
--
-- If anything fails here, #Abort is created and STEP 7 declines to run. A
-- #temp table is used rather than a variable precisely because it survives
-- the GO between the two batches.

IF OBJECT_ID('tempdb..#Abort') IS NOT NULL DROP TABLE #Abort;
GO

DECLARE @Seeded TABLE (MetalContentName NVARCHAR(50) PRIMARY KEY);
INSERT INTO @Seeded (MetalContentName) VALUES
    (N'Gold'), (N'Silver'), (N'Platinum'), (N'Palladium'), (N'Copper'),
    (N'Nickel'), (N'Copper-Nickel'), (N'Bronze'), (N'Brass'), (N'Zinc'),
    (N'Steel'), (N'Aluminum'), (N'Nickel-Brass'), (N'Clad'), (N'Other');

DECLARE @Unknown NVARCHAR(MAX) = NULL;

SELECT @Unknown = COALESCE(@Unknown + N', ', N'') + x.WriteMetal
FROM (SELECT DISTINCT p.WriteMetal
      FROM #CoinPlan AS p
      WHERE p.WriteMetal IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM @Seeded AS s WHERE s.MetalContentName = p.WriteMetal)) AS x;

IF @Unknown IS NOT NULL
BEGIN
    SELECT 1 AS Aborted INTO #Abort;
    PRINT '';
    PRINT '*********************************************************************';
    PRINT '*** Migration 007: STOPPED - would write a metal that is not in   ***';
    PRINT '***                the seeded MetalContents list                  ***';
    PRINT '*********************************************************************';
    PRINT 'Offending value(s): ' + @Unknown;
    PRINT 'Nothing has been written. Fix the rule that produced this and re-run.';
    PRINT '';
END
ELSE
BEGIN
    PRINT 'Migration 007: every metal this script would write is in the seeded list.';
END

-- Advisory only: the file and the table should agree about the fifteen values.
--
-- WHY THIS GOES THROUGH sp_executesql. The batch is compiled as a whole before
-- any of it runs, and a column or table named in a SELECT is resolved at
-- COMPILE time. Writing
--
--     IF OBJECT_ID('MetalContents','U') IS NOT NULL
--         AND EXISTS (SELECT ... FROM MetalContents)
--
-- would fail with "Msg 208: Invalid object name 'MetalContents'" on a database
-- that does not have the table -- the IF would correctly be false, but the
-- batch would never get as far as evaluating it, because it could not compile.
-- Deferring the reference into a string is the standard fix. Migration 006's
-- header writes this trap up at length; it is the same one.
IF OBJECT_ID('MetalContents', 'U') IS NOT NULL
BEGIN
    -- The check that actually matters: is every metal we are ABOUT TO WRITE
    -- present in the table that feeds the editor's dropdown? A metal that is
    -- valid per this file but absent from the lookup table would still render
    -- as a blank <select>.
    --
    -- #CoinPlan is visible inside the dynamic batch because a local temp table
    -- created in an outer scope is in scope for everything that scope calls.
    -- (STRING_SPLIT would have been the tidier way to compare the whole seeded
    -- list, but it needs compatibility level 130+, and an old restored
    -- database is exactly where this check matters most.)
    DECLARE @Missing INT = 0;

    EXEC sp_executesql
        N'SELECT @Out = COUNT(DISTINCT p.WriteMetal)
          FROM #CoinPlan AS p
          WHERE p.WriteMetal IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM MetalContents AS m
                            WHERE m.MetalContentName = p.WriteMetal);',
        N'@Out INT OUTPUT',
        @Out = @Missing OUTPUT;

    IF @Missing > 0
    BEGIN
        PRINT 'Migration 007: NOTE - ' + CAST(@Missing AS NVARCHAR(10))
            + ' metal value(s) this script would write are missing from the';
        PRINT '               MetalContents lookup table. Not fatal here, but the coin';
        PRINT '               editor will show a blank Metal dropdown for those coins.';
        PRINT '               Re-seed MetalContents from setup-database.sql.';
    END
    ELSE
    BEGIN
        PRINT 'Migration 007: every metal it would write is also present in MetalContents.';
    END
END
GO

-- ============================================================
-- STEP 5: SHOW THE OWNER WHAT IS ABOUT TO HAPPEN
-- ============================================================
-- Nothing has been written yet and nothing will be until STEP 7. Everything
-- below is read out of #CoinPlan, which is the same table the update then
-- applies -- so these counts cannot disagree with what actually happens.
--
-- Four breakdowns, because they answer four different questions:
--   1. How many coins, and how many individual cells, are affected at all?
--   2. WHICH METAL is each coin being classified as?
--   3. WHAT KIND OF EVIDENCE classified it? This is the one to read carefully.
--      "Denomination + year" is a hard numismatic fact. "Metal only, from:
--      Category" is somebody's filing decision. Both are legitimate, but they
--      do not deserve equal trust, and the difference should be visible
--      BEFORE several hundred rows change rather than afterwards.
--   4. What is being left alone, and why?

DECLARE @Coins        INT = (SELECT COUNT(*) FROM #CoinPlan);
DECLARE @Affected     INT = (SELECT COUNT(*) FROM #CoinPlan WHERE FieldsToWrite > 0);
DECLARE @Cells        INT = (SELECT COALESCE(SUM(FieldsToWrite), 0) FROM #CoinPlan);
DECLARE @MetalCells   INT = (SELECT COUNT(*) FROM #CoinPlan WHERE WriteMetal     IS NOT NULL);
DECLARE @CompCells    INT = (SELECT COUNT(*) FROM #CoinPlan WHERE WriteComp      IS NOT NULL);
DECLARE @WeightCells  INT = (SELECT COUNT(*) FROM #CoinPlan WHERE WritePmWeight  IS NOT NULL);
DECLARE @PctCells     INT = (SELECT COUNT(*) FROM #CoinPlan WHERE WritePmPercent IS NOT NULL);
DECLARE @LeftAlone    INT = (SELECT COUNT(*) FROM #CoinPlan WHERE FieldsToWrite = 0);

DECLARE @Report TABLE (Rn INT IDENTITY(1,1) PRIMARY KEY, Line NVARCHAR(200));
DECLARE @i INT, @n INT, @Line NVARCHAR(200);

PRINT '';
PRINT '=====================================================================';
PRINT ' MIGRATION 007 - PREVIEW. NOTHING HAS BEEN WRITTEN YET.';
PRINT '=====================================================================';
PRINT '';
PRINT 'Coins in the table ...................... ' + CAST(@Coins       AS NVARCHAR(20));
PRINT 'Coins this script will change ........... ' + CAST(@Affected    AS NVARCHAR(20));
PRINT 'Coins it will LEAVE ALONE ............... ' + CAST(@LeftAlone   AS NVARCHAR(20));
PRINT 'Individual empty cells it will fill ..... ' + CAST(@Cells       AS NVARCHAR(20));
PRINT '';
PRINT '  MetalContent .......................... ' + CAST(@MetalCells  AS NVARCHAR(20));
PRINT '  Composition ........................... ' + CAST(@CompCells   AS NVARCHAR(20));
PRINT '  PmWeightGrams ......................... ' + CAST(@WeightCells AS NVARCHAR(20));
PRINT '  PmPercent ............................. ' + CAST(@PctCells    AS NVARCHAR(20));
PRINT '';
PRINT '(Coins.Weight is NOT touched by this script - see migration 008.)';

-- ----- 2. by metal ---------------------------------------------------------
DELETE FROM @Report;
INSERT INTO @Report (Line)
SELECT LEFT(p.WriteMetal + N' ' + REPLICATE(N'.', 40), 40) + N' '
     + CAST(COUNT(*) AS NVARCHAR(20))
FROM #CoinPlan AS p
WHERE p.WriteMetal IS NOT NULL
GROUP BY p.WriteMetal
ORDER BY COUNT(*) DESC, p.WriteMetal;

PRINT '';
PRINT '--- MetalContent values about to be written -------------------------';
SELECT @i = 1, @n = COALESCE(MAX(Rn), 0) FROM @Report;
IF @n = 0 PRINT '(none)';
WHILE @i <= @n
BEGIN
    SELECT @Line = Line FROM @Report WHERE Rn = @i;
    PRINT '  ' + @Line;
    SET @i = @i + 1;
END

-- ----- 3. by evidence ------------------------------------------------------
DELETE FROM @Report;
INSERT INTO @Report (Line)
SELECT LEFT(p.Evidence + N' ' + REPLICATE(N'.', 62), 62) + N' '
     + CAST(COUNT(*) AS NVARCHAR(20))
FROM #CoinPlan AS p
WHERE p.FieldsToWrite > 0
GROUP BY p.Evidence
ORDER BY COUNT(*) DESC, p.Evidence;

PRINT '';
PRINT '--- WHAT EVIDENCE CLASSIFIED EACH COIN (read this one) --------------';
PRINT '    "Denomination + year" is a hard fact. "Metal only, from: Category"';
PRINT '    is a filing decision. Weigh them differently.';
SELECT @i = 1, @n = COALESCE(MAX(Rn), 0) FROM @Report;
IF @n = 0 PRINT '(none)';
WHILE @i <= @n
BEGIN
    SELECT @Line = Line FROM @Report WHERE Rn = @i;
    PRINT '  ' + @Line;
    SET @i = @i + 1;
END

-- ----- 4. what is being skipped, and why -----------------------------------
DELETE FROM @Report;
INSERT INTO @Report (Line)
SELECT LEFT(p.Outcome + N' ' + REPLICATE(N'.', 62), 62) + N' '
     + CAST(COUNT(*) AS NVARCHAR(20))
FROM #CoinPlan AS p
WHERE p.FieldsToWrite = 0
GROUP BY p.Outcome
ORDER BY COUNT(*) DESC, p.Outcome;

PRINT '';
PRINT '--- COINS LEFT ALONE, AND WHY ---------------------------------------';
PRINT '    These are not failures. A blank is an honest "we do not know";';
PRINT '    a wrong metal would silently produce a wrong melt value.';
PRINT '    "Filled" here means the coin was resolved but every cell it would';
PRINT '    have filled was already occupied - nothing to do.';
SELECT @i = 1, @n = COALESCE(MAX(Rn), 0) FROM @Report;
IF @n = 0 PRINT '(none)';
WHILE @i <= @n
BEGIN
    SELECT @Line = Line FROM @Report WHERE Rn = @i;
    PRINT '  ' + @Line;
    SET @i = @i + 1;
END
PRINT '';
GO

-- A grid version of the same thing, for SSMS / Azure Data Studio, where a
-- result set is easier to read and sort than the Messages tab. Harmless under
-- sqlcmd -- it just prints as text.
SELECT Metal = WriteMetal, Coins = COUNT(*)
FROM #CoinPlan WHERE WriteMetal IS NOT NULL
GROUP BY WriteMetal ORDER BY COUNT(*) DESC;

SELECT Evidence, Coins = COUNT(*), CellsFilled = SUM(FieldsToWrite)
FROM #CoinPlan WHERE FieldsToWrite > 0
GROUP BY Evidence ORDER BY COUNT(*) DESC;

SELECT Outcome, Coins = COUNT(*)
FROM #CoinPlan WHERE FieldsToWrite = 0
GROUP BY Outcome ORDER BY COUNT(*) DESC;

-- The first 50 coins that will actually change, so the preview can be spot
-- checked against something recognisable rather than taken on trust.
SELECT TOP (50)
    CoinYear, Denomination, CoinType, Category, Country,
    NewMetal = WriteMetal, NewComposition = WriteComp,
    NewPmWeightGrams = WritePmWeight, NewPmPercent = WritePmPercent,
    Evidence
FROM #CoinPlan
WHERE FieldsToWrite > 0
ORDER BY Evidence, Denomination, CoinYear;
GO

-- ============================================================
-- STEP 6: back up every cell that is about to be written
-- ============================================================
-- Costs almost nothing -- one narrow table, one row per affected coin -- and
-- it is the difference between "undo that" and "restore last night's backup".
--
-- WHY THIS GOES THROUGH sp_executesql. A batch is compiled as a whole before
-- any of it runs, and SELECT ... INTO is checked at compile time. Writing it
-- plainly inside an IF would mean that on the SECOND run of this script the
-- batch could fail to compile because the target table already exists -- the
-- IF would correctly be false, but the batch would never get far enough to
-- evaluate it. Hiding the statement in a string defers it to execution time,
-- where the guard actually protects it. This is the same trap written up in
-- the header of 006-drop-coin-dealer.sql, from the other direction.
--
-- The table is NOT overwritten if it already exists. A second run has nothing
-- to update anyway, and silently replacing a good backup with an empty one is
-- exactly the sort of helpfulness nobody wants.

IF OBJECT_ID('tempdb..#Abort') IS NOT NULL
BEGIN
    PRINT 'Migration 007: STEP 4 failed, so no backup is taken and nothing is written.';
END
ELSE IF NOT EXISTS (SELECT 1 FROM #CoinPlan WHERE FieldsToWrite > 0)
BEGIN
    PRINT 'Migration 007: nothing to update, so no backup is needed.';
END
ELSE IF OBJECT_ID('Coins_MetalData_Backup', 'U') IS NOT NULL
BEGIN
    PRINT '';
    PRINT 'Migration 007: Coins_MetalData_Backup ALREADY EXISTS - leaving it untouched.';
    PRINT '               It is from an earlier run and is not being overwritten.';
    PRINT '               If you want a fresh one, DROP it and run this script again.';
    PRINT '';
END
ELSE
BEGIN
    DECLARE @BackupSql NVARCHAR(MAX) = N'
        SELECT c.CoinId,
               c.Year, c.Denomination, c.CoinType, c.Category, c.Country,
               PriorMetalContent  = c.MetalContent,
               PriorComposition   = c.Composition,
               PriorPmWeightGrams = c.PmWeightGrams,
               PriorPmPercent     = c.PmPercent,
               BackedUpAt         = SYSDATETIME()
        INTO   Coins_MetalData_Backup
        FROM   Coins AS c
        INNER JOIN #CoinPlan AS p ON p.CoinId = c.CoinId
        WHERE  p.FieldsToWrite > 0;';

    EXEC sp_executesql @BackupSql;

    -- The COUNT has to be deferred too, and for the SAME reason: the table did
    -- not exist when this batch was compiled, so a plain
    -- `SELECT COUNT(*) FROM Coins_MetalData_Backup` here would fail to compile
    -- with "Invalid object name" before the sp_executesql above ever ran.
    DECLARE @Backed INT = 0;
    EXEC sp_executesql
        N'SELECT @Out = COUNT(*) FROM Coins_MetalData_Backup;',
        N'@Out INT OUTPUT',
        @Out = @Backed OUTPUT;

    PRINT 'Migration 007: backed up ' + CAST(@Backed AS NVARCHAR(20))
        + ' coin(s) into Coins_MetalData_Backup.';
    PRINT '';
    PRINT 'TO UNDO EVERYTHING THIS SCRIPT IS ABOUT TO DO, run:';
    PRINT '';
    PRINT '    UPDATE c';
    PRINT '    SET c.MetalContent  = b.PriorMetalContent,';
    PRINT '        c.Composition   = b.PriorComposition,';
    PRINT '        c.PmWeightGrams = b.PriorPmWeightGrams,';
    PRINT '        c.PmPercent     = b.PriorPmPercent';
    PRINT '    FROM Coins AS c';
    PRINT '    INNER JOIN Coins_MetalData_Backup AS b ON b.CoinId = c.CoinId;';
    PRINT '';
    PRINT '    DROP TABLE Coins_MetalData_Backup;   -- once you are happy';
    PRINT '';
END
GO

-- ============================================================
-- STEP 7: write it
-- ============================================================
-- SET XACT_ABORT ON makes any run-time error abort the whole transaction
-- rather than carry on with the next statement, which is the behaviour you
-- want when the alternative is a half-converted table. The explicit
-- transaction plus TRY/CATCH then guarantees all-or-nothing: either every
-- planned cell is written or none is.
--
-- The WHERE clause RE-CHECKS that each cell is still empty, rather than
-- trusting the plan built in STEP 3. Belt and braces -- it costs nothing, it
-- makes the statement correct on its own terms, and it means that if somebody
-- edited a coin between the preview and the update, their value wins.
--
-- Each column is written independently. A coin can gain a composition while
-- keeping a metal the owner typed in himself.

SET XACT_ABORT ON;

IF OBJECT_ID('tempdb..#Abort') IS NOT NULL
BEGIN
    PRINT 'Migration 007: STEP 4 failed. NOTHING WAS WRITTEN.';
END
ELSE IF NOT EXISTS (SELECT 1 FROM #CoinPlan WHERE FieldsToWrite > 0)
BEGIN
    PRINT 'Migration 007: 0 rows to update - every cell this script could fill is';
    PRINT '               already filled. (This is what a second run looks like.)';
END
ELSE
BEGIN
    -- Declared BEFORE the UPDATE on purpose. Writing
    -- `DECLARE @Rows INT = @@ROWCOUNT;` after it would report 0 every time:
    -- a DECLARE statement resets @@ROWCOUNT before its own initialiser is
    -- evaluated, so the count would be the DECLARE's own, not the UPDATE's.
    DECLARE @Rows INT = 0;

    BEGIN TRY
        BEGIN TRANSACTION;

        UPDATE c
        SET c.MetalContent  = COALESCE(p.WriteMetal,      c.MetalContent),
            c.Composition   = COALESCE(p.WriteComp,       c.Composition),
            c.PmWeightGrams = COALESCE(p.WritePmWeight,   c.PmWeightGrams),
            c.PmPercent     = COALESCE(p.WritePmPercent,  c.PmPercent)
        FROM Coins AS c
        INNER JOIN #CoinPlan AS p ON p.CoinId = c.CoinId
        WHERE p.FieldsToWrite > 0
          AND (   (p.WriteMetal     IS NOT NULL AND LTRIM(RTRIM(COALESCE(c.MetalContent, N''))) = N'')
               OR (p.WriteComp      IS NOT NULL AND LTRIM(RTRIM(COALESCE(c.Composition,  N''))) = N'')
               OR (p.WritePmWeight  IS NOT NULL AND c.PmWeightGrams IS NULL)
               OR (p.WritePmPercent IS NOT NULL AND c.PmPercent     IS NULL));

        SET @Rows = @@ROWCOUNT;

        COMMIT TRANSACTION;

        PRINT 'Migration 007: UPDATED ' + CAST(@Rows AS NVARCHAR(20)) + ' coin(s). Committed.';
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;

        PRINT '';
        PRINT '*********************************************************************';
        PRINT '*** Migration 007: THE UPDATE FAILED AND WAS ROLLED BACK          ***';
        PRINT '*********************************************************************';
        PRINT 'Error ' + CAST(ERROR_NUMBER() AS NVARCHAR(20))
            + ' at line ' + CAST(ERROR_LINE() AS NVARCHAR(20)) + ':';
        PRINT ERROR_MESSAGE();
        PRINT '';
        PRINT 'No coin was changed. The table is exactly as it was.';
        PRINT 'Coins_MetalData_Backup may exist from STEP 6; it is harmless and can';
        PRINT 'be dropped before re-running.';
        PRINT '';
    END CATCH
END

SET XACT_ABORT OFF;
GO

-- ============================================================
-- STEP 8: SUMMARY
-- ============================================================
-- Reports the end state plainly, so the outcome is visible without writing a
-- separate query. This runs in its own batch, after the update, and re-reads
-- the Coins table rather than trusting what the previous batch believed.

DECLARE @Total    INT = (SELECT COUNT(*) FROM Coins);
DECLARE @HasMetal INT = (SELECT COUNT(*) FROM Coins WHERE LTRIM(RTRIM(COALESCE(MetalContent, N''))) <> N'');
DECLARE @HasComp  INT = (SELECT COUNT(*) FROM Coins WHERE LTRIM(RTRIM(COALESCE(Composition,  N''))) <> N'');
DECLARE @HasWt    INT = (SELECT COUNT(*) FROM Coins WHERE PmWeightGrams IS NOT NULL);
DECLARE @HasPct   INT = (SELECT COUNT(*) FROM Coins WHERE PmPercent     IS NOT NULL);
DECLARE @Planned  INT = (SELECT COUNT(*) FROM #CoinPlan WHERE FieldsToWrite > 0);
DECLARE @Skipped  INT = (SELECT COUNT(*) FROM #CoinPlan WHERE FieldsToWrite = 0);

PRINT '';
PRINT '=====================================================================';
PRINT ' MIGRATION 007 - SUMMARY';
PRINT '=====================================================================';
PRINT '';
PRINT 'Coins in the table ...................... ' + CAST(@Total    AS NVARCHAR(20));
PRINT 'Coins this run planned to change ........ ' + CAST(@Planned  AS NVARCHAR(20));
PRINT 'Coins deliberately left alone ........... ' + CAST(@Skipped  AS NVARCHAR(20));
PRINT '';
PRINT '--- Column coverage across the whole inventory, NOW -----------------';
PRINT 'MetalContent filled ..................... ' + CAST(@HasMetal AS NVARCHAR(20))
    + ' of ' + CAST(@Total AS NVARCHAR(20));
PRINT 'Composition filled ...................... ' + CAST(@HasComp  AS NVARCHAR(20))
    + ' of ' + CAST(@Total AS NVARCHAR(20));
PRINT 'PmWeightGrams filled .................... ' + CAST(@HasWt    AS NVARCHAR(20))
    + ' of ' + CAST(@Total AS NVARCHAR(20));
PRINT 'PmPercent filled ........................ ' + CAST(@HasPct   AS NVARCHAR(20))
    + ' of ' + CAST(@Total AS NVARCHAR(20));
PRINT '';
PRINT 'PmWeightGrams and PmPercent are EXPECTED to lag the other two. A bronze';
PRINT 'cent has a metal and a composition but genuinely has no precious-metal';
PRINT 'weight, and writing 0 there would be a recorded fact rather than an';
PRINT 'absence. Those blanks are correct.';
PRINT '';
PRINT 'Coins.Weight was NOT touched. Its units change is migration 008.';
PRINT '';

IF OBJECT_ID('Coins_MetalData_Backup', 'U') IS NOT NULL
BEGIN
    PRINT '--- UNDO -----------------------------------------------------------';
    PRINT 'Every cell that changed is recorded in Coins_MetalData_Backup. To put';
    PRINT 'all four columns back exactly as they were:';
    PRINT '';
    PRINT '    UPDATE c';
    PRINT '    SET c.MetalContent  = b.PriorMetalContent,';
    PRINT '        c.Composition   = b.PriorComposition,';
    PRINT '        c.PmWeightGrams = b.PriorPmWeightGrams,';
    PRINT '        c.PmPercent     = b.PriorPmPercent';
    PRINT '    FROM Coins AS c';
    PRINT '    INNER JOIN Coins_MetalData_Backup AS b ON b.CoinId = c.CoinId;';
    PRINT '';
    PRINT 'To see what changed before deciding:';
    PRINT '';
    PRINT '    SELECT b.Year, b.Denomination, b.CoinType,';
    PRINT '           b.PriorMetalContent, c.MetalContent,';
    PRINT '           b.PriorComposition,  c.Composition,';
    PRINT '           b.PriorPmWeightGrams, c.PmWeightGrams,';
    PRINT '           b.PriorPmPercent,     c.PmPercent';
    PRINT '    FROM Coins_MetalData_Backup AS b';
    PRINT '    INNER JOIN Coins AS c ON c.CoinId = b.CoinId';
    PRINT '    ORDER BY b.Denomination, b.Year;';
    PRINT '';
    PRINT 'Once you are satisfied:   DROP TABLE Coins_MetalData_Backup;';
    PRINT '';
END
ELSE
BEGIN
    PRINT '--- UNDO -----------------------------------------------------------';
    PRINT 'No backup table exists, because nothing was written.';
    PRINT '';
END

PRINT '--- NEXT ------------------------------------------------------------';
PRINT '1. Open Settings in the app and run the PM backfill. It uses the tested';
PRINT '   engine in pm-reference.ts and will now be able to finish coins this';
PRINT '   script unlocked by giving them a metal.';
PRINT '2. Look at the coins reported as "Skipped - conflict" above. Each one is';
PRINT '   a row whose own description disagrees with what the reference table';
PRINT '   says the coin is made of, and each one wants a human eye.';
PRINT '3. No API restart is required. Nothing about the schema changed.';
PRINT '';
PRINT 'Migration 007 complete.';
GO

-- The coins that were skipped BECAUSE THEY CONTRADICT THEMSELVES, listed out.
-- This is the one skip category that is not simply "we do not know" -- it is
-- "two things on this row disagree" -- so it is worth putting the actual rows
-- in front of the owner rather than only a count.
SELECT TOP (100)
    CoinYear, Denomination, CoinType, Category, Country,
    MetalImpliedByTheRow = HintMetal,
    WhereThatCameFrom    = HintEvidence,
    PriorMetal
FROM #CoinPlan
WHERE Outcome = N'Skipped - conflict'
ORDER BY Denomination, CoinYear;
GO

-- ============================================================
-- STEP 9: tidy up
-- ============================================================
-- The #temp tables would go away on their own when the connection closes, but
-- dropping them explicitly means running the file twice in one SSMS window
-- behaves exactly like running it twice from scratch.
--
-- Coins_MetalData_Backup is a REAL table and is deliberately NOT dropped here.
-- It is the undo path; it stays until the owner removes it.

IF OBJECT_ID('tempdb..#PmReference') IS NOT NULL DROP TABLE #PmReference;
IF OBJECT_ID('tempdb..#CoinPlan')    IS NOT NULL DROP TABLE #CoinPlan;
IF OBJECT_ID('tempdb..#Abort')       IS NOT NULL DROP TABLE #Abort;
GO
