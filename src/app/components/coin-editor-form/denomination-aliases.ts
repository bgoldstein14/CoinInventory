/* ===========================================================================
 * denomination-aliases.ts — one coin, many spellings, one lookup row
 * ---------------------------------------------------------------------------
 * THE BUG THIS EXISTS TO FIX
 * ---------------------------------------------------------------------------
 *   "When I bring up certain coins for their detail screen, their
 *    denomination doesn't automatically show, it shows Other, like when I
 *    brought up the 1866 3CS NGC PF65 CAC. I brought up another 3CS, same
 *    thing. Not sure if this is across the board though."
 *
 * It is not across the board, and that is the clue. The Denomination dropdown
 * decides "this value is custom, open the Other box" in `custom-option-mode.ts`
 * with one line:
 *
 *     return !optionLabels.includes(text);
 *
 * `Array.includes` is an EXACT, CASE-SENSITIVE string comparison, and the two
 * sides of it are not written by the same hand:
 *
 *   Denominations.Label   is a short canonical token chosen once, in
 *                         setup-database.sql: '3CS', '50¢', '25¢', '$1',
 *                         '5/- (Crown)'.
 *   Coins.Denomination    is NVARCHAR(100) of whatever anyone ever put there.
 *
 * Three documented sources fill that column with something else:
 *
 *   THE CSV IMPORTER. docs/csv-import-guide.md tells the user, in its own
 *   worked example, to write `Dollar`, `Quarter`, `Half Dollar`. Those are
 *   stored verbatim. Not one of them is a lookup label.
 *
 *   ROWS TYPED BY HAND, before the dropdown existed. The alias CASE in
 *   server/migrations/007-infer-coin-metal-data.sql says so outright: "the
 *   coin editor's dropdown produces the canonical forms, but the CSV importer
 *   accepts free text and older rows were typed by hand, so the spelled-out
 *   names are folded onto the same keys". That CASE — thirty spellings,
 *   'three cent silver' and 'trime' among them — is this collection's own
 *   catalogue of what is really in the column, and it is where most of the
 *   table below comes from.
 *
 *   THE QIF IMPORTER ITSELF, for Great Britain. quicken-import.service.ts
 *   writes '5s' for a crown and '1s' for a shilling; the lookup spells those
 *   '5/- (Crown)' and '1/-'. Every British crown in the collection has
 *   therefore always landed in the custom box. (A sweep of all seven QIF
 *   accounts — 457 coins — finds exactly one, "1889 1 Crown".)
 *
 * Case alone is enough to trigger it, too: features/inventory/
 * denomination-sort.ts lists '3cs' in lower case among the spellings it
 * expects to meet, and '3cs' is not '3CS'.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES
 * ---------------------------------------------------------------------------
 * `resolveDenominationLabel` answers one question: WHICH ROW OF THE LOOKUP,
 * IF ANY, IS THIS STORED STRING NAMING? Both sides are reduced to the same
 * key — symbols folded, case dropped, spelled-out names translated — and
 * compared on that.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT ADD THE SPELLINGS TO THE LOOKUP TABLE INSTEAD
 * ---------------------------------------------------------------------------
 * Migration 009 added '$25' and '$50' as rows, and that was right: those face
 * values had NO row, so a Gold Eagle could not be filed at all. These are the
 * opposite case. '50¢' and 'Half Dollar' are the same coin, and a migration
 * adding the second one would put BOTH in the dropdown — two entries for one
 * denomination, with new coins filed under whichever the user happened to
 * click. That makes the data worse, permanently, to fix a display fault.
 *
 * ---------------------------------------------------------------------------
 * AND WHY THE COIN'S STORED VALUE IS NOT REWRITTEN
 * ---------------------------------------------------------------------------
 * The obvious alternative is a migration that UPDATEs Coins.Denomination to
 * the canonical label. That is lossy and irreversible: "Trade Dollar" and
 * "Pillar Dollar" and "100 Soles" are in the same column, a rewrite has to
 * decide about all of them, and anything it gets wrong is gone. This layer
 * changes only what the <select> SHOWS. The stored string is untouched until
 * the user picks something themselves — which is exactly how
 * `CustomOptionMode.selectValue` already treats the "Other" sentinel.
 *
 * The consequence is worth stating plainly: a coin stored as "Half Dollar"
 * will display as 50¢ and stay stored as "Half Dollar". If the user then
 * re-picks 50¢ from the dropdown, '50¢' is written — a normalisation they
 * performed, not one done behind their back.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY *NOT* AN ALIAS
 * ---------------------------------------------------------------------------
 * Every omission below is someone else's decision, copied rather than
 * re-argued. Guessing here would be worse than showing "Other", because
 * "Other" is visible and a wrong denomination is not.
 * =========================================================================== */

/**
 * Spellings that mean a lookup row, mapped onto that row's own folded key.
 *
 * The keys on the LEFT are post-`foldSymbols` text (lower case, symbols
 * folded, spaces collapsed). The values on the RIGHT are the folded form of
 * a real `Denominations.Label` — '50c' is what '50¢' folds to, 'crown' is
 * what '5/- (Crown)' folds to. Nothing here names a label directly, which is
 * what lets the lookup table be renamed or trimmed without this table lying.
 *
 * Taken from the alias CASE in migration 007 unless marked otherwise.
 */
const DENOMINATION_ALIASES: ReadonlyMap<string, string> = new Map([
  // ---- United States, spelled out -------------------------------------
  ['cent', '1c'],
  ['one cent', '1c'],
  ['large cent', '1c'],
  ['half cent', 'halfc'],
  ['two cent', '2c'],
  ['two cents', '2c'],
  ['three cent silver', '3cs'],
  ['trime', '3cs'],
  ['three cent nickel', '3cn'],
  ['nickel', '5c'],
  ['five cents', '5c'],
  ['half dime', '5c'],
  ['dime', '10c'],
  ['ten cents', '10c'],
  ['twenty cent', '20c'],
  ['twenty cents', '20c'],
  ['quarter', '25c'],
  ['quarter dollar', '25c'],
  ['half dollar', '50c'],
  ['fifty cents', '50c'],
  ['dollar', '$1'],
  ['one dollar', '$1'],
  ['silver dollar', '$1'],
  ['quarter eagle', '$2.50'],
  ['three dollar', '$3'],
  ['half eagle', '$5'],
  ['double eagle', '$20'],

  /* 'trade dollar' is in migration 007's list and is deliberately NOT here.
   * 007 is working out an ALLOY, and a Trade Dollar is 90% silver like every
   * other dollar, so folding it onto '$1' costs that script nothing. This
   * file is working out a DENOMINATION, and the Trade Dollar is a distinct
   * issue — 420 grains, struck for the Orient, not the 412.5-grain dollar the
   * lookup's '$1' row stands for. custom-option-mode.ts uses it as its worked
   * example of a value that SHOULD open the custom box; that stays true. */

  /* 'penny' and 'eagle' are absent for the reasons migration 007 gives, which
   * are reproduced here because they are easy to "fix" by mistake:
   *   penny  means the US cent to an American and the British penny to
   *          everyone else, and their alloys part company in 1943.
   *   eagle  a Gold Eagle, a Silver Eagle and the classic $10 Eagle are three
   *          different coins. The specific forms above are safe; the bare
   *          word is not. */

  // ---- Great Britain ---------------------------------------------------
  // These fold the LABELS onto word keys, so that '5/- (Crown)' and the word
  // 'crown' meet in the middle.
  ['1/-', 'shilling'],
  ['2/- (florin)', 'florin'],
  ['2/6 (half crown)', 'half crown'],
  ['5/- (crown)', 'crown'],
  ['halfcrown', 'half crown'],

  /* NOT from migration 007: the two forms the QIF importer itself writes.
   * quicken-import.service.ts answers '5s' to /\bcrown\b/ and '1s' to
   * /\bshilling\b/, so these are not hypothetical spellings — they are what
   * this application puts in the column. */
  ['5s', 'crown'],
  ['1s', 'shilling']
]);

/**
 * Fold the symbols the lookup labels are written with.
 *
 * The same three substitutions migration 007 makes before its own alias
 * lookup, and for the same reason: the column and the lookup disagree about
 * notation, not about coins.
 *
 *     ¢  ->  c        '50¢'          -> '50c'
 *     ½  ->  half     '½¢' / '½ Sovereign' -> 'halfc' / 'half sovereign'
 *     £  ->  gbp      '£5'           -> 'gbp5'
 *
 * Case is dropped and runs of whitespace collapse to one space, so
 * 'Half   Dollar' and 'half dollar' are the same thing.
 */
function foldSymbols(text: string): string {
  return text
    .replace(/¢/g, 'c')
    .replace(/½/g, 'half')
    .replace(/£/g, 'gbp')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Read a face value written as words — "50 Cents", "20 Dollars".
 *
 * coin-signature.ts names "50 Cents" as a real value of this column, and
 * denomination-sort.ts carries a dozen more of the same shape. They are a
 * family rather than a list, so they get a rule rather than a table row.
 *
 * Returns the folded key ('50c', '$20') or null if the text is not of that
 * shape. The number is passed through verbatim, so '2.50 dollars' answers
 * '$2.50' and matches the label, while '3 cents' answers '3c' and matches
 * nothing — which is right, because the three-cent silver and the three-cent
 * nickel are both real and a bare "3 cent" does not say which.
 */
function readSpelledFaceValue(folded: string): string | null {
  const cents = /^(\d+(?:\.\d+)?) ?cents?$/.exec(folded);
  if (cents) return `${cents[1]}c`;

  const dollars = /^(\d+(?:\.\d+)?) ?dollars?$/.exec(folded);
  if (dollars) return `$${dollars[1]}`;

  return null;
}

/**
 * The comparable form of one denomination string — lookup label or stored
 * coin value, the function does not care which.
 *
 * Exported for the tests, and because it is the honest way to ask "are these
 * two denominations the same coin?" anywhere else that ever needs to.
 */
export function denominationKey(value: string | null | undefined): string {
  const folded = foldSymbols(String(value ?? ''));
  if (!folded) return '';
  return DENOMINATION_ALIASES.get(folded) ?? readSpelledFaceValue(folded) ?? folded;
}

/**
 * Which lookup label is this stored denomination naming?
 *
 * @param value        the coin's Denomination field, exactly as stored
 * @param optionLabels the labels the dropdown is currently offering — i.e.
 *                     `Denominations.Label` for every ACTIVE row
 * @returns the matching label, or null when there is no row for this value
 *
 * TWO PROPERTIES THIS GUARANTEES, BOTH LOAD-BEARING
 *
 *   IT ONLY EVER RETURNS A MEMBER OF `optionLabels`. It cannot invent a
 *   denomination. On a database whose lookup rows have been renamed or
 *   deactivated through the Settings dialog, an alias with no surviving row
 *   answers null and the custom box opens holding the stored text — the old
 *   behaviour, which is the correct one once the row is really gone. Handing
 *   back a label with no <option> would render the select blank instead.
 *
 *   AN EXACT MATCH IS ANSWERED WITHOUT CONSULTING THE TABLE AT ALL. A coin
 *   already holding a canonical label takes the first branch, so the 451 of
 *   457 QIF-imported coins that were always fine cannot be affected by
 *   anything in this file.
 *
 * If two active rows fold to the same key — the Settings dialog can create a
 * second row with an equivalent label — the first in `optionLabels` wins.
 * They are the same denomination by definition, so either is a correct
 * answer, and picking one deterministically beats returning nothing.
 */
export function resolveDenominationLabel(
  value: string | null | undefined,
  optionLabels: readonly string[]
): string | null {
  const text = String(value ?? '').trim();
  if (text.length === 0) return null;

  // Fast path, and a promise: a value that is already a label is untouched.
  if (optionLabels.includes(text)) return text;

  const key = denominationKey(text);
  if (!key) return null;

  return optionLabels.find(label => denominationKey(label) === key) ?? null;
}
