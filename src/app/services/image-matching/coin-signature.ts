 /*
 * coin-signature.ts
 *
 * WHAT THIS FILE OWNS
 *   STAGE 1 for the COIN side of the comparison:
 *     - `Signature`, the shared shape both sides of a comparison are reduced
 *       to (a filename becomes one of these too -- see filename-parser.ts),
 *     - `CoinSignature`, a coin record bundled with its parsed signature,
 *     - `parseCoin`, which turns a CoinRecord's structured fields into a
 *       Signature,
 *     - `buildCoinSignatures`, the once-per-batch precompute,
 *     - `denominationLabelSnapshot`, the id -> Label table the coin side is
 *       resolved against,
 *     - `describeCoin`, the display label ("Morgan Dollar 1881-S").
 *
 * WHY IT IS ITS OWN FILE
 *   Parsing a coin RECORD and parsing a FILENAME are genuinely different jobs
 *   that happen to produce the same shape. A record hands us tidy, separate
 *   fields we can mostly trust; a filename hands us one messy string we have
 *   to be suspicious of. Keeping them apart stops the careful "don't trust
 *   this" rules of the filename parser from leaking into the record parser,
 *   where they would throw away good data.
 *
 *   `Signature` lives here because it is the contract the rest of the matcher
 *   is written against, and this is the file that defines what a well-formed
 *   one looks like.
  */

import { CoinRecord, StrikeKind } from '../../types/coin.model';
import { foldCatalogRefs } from './catalog-refs';
import { readTrustedDenominationText } from './denomination-units';
import { COUNTERFEIT_MARKER_WORDS } from './filename-vocabulary';
import { normalizeGrade } from './grade-parser';
import { detectStrike } from './proof-strike';
import { MINT_CODES, MINT_NAMES, resolveEagleSeries } from './reference-tables';
import {
  findDenomination,
  isPlausibleYear,
  meaningfulTokens,
  removeDenominationTokens,
  removeRange,
  tokenize
} from './text-tokens';

 /*
 * THE DENOMINATION LOOKUP, AS THE MATCHER IS ALLOWED TO SEE IT
 *
 * WHY THE COIN SIDE NEEDS A LOOKUP AT ALL
 *   A coin carries two denomination fields and they are ALLOWED TO DISAGREE
 *   (design §4.1):
 *
 *       Coins.DenominationId   the canonical link. NULL is ordinary.
 *       Coins.Denomination     WHAT THE SOURCE SAID. Never rewritten by
 *                              anything, including the migrations.
 *
 *   After an import they usually do disagree: the text goes on saying
 *   `Pillar Dollar` while the id says `8 Reales`. Reading only the text gets
 *   such a coin scored -- and VETOED -- against every photograph of a Dollar
 *   in a collection that holds dozens. So the coin's id is resolved to its
 *   label and the EXISTING string logic is fed that label unchanged (design
 *   §6). Comparing ids on both sides would be better eventually; that is not
 *   what this does.
 *
 * *** THE MATCHER DOES NOT PERFORM THE LOOKUP, AND MUST NOT. ***
 *
 *   It is handed a finished snapshot. That is not fastidiousness about
 *   dependencies; it prevents a timing bug that would be invisible:
 *
 *     `BatchImageImportService.buildRows` matches in chunks of 200 filenames
 *     and awaits a paint between them. If the coin side resolved its own
 *     labels from a signal, a lookup response landing between two chunks
 *     would match photographs 1-200 under one set of rules and 201-400 under
 *     another -- one folder, two behaviours, nothing anywhere saying so.
 *
 *   So the snapshot is taken ONCE, before the loop, and `parseCoin` is a pure
 *   function of its arguments. A lookup that has not returned yet is an EMPTY
 *   snapshot, and an empty snapshot is the plain text-only matcher, never
 *   some third behaviour. coin-denomination-label.spec.ts tests every one of
 *   those statements.
  */

/**
 * What this module needs of a denominations row, and nothing more.
 *
 * Structurally satisfied by `types/coin.model.ts`'s `Denomination` and by
 * `services/denominations/denomination-index.ts`'s `IndexableDenomination`.
 * Declared here rather than imported so the matcher keeps its long-standing
 * freedom from the rest of the application -- these modules are pure and
 * Node-testable, and that is what lets the whole suite run without jsdom.
 */
export interface LabelledDenomination {
  denominationId: number;
  label: string;
  isActive: boolean;
}

/** `DenominationId` -> `Label`, for the ACTIVE rows of one lookup fetch. */
export type DenominationLabels = ReadonlyMap<number, string>;

/**
 * Freeze the denominations lookup into the id -> Label table the coin side
 * reads.
 *
 * *** SOFT-DELETED ROWS ARE LEFT OUT, DELIBERATELY. *** §4.4 retires a
 * denomination with `IsActive = 0` and nulls the `DenominationId` of every
 * coin using it, so a live id pointing at a retired row should not exist --
 * but if one does, nothing may speak for that row. Leaving it out drops the
 * coin back onto its recorded text, which is both the pre-change behaviour
 * and what `denominationDisplay()` already shows the user for that coin
 * ("the id ... no longer resolves to an active row" -> `Other (25¢)`).
 */
export function denominationLabelSnapshot(
  rows: readonly LabelledDenomination[]
): DenominationLabels {
  const labels = new Map<number, string>();
  for (const row of rows) {
    if (row.isActive) labels.set(row.denominationId, row.label);
  }
  return labels;
}

/**
 * THE ONE PLACE THE LABEL ENTERS THE MATCHER.
 *
 * Answers: which string should the denomination readers be given for this
 * coin? The label when the coin is linked, the recorded text otherwise.
 *
 * WHY A BLANK `Coins.Denomination` IGNORES THE LABEL
 *
 * *** READ match-vetoes.ts UNDER "ONLY A STATED DISAGREEMENT" BEFORE
 * CHANGING THIS. ***
 *
 * A denomination veto needs BOTH SIDES TO SAY SOMETHING. Silence is not
 * disagreement, and a veto is far more destructive than a bad score: it
 * removes the coin from the candidate list, so the user never sees it to
 * correct it.
 *
 * An id beside a BLANK text is a state this application does not create. The
 * editor's write rule sets both fields; §4.4 nulls the id and leaves the text
 * alone; migration 014 resolves FROM the text and never writes it. So a blank
 * text next to a live id is unexplained data, and the pessimistic reading is
 * the right one -- a coin that recorded nothing goes on saying nothing, which
 * costs the user a click instead of silently hiding the right coin.
 *
 * Whitespace counts as blank for the same reason it does in
 * `denominationDisplay()`: a column that has held free text for years holds
 * '   ' somewhere.
 */
function denominationTextOf(coin: CoinRecord, labels?: DenominationLabels | null): string {
  const recorded = String(coin.denomination ?? '');
  if (!recorded.trim()) return recorded;

  const id = coin.denominationId;
  if (id === null || id === undefined || !labels) return recorded;

  const label = labels.get(id);
  return label && label.trim() ? label : recorded;
}

 /*
 * Internal shapes
  */

/** Attributes for ONE side of a comparison (a filename or a coin record). */
export interface Signature {
  year: number | null;
  /** Coins may record a range like "1916-1945"; images never do. */
  yearRangeEnd: number | null;
  mintMark: string | null;
  denomination: string | null;
  denominationLabel: string | null;
  coinTypeTokens: string[];
  grade: string | null;
  certNumbers: string[];
  certCompanies: string[];
  tokens: string[];
  /**
   * How the coin was struck: 'proof', 'business', 'specimen' or 'unknown'.
   *
   * A first-class parsed attribute rather than something re-derived at
   * comparison time, so BOTH sides are read by the identical rules in
   * proof-strike.ts, exactly once each. A stated proof-against-business
   * disagreement is a hard veto (match-vetoes.ts).
   *
   * SAYING NOTHING IS SAYING 'business'. The proof designation is always
   * written into both the file name and the inventory description, so this
   * field is 'unknown' only when the side was EMPTY -- no type, no variety,
   * no notes, no grade -- and 'unknown' is the only value that disagrees with
   * nothing.
   *
   * REMEMBER: a PROOFLIKE / PL / DMPL coin is 'business', not 'proof'. The
   * warning at the top of proof-strike.ts explains why that matters so much.
   */
  strike: StrikeKind;
}

/** A coin record plus its precomputed signature (parsed once per matchImages call). */
export interface CoinSignature {
  coin: CoinRecord;
  label: string;
  signature: Signature;
}

/**
 * Display label for a coin, e.g. "Twenty Cent 1876 — PCGS XF45".
 *
 * WHY THE GRADE AND GRADING COMPANY ARE IN HERE
 * This label is what the image importer puts at the top of each review group,
 * and it is the only thing the user reads when deciding whether a photo
 * belongs to this coin. Without the grade it is often not enough to tell two
 * records apart: a collection can hold an 1876 20¢ in XF45 and another in
 * MS63, and "Twenty Cent 1876" names both of them identically.
 *
 * The grading company matters alongside the grade for the same reason —
 * "PCGS XF45" and "NGC XF45" are different slabs — and because the filenames
 * themselves usually carry it, so showing it lets the eye compare like with
 * like.
 *
 * Everything is optional and omitted when blank, so a raw ungraded coin still
 * reads cleanly as "Twenty Cent 1876" rather than trailing an empty dash.
 *
 * This is DISPLAY ONLY. The matcher scores against `Signature`, never against
 * this string, so enriching it cannot change which coin an image matches.
 */
export function describeCoin(coin: CoinRecord): string {
  const head = [coin.coinType, coin.denomination].filter(Boolean).join(' ').trim();
  const yearPart = [coin.year, coin.mintMark].filter(Boolean).join('-');
  const identity = [head, yearPart].filter(Boolean).join(' ').trim();

  // Grading company then grade, the way a slab label reads.
  const certPart = [coin.certCompany, coin.grade]
    .map(part => (part ?? '').trim())
    .filter(Boolean)
    .join(' ');

  if (!identity) return certPart ? `Coin ${coin.id} — ${certPart}` : `Coin ${coin.id}`;
  return certPart ? `${identity} — ${certPart}` : identity;
}

/**
 * Render a signature's year (or year range) for the explanation text.
 *
 * It lives beside `Signature` rather than with the scorer because three
 * different modules need it -- the scorer, the near-match test and the hard
 * vetoes -- and the vetoes are consulted BY the scorer. Keeping it here is
 * what stops those two files importing each other in a circle.
 */
export function formatYear(signature: Signature): string {
  if (signature.year === null) return 'unknown year';
  return signature.yearRangeEnd && signature.yearRangeEnd !== signature.year
    ? `${signature.year}-${signature.yearRangeEnd}`
    : String(signature.year);
}

/* ===========================================================================
 * COUNTERFEIT RECORDS AND THE AUTOMATED CANDIDATE POOL
 * ---------------------------------------------------------------------------
 * "Ignore the fake coins" cuts BOTH ways, and the second way is easy to miss.
 *
 * The obvious half is the photograph: a picture of a counterfeit must not be
 * filed under a genuine coin (non-coin-detector.ts owns that). The other half
 * is the RECORD. This collection holds counterfeits as inventory rows --
 *
 *     1860 3CS - VF - FAKE
 *     1861 3CS - XF - FAKE
 *     1861 3CS - XF45 - FAKE
 *
 * -- alongside five GENUINE 1861 three-cent silvers. Leave the fakes in the
 * candidate pool and a photograph of a real 1861 3CS can auto-attach to
 * "1861 3CS - XF45 - FAKE", which is the identical error pointing the other
 * way.
 *
 * *** WHY THE FILTER IS HERE AND NOWHERE LOWER DOWN. ***
 * `buildCoinSignatures` is called from exactly one place in the application:
 * `ImageMatchingService.matchImages`. It is the AUTOMATED MATCHER'S view of
 * the inventory and nothing else's. Everything manual reads the inventory
 * directly and is completely unaffected:
 *
 *   - the free-text coin search (`row-decisions.searchCoins`, driven by
 *     `image-import/coin-lookup.ts`) iterates `InventoryService.inventory()`,
 *     so a fake record is still findable and still manually attachable;
 *   - the coin editor, the Add-coin path, the inventory grid, filters,
 *     sorting, reports, totals and melt values never touch this function;
 *   - the per-coin image gallery's add-images path never touches it either.
 *
 * A fake coin may be added to the inventory by hand; it is only the
 * AUTOMATION that ignores it. Putting the filter one level lower -- in the
 * inventory service, or in `searchCoins` -- would take fakes out of the
 * manual search too, and the manual search is the escape hatch the whole rule
 * depends on. There is a test pinning that asymmetry.
 * ========================================================================= */

/**
 * Fields a counterfeit descriptor can honestly live in.
 *
 * `securityName` is not on {@link CoinRecord}; it is carried by the Quicken
 * importer's own record shape, and for this collection it is THE ONLY place
 * the word survives. The fakes import with denomination "3CS", coinType
 * "Three Cent Silver" and grades "VF" / "XF" / "XF45" -- every declared field
 * identical to a genuine coin -- and the "FAKE" that distinguishes them lives
 * only in the raw Quicken security name. So it is read defensively here
 * rather than being ignored for not being in the interface.
 *
 * *** `notes` IS DELIBERATELY ABSENT. ***
 * It holds the Quicken transaction memo, which is prose about dealers and
 * history rather than a descriptor of the coin, and the real data contains
 * exactly the trap that matters:
 *
 *     "Sent 1860 PCI PF 3CS to a dealer (exchange for 1861 3CS FAKE)"
 *
 * That memo is attached to a GENUINE 1860 proof. Reading notes would throw a
 * real coin out of the automated pool because of a sentence about a different
 * coin entirely.
 */
const COUNTERFEIT_RECORD_FIELDS = [
  'coinType', 'variety', 'denomination', 'category', 'coinSet', 'grade', 'securityName'
] as const;

/**
 * Does this inventory record describe a COUNTERFEIT?
 *
 * Whole-token, case-insensitive, over the identity fields above -- the same
 * `\b`-anchored convention the filename side uses, and the same three marker
 * words, so the two sides can never form different opinions about what the
 * word "fake" means. See COUNTERFEIT_MARKER_WORDS in filename-vocabulary.ts
 * for why "copy" is not one of them.
 *
 * Exported so the test suite can assert the asymmetry directly: a record this
 * returns true for must still be searchable and manually attachable.
 */
export function isCounterfeitRecord(coin: CoinRecord): boolean {
  const bag = coin as unknown as Record<string, unknown>;
  const text = COUNTERFEIT_RECORD_FIELDS
    .map(field => (typeof bag[field] === 'string' ? bag[field] as string : ''))
    .filter(Boolean)
    .join(' ');
  if (!text) return false;

  return COUNTERFEIT_MARKER_WORDS.some(word => new RegExp(`\\b${word}\\b`, 'i').test(text));
}

/**
 * Parse each coin exactly once and cache the result for this batch.
 *
 * Counterfeit records are dropped here -- see the long note above for why
 * this function, and only this function, is the right place for that.
 *
 * @param labels the id -> Label snapshot, taken ONCE for the whole import.
 *   Optional, and absent is not an error: an unlinked collection, or a
 *   denominations lookup that has not returned, parses exactly the way it
 *   did before `DenominationId` existed. See the header of this file for why
 *   this is a parameter and not a lookup performed in here.
 */
export function buildCoinSignatures(
  inventory: CoinRecord[],
  labels?: DenominationLabels | null
): CoinSignature[] {
  return inventory
    .filter(coin => !isCounterfeitRecord(coin))
    .map(coin => ({
      coin,
      label: describeCoin(coin),
      signature: parseCoin(coin, labels)
    }));
}

/**
 * Build a signature from a coin RECORD (structured fields), not from a name.
 *
 * We trust the record's own fields first. The only inference is for
 * denomination: many records leave `denomination` blank and stuff everything
 * into `coinType` ("Mercury Dime"), so if `denomination` gives us nothing we
 * look for a denomination inside the type text instead.
 *
 * @param labels optional id -> Label snapshot. When the coin is linked, the
 *   denomination READERS are given the lookup's Label instead of the source
 *   text; everything else about the parse is untouched. See the header of
 *   this file, and `denominationTextOf` for the blank-text carve-out.
 */
export function parseCoin(coin: CoinRecord, labels?: DenominationLabels | null): Signature {
  // -- year (supports "1881", "1916-1945", "c. 1881") --------------------
  const yearMatches = [...String(coin.year ?? '').matchAll(/\d{4}/g)].map(m => Number(m[0]));
  const validYears = yearMatches.filter(y => isPlausibleYear(y));
  const year = validYears.length ? validYears[0] : null;
  const yearRangeEnd = validYears.length > 1 ? validYears[validYears.length - 1] : null;

  /* -- denomination ------------------------------------------------------
   * TWO READERS, AND THE ORDER BETWEEN THEM MATTERS.
   *
   *   readTrustedDenominationText  reads the WHOLE FIELD as a face value with
   *                                a unit: "50 Cents", "20¢", "$20", "½¢".
   *                                Anchored end to end, so it either consumes
   *                                every character or answers null.
   *   findDenomination             scans the TOKENS for a known word pattern:
   *                                "Half Dollar", "Three Cent Nickel", "3CS".
   *
   * The whole-field reader goes FIRST, and it has to. `findDenomination`
   * matches a pattern anywhere in the token list, so it reads the "cent" out
   * of "50 Cents" (tokens ['50','cent']) and reports a ONE CENT piece -- a
   * record holding a perfectly ordinary half dollar was being filed as a
   * penny, and every 50¢ photograph then disagreed on denomination with its
   * own record. Trying the anchored reader first fixes that, and costs
   * nothing: it declines everything it does not fully understand, so
   * "Three Cent", "Dollar" and "3CS" still fall straight through to the word
   * table exactly as before.
   *
   * This is only safe on a RECORD, never on a filename: a denomination COLUMN
   * reading "50 Cents" cannot be anything else, whereas a filename saying the
   * same words might be a stamp or a price. See the header of
   * denomination-units.ts for that distinction.
   *
   * ---------------------------------------------------------------------
   * *** WHICH STRING THE TWO READERS ARE GIVEN ***
   * ---------------------------------------------------------------------
   * `denominationTextOf` answers that: the Label the coin's `denominationId`
   * points at when it is linked, the recorded text when it is not. The
   * readers themselves, the word table, `denominationsAgree`, the vetoes and
   * every threshold are untouched by the substitution.
   *
   * `denomTokens` DELIBERATELY STILL COMES FROM THE RECORDED TEXT. It is not
   * an input to the identity of the coin; it is token EVIDENCE, and it is the
   * evidence the filenames actually carry. A photo is named
   * "1753 Pillar Dollar (8 Reales) - Obverse.jpg"; nobody types a bare
   * "8 Reales" into a filename for a record they call a Pillar Dollar.
   * Replacing the text wholesale would delete 'pillar' from the coin's tokens
   * and from the unrecognised-wording fallback below, and the photograph
   * would lose the only words still tying it to the record. The label is
   * authoritative about WHICH DENOMINATION; it is not a better record of what
   * the source said, and §4.1 keeps both for that reason. */
  const denomTokens = tokenize(coin.denomination ?? '');
  const denominationText = denominationTextOf(coin, labels);
  const readerTokens =
    denominationText === (coin.denomination ?? '') ? denomTokens : tokenize(denominationText);

  let denomination: { key: string; label: string } | null =
    readTrustedDenominationText(denominationText);

  if (!denomination) {
    denomination = findDenomination(readerTokens);
  }

  const typeText = [coin.coinType, coin.variety].filter(Boolean).join(' ');
  const typeTokens = tokenize(typeText);
  let typeRemainder = typeTokens;

  if (denomination) {
    // Denomination came from its own field; the type text keeps all its words
    // except any that merely restate the denomination.
    typeRemainder = removeDenominationTokens(typeTokens, denomination.key);
  } else {
    // Blank / unrecognised denomination field: look inside the type text.
    const inferred = findDenomination(typeTokens);
    if (inferred) {
      denomination = inferred;
      typeRemainder = removeRange(typeTokens, inferred.start, inferred.length);
    } else if (denomTokens.length) {
      // Unknown denomination wording (e.g. a foreign face value). Keep the
      // words as type evidence rather than throwing them away.
      typeRemainder = [...typeTokens, ...denomTokens];
    }
  }

  /* -- WHICH EAGLE? -------------------------------------------------------
   * The record side runs the identical year rule as the filename side, from
   * the identical function, so the two can never form different opinions
   * about which series a coin belongs to. A record reading "Gold Eagle" with
   * year 2015 is a $50 bullion coin; one reading "Eagle" with year 1907 is
   * the classic $10 piece; one with no year stays undecided.
   *
   * DELIBERATELY AFTER the token removal above. `removeDenominationTokens`
   * looks the key's own spellings up in DENOMINATION_RULES to strike them out
   * of the coin-type words, and it has to do that against the key the WORDS
   * produced ('gold eagle') -- resolving first would leave it hunting for
   * "fifty dollar" in a field that says "Gold Eagle" and the words would
   * survive as phantom coin-type evidence.
   *
   * The weight text is the denomination and type fields joined, so a record
   * whose type reads "Gold Eagle 1/4 oz" resolves to the $10 quarter-ounce
   * rather than the $50 default. See reference-tables.ts.
   *
   * THE RECORDED TEXT IS DELIBERATELY WHAT IS SEARCHED HERE, not the
   * resolved label. This argument is hunting for a BULLION WEIGHT ("1/4 oz",
   * "1/10 oz"), and a lookup Label is a short canonical token -- '$10',
   * '50¢' -- that has never carried one. Reading the label instead could only
   * delete a weight the record really stated. */
  denomination = resolveEagleSeries(
    denomination,
    year,
    [coin.denomination, typeText].filter(Boolean).join(' ')
  );

  // Join catalogue references into single tokens the same way the filename
  // parser does, so a record whose variety reads "Sear 6819" produces the
  // token "sear6819" and can match a filename that says the same thing. Both
  // sides MUST fold, or they would never agree -- see catalog-refs.ts.
  const coinTypeTokens = meaningfulTokens(foldCatalogRefs(typeRemainder));

  // -- mint mark ---------------------------------------------------------
  // Records usually hold a bare code ("D"), but accept a spelled-out mint too.
  const rawMint = String(coin.mintMark ?? '').trim().toLowerCase().replace(/[^a-z\s]/g, '');
  const namedMint = MINT_NAMES.find(entry => entry.words.every(w => rawMint.includes(w)));
  const mintMark = MINT_CODES.has(rawMint) ? rawMint : (namedMint ? namedMint.code : (rawMint || null));

  // -- certification -----------------------------------------------------
  const certNumber = String(coin.certNumber ?? '').replace(/\D/g, '');
  const certCompany = String(coin.certCompany ?? '').trim().toLowerCase();

  return {
    year,
    yearRangeEnd,
    mintMark,
    denomination: denomination?.key ?? null,
    /* DISPLAY ONLY -- the scorer never compares this, it only quotes it in
     * the sentence the user reads. It falls back to the AUTHORITATIVE text
     * rather than the recorded one, so a coin the matcher cannot read is
     * still named to the user the way the rest of the application names it:
     * "denomination Dollar ($1) does not match 8 Reales", not
     * "... does not match Pillar Dollar". */
    denominationLabel: denomination?.label ?? (denominationText || null),
    coinTypeTokens,
    // Normalized so "MS-63", "MS 63" and "ms63" all compare equal to the
    // "MS63" a filename would carry. See grade-parser.normalizeGrade.
    grade: normalizeGrade(coin.grade),
    certNumbers: certNumber ? [certNumber] : [],
    certCompanies: certCompany ? [certCompany] : [],
    tokens: [...typeTokens, ...denomTokens],

    /* -- how it was struck ------------------------------------------------
     * The grade decides whenever it can ("PF65RB" is a proof, "MS63" is not),
     * and only a record with NO grade falls back on its descriptive text. A
     * record that has both and mentions neither proof nor SP is a BUSINESS
     * STRIKE -- this is the inventory half of the silence-is-a-statement rule
     * in proof-strike.ts.
     *
     * `notes` is included because on an ungraded record the notes are often
     * the only descriptor there is. It is also the one free-text field here,
     * so if a correct match is ever vetoed as proof-against-business, the
     * notes are the first place to look. The grade-first ordering keeps the
     * blast radius small: a graded coin's notes cannot override its slab. */
    strike: detectStrike(
      [coin.coinType, coin.variety, coin.notes].filter(Boolean).join(' '),
      coin.grade
    )
  };
}
