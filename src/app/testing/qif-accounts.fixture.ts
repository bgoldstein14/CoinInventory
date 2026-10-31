/* ===========================================================================
 * qif-accounts.fixture.ts
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS
 *   An inventory read out of the eight Quicken exports in
 *   `src/app/testing/qif-corpus/`, one entry per account. It replaces the two
 *   hand-copied, collection-named fixtures that came before it.
 *
 * ---------------------------------------------------------------------------
 * !! THESE ARE NOT THE OWNER'S FILES ANY MORE -- AND THAT MATTERS TWICE !!
 * ---------------------------------------------------------------------------
 *   Until the repository was prepared to go public, this fixture read his
 *   REAL exports out of the repository root: eight 6.7 MB files holding 815
 *   securities, only about half of them coins. The rest was his financial
 *   life -- stock and fund positions, a retirement account, savings bonds, options, bank and
 *   credit-card registers, income categories, a private company name and his
 *   street address, which Quicken had stored in a TAG. Those files are gone.
 *
 *   `qif-corpus/` holds a SYNTHETIC replacement, written by
 *   `qif-corpus/generate-corpus.mjs`. Read that file's header before changing
 *   anything here: it records exactly how the corpus was derived and, more
 *   importantly, WHAT ABOUT IT MUST NOT BE SIMPLIFIED.
 *
 *   The short version, because it is the thing most likely to be lost:
 *
 *       THE CORPUS REPRODUCES THE REAL COLLECTION'S COLLISION DENSITY,
 *       GROUP FOR GROUP. Several coins sharing one year and one
 *       denomination, differing only by grade, is the shape every
 *       interesting bug in the matcher has hidden in, and it is the one
 *       shape a tidy fixture never has. If you regenerate this corpus with
 *       one coin per (year, denomination), every matcher test below will go
 *       on passing while testing almost nothing.
 *
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS -- THE OWNER ASKED FOR THIS, IN THESE WORDS
 * ---------------------------------------------------------------------------
 *     "I wouldn't expect there to be a special file to single out a
 *      particular type of coin like the three-cent-proofs.spec.ts. That's too
 *      specific and will just add a lot of noise to this project if we had
 *      files for every denomination. Likely, whatever rules are in there can
 *      be applied across the board."
 *
 *   He has EIGHT accounts. One spec file per collection does not scale to
 *   eight, and it scales even worse to the ninth. So the collections are now
 *   DATA -- the `QIF_ACCOUNTS` table below -- and there is one spec,
 *   inventory-accounts.spec.ts, that runs every rule over every account.
 *
 *   ADDING A COLLECTION IS ADDING A ROW TO THAT TABLE. It is never a new
 *   file, and it is never a new copy of an assertion.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS KEPT FROM THE OLD FIXTURES, AND WHY IT HAD TO BE
 * ---------------------------------------------------------------------------
 *   early-proofs.fixture.ts held the 59 `Early Proofs` securities, typed out
 *   by hand, plus a filename builder. Both ideas survive here; only the
 *   hand-typing is gone, because the file they were copied FROM is sitting
 *   in `qif-corpus/` and reading it cannot go stale.
 *
 *   The data itself is not optional. The synthetic census in
 *   import-tiers.spec.ts derives its inventory FROM THE FILENAMES IT TESTS,
 *   so it can never contain two coins of one year and denomination -- and
 *   that is precisely the shape every interesting bug has hidden in. His
 *   real accounts were full of it: a ten-deep run of one year and
 *   denomination in the 2-3-20-cent collection, a seven-deep run in Misc.
 *   Coins, four years in Early Proofs holding both a 3CS and a 3CN. Those
 *   collisions are what the fixtures caught bugs with, and the corpus in
 *   `qif-corpus/` was built to hold every one of them -- same group count,
 *   same multiplicities -- on coins that are nobody's.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE IMPORTER READS, AND WHAT IT IGNORES
 * ---------------------------------------------------------------------------
 *   Worth stating here because it is the justification for everything the
 *   corpus files contain BESIDES coins.
 *
 *     READ      `!Account` (its `N` line names the account) and `!Type:Invst`
 *               blocks that carry a `Y` security line.
 *     IGNORED   `!Type:Prices` (short-circuited by name), `!Type:Security`,
 *               `!Type:Cat`, `!Type:Tag` and `!Type:Bank` (all have an `N`
 *               line, so they reach `parseInvestmentFields` and are dropped
 *               for having no `Y`), `NXIn`/`NXOut` cash transfers, and the
 *               `!Option:`/`!Clear:AutoSwitch` markers.
 *
 *   The corpus carries a synthetic version of every ignored section ON
 *   PURPOSE. A corpus of nothing but coins would stop testing the ignoring,
 *   and the day the parser started choking on -- or worse, ingesting -- a
 *   category block, nothing would say so.
 *
 * ---------------------------------------------------------------------------
 * !! THE FILES ARE WINDOWS-1252, NOT UTF-8 !!
 * ---------------------------------------------------------------------------
 *   In the raw bytes a cent sign is the single byte 0xA2 and "½" is 0xBD.
 *   Decoded as UTF-8 those become replacement characters and every
 *   denomination in the collection is destroyed silently. The corpus is
 *   WRITTEN in windows-1252 for exactly that reason -- see the encoder in
 *   `generate-corpus.mjs`, which is built by inverting the decoder the
 *   application uses rather than typed out.
 *
 *   `decodeQif` below therefore uses `new TextDecoder('windows-1252')`,
 *   which is EXACTLY what the application does -- see `quicken-import-modal.ts`.
 *   Reading these files any other way would be testing a string the importer
 *   never sees.
 *
 * ---------------------------------------------------------------------------
 * WHY ANCIENTS IS EXCLUDED
 * ---------------------------------------------------------------------------
 *   `Ancients.QIF` is deliberately absent from the table. An ancient coin has
 *   no year, no denomination and no grade -- three of the four attributes the
 *   matcher identifies a coin by -- so it is matched on catalogue references
 *   instead, which is a separate design with its own deferred plan in
 *   `docs/ancients-matching-plan.md`. Including it here would measure a
 *   feature that has not been built yet and drag every account's numbers
 *   down with it.
 * =========================================================================== */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoinRecord } from '../types/coin.model';
import { QuickenImportService } from '../services/quicken-import.service';

/**
 * The corpus directory, found relative to THIS FILE rather than to the
 * process's working directory.
 *
 * `vitest run --root src` starts the runner inside `src/`, but a developer
 * running one spec from an editor may start it anywhere. Anchoring on
 * `import.meta.url` is the only way that is true in both cases.
 *
 * WHY THE CORPUS LIVES HERE AND NOT IN THE REPOSITORY ROOT
 *   It used to be at the root, because that is where Quicken had dropped the
 *   owner's own exports. A `.QIF` at the root of a public repository reads as
 *   somebody's data, which is exactly the impression this work exists to
 *   remove; and test data that only one fixture opens belongs beside that
 *   fixture, where renaming the two together is the obvious move.
 */
const CORPUS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'qif-corpus');

/* ===========================================================================
 * THE TABLE -- ADD A COLLECTION BY ADDING A ROW
 * ========================================================================= */

/** One of the owner's Quicken accounts, and what is special about it. */
export interface QifAccount {
  /** The `.QIF` file in `qif-corpus/`. */
  file: string;
  /**
   * The account name as it appears on the `N` line of the file's `!Account`
   * block. `QuickenImportService.parse` takes this as its second argument and
   * imports only the transactions filed under it, which is exactly what the
   * import modal does when the user picks an account from the list.
   */
  account: string;
  /**
   * Why this account is in the table -- what it exercises that the others do
   * not. Printed in the census so the numbers can be read in context.
   */
  why: string;
}

/**
 * EVERY ACCOUNT EXCEPT ANCIENTS.
 *
 * The `why` lines are not decoration: they are the record of which account
 * covers which hazard, so that a future reader can tell at a glance whether
 * a new collection would add anything or merely add runtime.
 */
export const QIF_ACCOUNTS: readonly QifAccount[] = [
  {
    file: 'EarlyProofs.QIF',
    account: 'Early Proofs',
    why:
      'EVERY COIN IS A PROOF, so the proof-against-business veto can never ' +
      'separate two of them; four years hold both a 3CS and a 3CN (1866, ' +
      '1867, 1868, 1872); the grade notation mixes PR with PF and CAM with ' +
      'Cameo; and the denominations are dense and small (1¢, 2¢, 3CN, 3CS, ' +
      '5¢, ½10¢, 10¢, 20¢, 25¢, 50¢, $1), several sharing a year.'
  },
  {
    file: '2-3-20Cent.QIF',
    account: '2-3-20-cent Collection',
    why:
      'THE DUPLICATE-HEAVY ONE. Long runs of one date and denomination where ' +
      'only the grade differs -- ten 1877 twenty-cent pieces, nine 1877 Three ' +
      'Cent Nickels, five 1864 Two Cent pieces, 26 duplicate groups in all -- ' +
      'which is the inventory shape the synthetic census in ' +
      'import-tiers.spec.ts structurally cannot produce.'
  },
  {
    file: 'OddTypeSet.QIF',
    account: 'Odd Type Set',
    why:
      'THE RAGGED ONE: bare securities with no grading service and often no ' +
      'grade at all ("1864 2¢"), split grades ("VF/EF"), and foreign pieces ' +
      '("1754 Mex. 8 Real").'
  },
  {
    file: 'TypeCoins.QIF',
    account: 'Type Coins',
    why:
      'THE EARLY-DATE ONE: large cents and half cents written "1¢" and "½¢", ' +
      'an overdate ("1810/09"), parenthetical notes ("(CLEANED)") and ' +
      'split grades ("VF/XF"). Also the only account with a double space in a ' +
      'name ("1804 ½¢  Plain 4-Stemless").'
  },
  {
    file: '20thCenturyType.QIF',
    account: '20th Cent. Type',
    why:
      'THE MINT-MARK-GLUED-TO-THE-YEAR ONE: "1908O 25¢", "1904D 5¢", ' +
      '"1961S 25¢" -- no separator at all between the year and the mint.'
  },
  {
    file: 'GoldCoins.QIF',
    account: 'Gold Coins',
    why:
      'THE DOLLAR-SIGN ONE, and the reason the generic "dollar" row exists: ' +
      '$1 / G$1 / G$2.50 / $3 / G$3 / $5 / $10 / $20 all appear, and "G$1" ' +
      'must not be read as the "$1" hiding inside it. It is also the account ' +
      'quicken-corpus-securities.spec.ts asserts coin by coin, all 44 of them.'
  },
  {
    file: 'MiscCoins.QIF',
    account: 'Misc. Coins',
    why:
      'THE EVERYTHING-ELSE ONE: foreign coins ("1753 Pillar Dollar (8 ' +
      'Reales)", "1812 ½ Real - Mexico City"), details grades ("AU53 ' +
      'Details"), counterfeits marked "FAKE", repunched-date varieties, and ' +
      'the 20 securities that are sets or tokens and correctly do not import.'
  }
];

/* ===========================================================================
 * READING ONE ACCOUNT
 * ========================================================================= */

/**
 * Read a `.QIF` from `qif-corpus/` and decode it THE WAY THE
 * APPLICATION DOES.
 *
 * `quicken-import-modal.ts`:
 *
 *     const text = new TextDecoder('windows-1252').decode(buffer);
 *
 * Nothing clever is allowed here. If this decode ever drifts from the
 * modal's, every denomination in the collection quietly turns into a
 * replacement character and the tests go on passing against a corpus the
 * importer will never see.
 */
export function decodeQif(file: string): string {
  return new TextDecoder('windows-1252').decode(readFileSync(resolve(CORPUS_DIR, file)));
}

/**
 * Every DISTINCT security name filed under one account, in file order.
 *
 * WHY THIS IS NOT `parse(text, account).importedRecords`
 *   It very nearly is, and the difference is deliberate. `parse` applies the
 *   NET-QUANTITY rule: a coin he bought and later sold nets to zero and is
 *   reported in `skippedRecords` instead, because he does not own it any
 *   more. That is exactly right for the application and wrong for a test
 *   fixture, because:
 *
 *     - a sold coin's security name is still a real string he typed, and it
 *       still exercises every parsing rule;
 *     - the sold coins are what make the inventory DENSE. The 2-3-20-cent
 *       account currently holds 7 coins but has held 112, and the five 1861
 *       Three Cent Silvers that every interesting bug hid between are mostly
 *       among the sold ones.
 *
 *   So the tests run against EVERY coin the account has ever held, which is a
 *   strict superset of what he owns and therefore the harder, more
 *   collision-prone case. Measuring the easier case would flatter the
 *   matcher.
 *
 * The scan is a few lines rather than a call into the service because the
 * service deliberately does not expose raw security names -- it returns
 * parsed records -- and the FILENAME BUILDER below needs the raw text, with
 * his own spacing and his own "½10¢", not the normalized denomination.
 */
export function securityNamesFor(account: QifAccount): string[] {
  const names: string[] = [];
  const seen = new Set<string>();

  let inAccountBlock = false;
  let currentAccount: string | null = null;
  let inInvestmentSection = false;

  for (const raw of decodeQif(account.file).split(/\r?\n/)) {
    // QIF is CRLF and the final field of every block is a bare "^".
    const line = raw.trimEnd();

    if (line.startsWith('!Account')) {
      // The next `N` line names the account this block is about.
      inAccountBlock = true;
      inInvestmentSection = false;
      continue;
    }
    if (line.startsWith('!Type:')) {
      // A `!Type:Invst` header applies to the account most recently named.
      inAccountBlock = false;
      inInvestmentSection = line.startsWith('!Type:Invst');
      continue;
    }
    if (inAccountBlock && line.startsWith('N')) {
      currentAccount = line.slice(1).trim();
      continue;
    }

    // `Y` is the security name on an investment transaction.
    if (inInvestmentSection && currentAccount === account.account && line.startsWith('Y')) {
      const name = line.slice(1).trim();
      if (name && !seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
  }

  return names;
}

/**
 * Turn an account's security names into coin records BY RUNNING THEM THROUGH
 * THE REAL IMPORTER.
 *
 * Not by hand-writing what we imagine the import produces. If the importer's
 * field mapping ever changes -- and twice now it has, both times because a
 * denomination was being mis-read -- these records change with it and the
 * tests notice. That is the entire reason this is a wrapper round
 * `QuickenImportService` rather than a literal array.
 *
 * Each name is wrapped in a minimal one-share purchase so that the
 * net-quantity rule keeps all of them; see `securityNamesFor` for why the
 * sold coins are wanted.
 */
export function inventoryFor(account: QifAccount): CoinRecord[] {
  const qif =
    '!Type:Invst\n' +
    securityNamesFor(account)
      .map(name => `D01/15/2024\nNBuy\nY${name}\nQ1\nT100.00\n^`)
      .join('\n') +
    '\n';

  const records = new QuickenImportService().parse(qif).importedRecords as unknown as CoinRecord[];

  // The ids the importer assigns are not stable across runs, so each record
  // is given a predictable one. That is the ONLY thing done to them.
  records.forEach((record, index) => {
    record.id = `${account.account}-${index}`;
    record.imagePaths = [];
  });
  return records;
}

/* ===========================================================================
 * BUILDING THE PHOTOGRAPH NAMES
 * ========================================================================= */

/**
 * THE GRADE AS HE WRITES IT IN A FILENAME, given the grade as his record
 * holds it.
 *
 * Two substitutions, both taken from filenames he has actually quoted:
 *
 *   "PF64 Cameo" -> "PF64CAM"   he reported "1867 3CS - NGC PF65CAM -
 *                               Reverse.jpg" sitting beside the record
 *                               "1867 3CS - NGC PF65 Cameo", and that single
 *                               difference in notation is the whole of the
 *                               bug the grade tolerance exists to fix
 *   "PR65"       -> "PF65"      PCGS prints PR and NGC prints PF for the same
 *                               striking, and a filename typed later does not
 *                               reliably reproduce which slab it came off
 *
 * Everything else passes through untouched, so "PF64RB", "PF62+" and the
 * letter-less "64CAM" reach the matcher exactly as he recorded them.
 */
export function filenameGrade(recordGrade: string): string {
  return recordGrade
    .replace(/\s*Cameo\b/gi, 'CAM')
    .replace(/\bPR(?=\d)/g, 'PF');
}

/**
 * The photograph "stem" for one security -- everything before " - Obverse".
 *
 * WHY THE WHOLE SECURITY NAME IS KEPT, SEPARATORS AND ALL
 *   An earlier version of this builder re-assembled the name from parsed
 *   pieces into a tidy "<year> <denom> - <service> <grade>". That was a
 *   mistake, because his real filenames are NOT tidy and keep whatever
 *   separator the security used. The verbatim corpus in
 *   real-filenames.fixture.ts proves it:
 *
 *       1875-S 20-cent ANACS XF40.jpg      no " - " before the service
 *       1812 50¢ VG - Obverse - Small.jpg  no separator before the grade
 *       1870 $1 - PCGS PF62CAM- Obverse.jpg   a missing space, verbatim
 *
 *   It was also unusable here. The old builder anchored its split on the
 *   GRADING SERVICE, and most of his accounts outside Early Proofs name no
 *   service at all ("1864 2¢", "1902 50¢-F", "1861 3CS - AU"). Keeping the
 *   name whole works for every account and is closer to the truth besides.
 *
 * Three substitutions, and only three:
 *
 *   /CAC dropped   The green CAC sticker is noted on his RECORDS but not in
 *                  his filenames; "PCGS/CAC PF64" is photographed as
 *                  "PCGS PF64".
 *   grade spelling `filenameGrade` above.
 *   "/" -> "-"     !! NOT COSMETIC. "/" is one of the nine characters
 *                  WINDOWS FORBIDS IN A FILENAME, so a security like
 *                  "1887/6 3CN" (an overdate), "1883 5¢ N/C" (No Cents) or
 *                  "1907 10¢-VF/XF" (a split grade) CANNOT be photographed
 *                  under its own name. He has to substitute something, and a
 *                  hyphen is the usual choice.
 *
 *                  This is not a defect to fix in the matcher. If a slashed
 *                  name ever did reach it, `baseName` in text-tokens.ts would
 *                  -- correctly -- keep only what follows the last "/", so
 *                  "1887/6 3CN - PCGS PF65 - Obverse.jpg" would be read as
 *                  "6 3CN - ...": no year, and therefore no match. That is
 *                  the safe direction, and inventory-accounts.spec.ts pins it
 *                  so it is never rediscovered as a mystery.
 */
export function photoStem(security: string): string {
  return filenameGrade(security.replace(/\/CAC/gi, ''))
    .replace(/\//g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build the photograph names for a whole account: an obverse and a reverse
 * for every coin, which is what he shoots.
 *
 * @param account the account to photograph.
 * @param sides   which faces to generate. Defaults to the two he always takes.
 */
export function photoFilenamesFor(
  account: QifAccount,
  sides: readonly string[] = ['Obverse', 'Reverse']
): string[] {
  const names: string[] = [];
  for (const security of securityNamesFor(account)) {
    for (const side of sides) {
      names.push(`${photoStem(security)} - ${side}.jpg`);
    }
  }
  return names;
}

/* ---------------------------------------------------------------------------
 * THE SILENT SECOND SHOT -- THE CASE THE WHOLE STRIKE RULE IS ABOUT
 * -------------------------------------------------------------------------
 * `photoFilenamesFor` above has a BLIND SPOT, and it is the same one the
 * synthetic census in import-tiers.spec.ts has: every filename it generates
 * is built FROM the record it is supposed to match, so it always repeats
 * whatever the record said. A photo derived from a proof record always says
 * "PF". The proof-against-business rule can therefore never fire in that
 * census, in either direction, and a measurement that cannot see a rule
 * cannot defend it.
 *
 * His real share is not like that. Plenty of his photographs say far less
 * than the record does, and the verbatim corpus in real-filenames.fixture.ts
 * is full of pairs where the second shot simply drops everything but the
 * year and the denomination:
 *
 *     1870 10-cent - NGC PF64Cameo - Reverse 5.jpg   <- the full name
 *     1870 10-cent - Obverse.jpg                     <- the silent one
 *     1865 3CN - Choice VF - Obverse - Photo.jpg
 *     1865 3CN - Obverse.jpg
 *     1884 3CN - Obverse 2.jpg
 *
 * THE SILENT SHOT IS THE WHOLE POINT. The owner's rule --
 *
 *     "The Proof descriptor should always be part of the image file name as
 *      well as part of the inventory description otherwise it's assumed the
 *      coin is a business strike."
 *
 * -- says that the second line above is NOT an abbreviation of the first. It
 * is a positive claim that the coin is an ordinary circulation strike, and
 * it therefore must not be filed under a proof record. That is the behaviour
 * he insisted on three times, and this generator is what lets the census
 * measure its cost instead of guessing at it.
 * ------------------------------------------------------------------------- */

/**
 * One deliberately uninformative extra photograph per coin: the year, the
 * mint mark and the denomination, and nothing else.
 *
 * Built from the IMPORTED RECORD rather than from the raw security name,
 * because the point is to say LESS than the record does, and the record's
 * own normalized fields are the smallest honest statement about the coin.
 *
 * Coins with no year or no denomination are skipped: a name with neither
 * could not identify any coin and would only measure the parser's handling
 * of junk, which real-filenames.spec.ts already covers.
 */
export function silentPhotoFilenamesFor(account: QifAccount): string[] {
  const names: string[] = [];
  for (const record of inventoryFor(account)) {
    if (!record.year || !record.denomination) continue;
    const yearPart = [record.year, record.mintMark].filter(Boolean).join('-');
    names.push(`${yearPart} ${record.denomination} - Obverse 2.jpg`.replace(/\//g, '-'));
  }
  return [...new Set(names)];
}
