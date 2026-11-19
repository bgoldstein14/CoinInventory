/*
 * Optgroup headings for the denomination dropdown, derived from the data so no heading is
 * ever empty and no denomination lacks one.
 */

import { Denomination } from '../../types/coin.model';

/**
 * Distinct countries of the active denominations: US first, then alphabetical. Blank countries
 * are dropped rather than becoming an untitled group.
 */
export function denominationCountriesOf(denominations: readonly Denomination[]): string[] {
  const countries = new Set(
    denominations
      .filter(denomination => denomination.isActive && (denomination.country ?? '').trim())
      .map(denomination => denomination.country.trim())
  );

  return [...countries].sort((left, right) => {
    if (left === right) return 0;
    if (left === 'US') return -1;
    if (right === 'US') return 1;
    return left.localeCompare(right);
  });
}
