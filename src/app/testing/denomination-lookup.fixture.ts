/*
 * ONE lookup list for every read-path spec.
 *
 * WHY ONE FIXTURE AND NOT FOUR
 * The grid, the search box, the statistics chart and the printed reports all
 * have to name the same coin the same way. The RULE lives in one module
 * (`denominationDisplay`), but a rule tested against four different invented
 * lookup tables can still give four different answers: give the grid spec a
 * Mexico row and the statistics spec none, and both suites go green while
 * the two screens disagree on screen.
 *
 * So every spec that exercises the read path resolves against THIS list, and
 * the claim "the four areas agree" is a claim about one set of rows.
 *
 * WHY THESE PARTICULAR ROWS
 * They are copied from `server/setup-database.sql` (ids and Country
 * spellings included) rather than invented, and each one is here because it
 * is the only row that can exercise one case:
 *
 *   $1 / 3CS       the ordinary coin with no id. Its text names a row, so it
 *                  must read the same before and after an id is written. 3CS
 *                  additionally proves the alias layer is in play — the
 *                  column holds 'Trime' and the label is '3CS'.
 *   5/- (Crown)    the SHILLING NOTATION case. `formatDenominationDisplay`
 *                  rewrites it as '5 sh (Crown)', and the editor's dropdown
 *                  already renders every option through that function
 *                  (coin-editor-form.html), so a read path that skipped it
 *                  would make the picker and the grid disagree.
 *   8 Reales (MX)  THE hard case: real records file these under Country =
 *                  'United States', so the row can only be reached by
 *                  widening past the country.
 *   100 Soles (PE) the second unresolvable-looking value, kept DISTINCT from
 *                  8 Reales so the statistics spec can prove that
 *                  `Other (8 Reales)` and `Other (100 Soles)` are two
 *                  buckets and not one.
 *   Crown (AU)     ambiguity. Folds onto the same alias key as GB's
 *                  '5/- (Crown)', so a coin reading 'Crown' resolves to
 *                  NOTHING and must read `Other (Crown)` — the honest
 *                  answer, rather than a guessed issuer.
 *   50¢ retired    a soft-deleted row. A coin still pointing at it reads as
 *                  unresolved, because it is.
 *
 * Lives under `src/app/testing/` because that folder is excluded from
 * `tsconfig.app.json` — a test helper must never reach the production build.
 */

import { Denomination } from '../types/coin.model';

/** `Denominations` as the app receives it, trimmed to the interesting rows. */
export const DENOMINATION_LOOKUP: readonly Denomination[] = [
  { denominationId: 4, label: '3CS', country: 'US', sortOrder: 4, isActive: true },
  { denominationId: 9, label: '25¢', country: 'US', sortOrder: 9, isActive: true },
  { denominationId: 11, label: '$1', country: 'US', sortOrder: 11, isActive: true },
  { denominationId: 22, label: '1/-', country: 'GB', sortOrder: 6, isActive: true },
  { denominationId: 26, label: '5/- (Crown)', country: 'GB', sortOrder: 10, isActive: true },
  { denominationId: 61, label: '8 Reales', country: 'Mexico', sortOrder: 1, isActive: true },
  { denominationId: 72, label: '100 Soles', country: 'Peru', sortOrder: 1, isActive: true },
  { denominationId: 83, label: 'Crown', country: 'Australia', sortOrder: 1, isActive: true },
  // Soft-deleted. Present in the list because the server sends inactive
  // rows too, and every consumer has to filter them for itself.
  { denominationId: 10, label: '50¢', country: 'US', sortOrder: 10, isActive: false }
];

/** `8 Reales`, Mexico — resolvable only by widening past the country. */
export const MEXICO_8_REALES = 61;

/** `100 Soles`, Peru. */
export const PERU_100_SOLES = 72;

/** `$1`, United States. */
export const US_DOLLAR = 11;

/** `5/- (Crown)`, Great Britain — the shilling-notation row. */
export const GB_CROWN = 26;

/** `50¢`, soft-deleted. Nothing may resolve to it. */
export const RETIRED_HALF_DOLLAR = 10;
