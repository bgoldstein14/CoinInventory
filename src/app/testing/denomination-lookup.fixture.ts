/*
 * The shared denomination lookup for every read-path spec (grid, search,
 * statistics, reports), so they all resolve against the same rows. Rows are
 * copied from `server/setup-database.sql`; each covers one case:
 *
 *   $1 / 3CS       ordinary coins; 3CS also exercises aliases ('Trime' -> '3CS')
 *   5/- (Crown)    shilling notation, displayed as '5 sh (Crown)'
 *   8 Reales (MX)  records filed under 'United States'; reachable only by
 *                  widening past the country
 *   100 Soles (PE) a second distinct unresolved value
 *   Crown (AU)     shares an alias key with GB's '5/- (Crown)', so 'Crown' is
 *                  ambiguous and resolves to nothing
 *   50¢ retired    soft-deleted; coins pointing at it read as unresolved
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
  // Soft-deleted. The server sends inactive rows too; consumers filter them.
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
