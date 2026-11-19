/*
 * Maps the many spellings of a denomination found in Coins.Denomination (CSV imports like
 * 'Half Dollar', hand-typed 'trime', QIF '5s', case differences) onto a Denominations lookup label.
 *
 * Only what the <select> shows is affected; the stored text is never rewritten. Spellings that
 * could mean more than one coin are deliberately left unmapped, since showing "Other" is better
 * than silently showing the wrong denomination.
 */

/**
 * Folded spelling -> folded key of a real lookup label ('50¢' folds to '50c'). Mostly taken
 * from the alias list in migration 007.
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
  // 'nickel' and 'half dime' are not aliases of '5c': they are distinct seeded coins, and
  // folding them together would make five-cent resolution ambiguous.
  ['five cents', '5c'],
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

  /* 'trade dollar' is deliberately absent: it is a distinct issue, not the '$1' row. */

  /* 'penny' (US cent vs British penny) and bare 'eagle' (several different coins) are ambiguous. */

  // Fold the labels onto word keys so '5/- (Crown)' and 'crown' match.
  ['1/-', 'shilling'],
  ['2/- (florin)', 'florin'],
  ['2/6 (half crown)', 'half crown'],
  ['5/- (crown)', 'crown'],
  ['halfcrown', 'half crown'],

  /* Forms written by the QIF importer (quicken-import.service.ts). */
  ['5s', 'crown'],
  ['1s', 'shilling']
]);

/**
 * Same substitutions as migration 007: ¢ -> c, ½ -> half, £ -> gbp. Also lower-cases and
 * collapses whitespace.
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
 * Returns the folded key ('50c', '$20') or null. '3 cents' gives '3c', which deliberately
 * matches nothing (three-cent silver and nickel are both real).
 */
function readSpelledFaceValue(folded: string): string | null {
  const cents = /^(\d+(?:\.\d+)?) ?cents?$/.exec(folded);
  if (cents) return `${cents[1]}c`;

  const dollars = /^(\d+(?:\.\d+)?) ?dollars?$/.exec(folded);
  if (dollars) return `$${dollars[1]}`;

  return null;
}

/** Comparable key for a denomination string (lookup label or stored value). */
export function denominationKey(value: string | null | undefined): string {
  const folded = foldSymbols(String(value ?? ''));
  if (!folded) return '';
  return DENOMINATION_ALIASES.get(folded) ?? readSpelledFaceValue(folded) ?? folded;
}

/**
 * Which lookup label is this stored denomination naming?
 *
 * @param value        the coin's Denomination field, exactly as stored
 * @param optionLabels labels of the ACTIVE lookup rows
 * @returns the matching label, or null
 *
 * Only ever returns a member of optionLabels, and an exact match short-circuits the alias
 * table. If several labels fold to the same key, the first wins.
 */
export function resolveDenominationLabel(
  value: string | null | undefined,
  optionLabels: readonly string[]
): string | null {
  const text = String(value ?? '').trim();
  if (text.length === 0) return null;

  // Exact matches are returned unchanged.
  if (optionLabels.includes(text)) return text;

  const key = denominationKey(text);
  if (!key) return null;

  return optionLabels.find(label => denominationKey(label) === key) ?? null;
}
