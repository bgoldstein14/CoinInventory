/**
 * Sorting comparators for the inventory table.
 *
 * WHY THIS FILE EXISTS
 * Sorting a coin collection is not plain alphabetical sorting. "½¢" has to come
 * before "1¢", "2/-" (two shillings) has to come before "5/-", and "Dollar" has
 * to come after "Quarter". All of that knowledge used to sit as private methods
 * on the App component, where it was impossible to read the component without
 * scrolling past 90 lines of denomination lookup tables.
 *
 * These are pure functions — no signals, no Angular, no state — so they are
 * trivial to reason about and to unit test on their own.
 */

/**
 * Case/whitespace-insensitive text comparison that also understands embedded
 * numbers, so "Coin 2" sorts before "Coin 10" instead of after it.
 */
export function compareText(left: string, right: string): number {
  return left.trim().localeCompare(right.trim(), undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Generic column comparator: numbers compare numerically, everything else
 * falls back to the text comparison above.
 */
export function compareColumnValues(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return compareText((left ?? '').toString(), (right ?? '').toString());
}

/**
 * Compares two denomination labels by their real face value, falling back to
 * text order when two labels are worth the same (e.g. "1¢" vs "Penny").
 */
export function compareDenominationValues(left: string, right: string): number {
  const leftValue = parseDenominationValue(left);
  const rightValue = parseDenominationValue(right);

  if (leftValue !== rightValue) {
    return leftValue - rightValue;
  }

  return compareText(left, right);
}

/**
 * Turns a free-text denomination label ("Half Dollar", "2/-", "£5", "3cs")
 * into a number we can sort on.
 *
 * Empty labels sort first (NEGATIVE_INFINITY) and labels we cannot interpret
 * at all sort last (MAX_SAFE_INTEGER), so unknown values never scatter
 * themselves through the middle of the list.
 */
export function parseDenominationValue(value: string): number {
  let normalized = (value ?? '').trim().toLowerCase();
  if (!normalized) return Number.NEGATIVE_INFINITY;

  normalized = normalized.replace(/½/g, '1/2').replace(/¼/g, '1/4').replace(/¾/g, '3/4');
  normalized = normalized.replace(/\s*sh\b/g, '/-');
  normalized = normalized.replace(/\s*shilling\b/g, '/-');

  const directMatches: Array<[string, number]> = [
    ['half cent', 0.005], ['1/2 cent', 0.005], ['1/2c', 0.005], ['1/2¢', 0.005], ['halfpenny', 0.005],
    ['penny', 0.01], ['1 cent', 0.01], ['1¢', 0.01], ['1c', 0.01], ['1p', 0.01], ['cent', 0.01], ['c', 0.01],
    ['1/-', 0.05], ['2/-', 0.1], ['5/-', 0.25],
    ['2 cent', 0.02], ['2¢', 0.02], ['2c', 0.02], ['2p', 0.02],
    ['3 cent', 0.03], ['3¢', 0.03], ['3c', 0.03], ['3p', 0.03], ['3cs', 0.03], ['3cn', 0.03],
    ['5 cent', 0.05], ['5¢', 0.05], ['5c', 0.05], ['5p', 0.05], ['nickel', 0.05],
    ['10 cent', 0.1], ['10¢', 0.1], ['10c', 0.1], ['10p', 0.1], ['dime', 0.1],
    ['20 cent', 0.2], ['20¢', 0.2], ['20c', 0.2], ['20p', 0.2],
    ['25 cent', 0.25], ['25¢', 0.25], ['25c', 0.25], ['25p', 0.25], ['quarter', 0.25],
    ['50 cent', 0.5], ['50¢', 0.5], ['50c', 0.5], ['50p', 0.5], ['half dollar', 0.5],
    ['1 dollar', 1], ['dollar', 1], ['$1', 1], ['£1', 1], ['1 pound', 1], ['1pound', 1],
    ['2 dollar', 2], ['2 dollars', 2], ['$2', 2], ['£2', 2], ['2 pound', 2], ['2pound', 2],
    ['2.50 dollar', 2.5], ['2.5 dollar', 2.5], ['2.50 dollars', 2.5], ['2.5 dollars', 2.5], ['$2.50', 2.5], ['£2.50', 2.5],
    ['3 dollar', 3], ['3 dollars', 3], ['$3', 3], ['£3', 3],
    ['5 dollar', 5], ['5 dollars', 5], ['$5', 5], ['£5', 5],
    ['10 dollar', 10], ['10 dollars', 10], ['$10', 10], ['£10', 10],
    ['20 dollar', 20], ['20 dollars', 20], ['$20', 20], ['£20', 20],
    ['50 dollar', 50], ['50 dollars', 50], ['$50', 50], ['£50', 50],
    ['100 dollar', 100], ['100 dollars', 100], ['$100', 100], ['£100', 100]
  ];

  // Add the two modern bullion face values alongside the classic series.
  directMatches.push(['25 dollar', 25], ['25 dollars', 25], ['$25', 25], ['£25', 25]);

  /* -----------------------------------------------------------------------
   * MATCH THE LONGEST PATTERN, NOT THE FIRST ONE LISTED
   * -----------------------------------------------------------------------
   * This loop used to walk `directMatches` in order and take the first entry
   * whose text appeared ANYWHERE in the label. Because the list runs smallest
   * face value first, a short pattern reliably shadowed a longer one that
   * started the same way, and the result was silently wrong sorting:
   *
   *     "$10"   contains "$1"   -> sorted as one dollar
   *     "$20"   contains "$2"   -> sorted as two dollars
   *     "$2.50" contains "$2"   -> sorted as two dollars
   *     "$50"   contains "$5"   -> sorted as five dollars
   *     "25¢"   contains "5¢"   -> sorted as five cents
   *
   * Four of those are denominations the database actually seeds, so this was
   * live: quarters sorted among the nickels and Double Eagles among the $2
   * pieces. Nothing failed, the rows were just in the wrong order, which is
   * exactly the kind of bug that survives for years.
   *
   * Two passes fix it without having to hand-order the table:
   *   1. an EXACT match wins outright -- "$5" is five dollars, full stop;
   *   2. otherwise the LONGEST matching pattern wins, so "$10" prefers "$10"
   *      over "$1" no matter where either sits in the list.
   *
   * Keeping the table in ascending face-value order is then purely for human
   * readability, and reordering it can no longer change any answer.
   * --------------------------------------------------------------------- */
  for (const [pattern, amount] of directMatches) {
    if (normalized === pattern) return amount;
  }

  let best: { amount: number; length: number } | null = null;
  for (const [pattern, amount] of directMatches) {
    if (normalized.includes(pattern) && (!best || pattern.length > best.length)) {
      best = { amount, length: pattern.length };
    }
  }
  if (best) return best.amount;

  const fractionalMatch = normalized.match(/(\d+)\/(\d+)/);
  if (fractionalMatch) {
    return Number(fractionalMatch[1]) / Number(fractionalMatch[2]);
  }

  const numericMatch = normalized.match(/\d+(?:\.\d+)?/);
  if (numericMatch) {
    const number = Number(numericMatch[0]);
    if (normalized.includes('p') && !normalized.includes('£')) return number / 100;
    if (normalized.includes('¢') || normalized.includes('c')) return number / 100;
    if (normalized.includes('$') || normalized.includes('dollar') || normalized.includes('pound')) return number;
    if (normalized.includes('cent')) return number / 100;
    return number;
  }

  return Number.MAX_SAFE_INTEGER;
}
