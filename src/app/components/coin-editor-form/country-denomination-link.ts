/*
 * Links the Country and Denomination fields.
 *
 * - Country -> denominations only changes what is offered; it never writes.
 * - Denomination -> country fills Country only when it is blank.
 *
 * Denominations.Country stores codes ('US', 'GB') while Coins.Country stores names
 * ('United States'), so every comparison goes through resolveCountryName()/isSameCountry().
 *
 * The dropdown is never narrowed to nothing, and the coin's existing denomination is never
 * dropped. denominationOptionGroups no longer renders anything; it is kept with its tests as
 * coverage for preferredDenominationCountries, which the picker uses.
 */

import { countryDisplayName, isSameCountry, resolveCountryName } from '../../services/coin-countries';
import { Denomination } from '../../types/coin.model';
import { denominationCountriesOf } from './denomination-countries';

/** One <option> in the denomination dropdown. */
export interface DenominationOption {
  /** The stored value — exactly what goes into `coin.denomination`. */
  label: string;
  /** True when this entry is outside the coin's country and only listed because the coin uses it. */
  outOfCountry: boolean;
}

/** One <optgroup>: a heading and the options under it. */
export interface DenominationOptionGroup {
  /** The heading text, already humanised — 'GB' is shown as 'Great Britain'. */
  heading: string;
  /** Never empty. A group with no options would render as a bare heading. */
  options: DenominationOption[];
}

/** A single field write, for {@link denominationChoiceUpdates}. */
export interface CoinFieldUpdate {
  field: 'denomination' | 'country';
  value: string;
}

/** The active, usable rows. Inactive ones are not rendered anywhere. */
function activeDenominations(denominations: readonly Denomination[]): Denomination[] {
  return denominations.filter((denomination) => denomination.isActive);
}

/**
 * Everything, grouped by country (US first, then alphabetical). Used when the country gives
 * nothing to filter on.
 */
function allGroupedByCountry(denominations: readonly Denomination[]): DenominationOptionGroup[] {
  const active = activeDenominations(denominations);

  return denominationCountriesOf(denominations).map((country) => ({
    heading: countryDisplayName(country),
    options: active
      .filter((denomination) => denomination.country.trim() === country)
      .map((denomination) => ({ label: denomination.label, outOfCountry: false }))
  }));
}

/**
 * Which lookup country values ('US', not 'United States') the coin's country refers to.
 *
 * An empty result means "show everything", never "show nothing". Shared with
 * denomination-picker.ts so both apply the same rules.
 */
export function preferredDenominationCountries(
  denominations: readonly Denomination[],
  coinCountry: string | null | undefined
): string[] {
  const countryText = String(coinCountry ?? '').trim();

  // Gate 1: nothing to filter on.
  if (!countryText) return [];

  // Gate 2: a country we cannot place.
  if (!resolveCountryName(countryText)) return [];

  const matching = activeDenominations(denominations)
    .filter((denomination) => isSameCountry(denomination.country, countryText))
    .map((denomination) => denomination.country.trim());

  // Gate 3: a recognised country with no denominations on file.
  if (matching.length === 0) return [];

  return [...new Set(matching)];
}

/**
 * Denomination dropdown groups for a coin.
 *
 * @param denominations       the full lookup table, active and inactive
 * @param coinCountry         the coin's Country field as entered (may be blank or unrecognised)
 * @param currentDenomination the coin's Denomination, kept visible even outside the filter
 */
export function denominationOptionGroups(
  denominations: readonly Denomination[],
  coinCountry: string | null | undefined,
  currentDenomination: string | null | undefined
): DenominationOptionGroup[] {
  const countryText = String(coinCountry ?? '').trim();

  // No basis to narrow: show everything.
  const preferred = new Set(preferredDenominationCountries(denominations, coinCountry));
  if (preferred.size === 0) return allGroupedByCountry(denominations);

  const canonical = resolveCountryName(countryText);
  const active = activeDenominations(denominations);
  const matching = active.filter((denomination) => preferred.has(denomination.country.trim()));

  const groups: DenominationOptionGroup[] = [
    {
      heading: countryDisplayName(canonical),
      options: matching.map((denomination) => ({ label: denomination.label, outOfCountry: false }))
    }
  ];

  // The coin's existing denomination belongs to another country: keep it in its own group so the
  // select does not render blank. Unknown values are handled by the custom box instead.
  const existing = String(currentDenomination ?? '').trim();
  const existingIsOffered = matching.some((denomination) => denomination.label === existing);
  const existingRow = active.find((denomination) => denomination.label === existing);

  if (existing && !existingIsOffered && existingRow) {
    groups.push({
      heading: `On this coin (${countryDisplayName(existingRow.country)})`,
      options: [{ label: existingRow.label, outOfCountry: true }]
    });
  }

  return groups;
}

/**
 * Returns single-field updates (never a combined patch). The denomination is always written;
 * the country is added only when the coin's Country is blank and the label maps to exactly
 * one resolvable country. The canonical full name is written, never the lookup code.
 */
export function denominationChoiceUpdates(
  denominationLabel: string,
  currentCountry: string | null | undefined,
  denominations: readonly Denomination[]
): CoinFieldUpdate[] {
  const updates: CoinFieldUpdate[] = [{ field: 'denomination', value: denominationLabel }];

  // Keep a country the user already entered.
  if (String(currentCountry ?? '').trim()) return updates;

  const label = String(denominationLabel ?? '').trim();
  if (!label) return updates;

  const matches = activeDenominations(denominations).filter((denomination) => denomination.label === label);
  if (matches.length === 0) return updates;

  const resolved = matches.map((denomination) => resolveCountryName(denomination.country));

  // An unresolvable country: write nothing rather than guess.
  if (resolved.some((name) => name === '')) return updates;

  const canonicals = new Set(resolved);
  if (canonicals.size !== 1) return updates;

  const [country] = [...canonicals];
  updates.push({ field: 'country', value: country });
  return updates;
}
