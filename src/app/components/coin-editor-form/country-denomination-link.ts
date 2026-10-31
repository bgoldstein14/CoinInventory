/* ===========================================================================
 * country-denomination-link.ts — Country and Denomination, aware of each other
 * ---------------------------------------------------------------------------
 * WHAT THE OWNER ASKED FOR
 * ---------------------------------------------------------------------------
 *   "If a coin is being added from Great Britain, then only the British
 *    denominations should be available... If the denomination is entered
 *    first then the country should be automatically chosen/entered."
 *
 * Two directions, and they are NOT symmetrical:
 *
 *   COUNTRY -> DENOMINATIONS   is a filter. It only changes what is OFFERED.
 *                              It never writes anything to the coin.
 *   DENOMINATION -> COUNTRY    is a write, and therefore the cautious one.
 *                              It fills the Country field ONLY when that
 *                              field is empty.
 *
 * ---------------------------------------------------------------------------
 * THE NON-OBVIOUS PART: THE TWO SIDES DO NOT SPEAK THE SAME LANGUAGE
 * ---------------------------------------------------------------------------
 * You cannot write `denomination.country === coin.country`. It is false for
 * every single row in the database, because the two columns store a country
 * in two different formats:
 *
 *     Denominations.Country   holds a TWO-LETTER CODE   -> 'US', 'GB'
 *     Coins.Country           holds a FULL NAME          -> 'United States'
 *
 * The seed data has 16 denominations filed under 'US' and 22 under 'GB';
 * every coin-creation path in the app writes 'United States'. Both are
 * long-standing and neither is being migrated.
 *
 * The bridge is `resolveCountryName()` in services/coin-countries.ts, which
 * turns ANY of those spellings — plus free text such as 'uk' or 'British' —
 * into one canonical name. Every comparison in this file goes through it (as
 * `isSameCountry`), so 'GB' and 'Great Britain' compare equal and the user
 * can type the country however they like.
 *
 * That file was chosen rather than a new country list because it already
 * holds the canonical spellings and the matching patterns, built for the QIF
 * importer. A second vocabulary here would be a second thing to keep in step.
 *
 * ---------------------------------------------------------------------------
 * THE TWO RULES THAT STOP THIS LOSING DATA
 * ---------------------------------------------------------------------------
 * 1. NEVER SHOW AN EMPTY DROPDOWN. If the country is blank, or is something
 *    this app has never heard of, or is a country with no denominations on
 *    file, the dropdown falls back to showing EVERYTHING grouped by country —
 *    exactly as it behaved before. Filtering an unrecognised country down to
 *    nothing would leave the user unable to pick anything at all.
 *
 * 2. NEVER SILENTLY DROP THE DENOMINATION THE COIN ALREADY HAS. A coin with
 *    a GB denomination whose country is then edited to the United States has
 *    a value that is outside the filter. It is NOT cleared and it does NOT
 *    vanish from the list: it is kept, still selected, in its own clearly
 *    labelled group so the user can see what is there and decide. Silently
 *    blanking a saved field is the worst outcome available here.
 * =========================================================================== */

import { countryDisplayName, isSameCountry, resolveCountryName } from '../../services/coin-countries';
import { Denomination } from '../../types/coin.model';
import { denominationCountriesOf } from './denomination-countries';

/** One <option> in the denomination dropdown. */
export interface DenominationOption {
  /** The stored value — exactly what goes into `coin.denomination`. */
  label: string;
  /**
   * True when this entry does not belong to the coin's current country and is
   * only here because the coin is already using it. Rule 2 above. The template
   * marks it so the mismatch is visible rather than silent.
   */
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
 * Everything, grouped by country, in the order the dropdown has always used.
 *
 * This is the fallback shape — what the dropdown showed before this feature
 * existed, and what it still shows whenever the country gives us nothing to
 * filter on. Group ordering is delegated to `denominationCountriesOf`, which
 * already derives headings from the data (US first, then alphabetical) and is
 * tested separately.
 */
function allGroupedByCountry(denominations: readonly Denomination[]): DenominationOptionGroup[] {
  const active = activeDenominations(denominations);

  return denominationCountriesOf(denominations).map((country) => ({
    // 'GB' reads as 'Great Britain'; anything unrecognised is shown as stored.
    heading: countryDisplayName(country),
    options: active
      .filter((denomination) => denomination.country.trim() === country)
      .map((denomination) => ({ label: denomination.label, outOfCountry: false }))
  }));
}

/**
 * The denomination dropdown's contents for a given coin.
 *
 * @param denominations     the full lookup table, active and inactive
 * @param coinCountry       the coin's Country field, exactly as the user left
 *                          it — free text, possibly blank, possibly a code,
 *                          possibly something nobody recognises
 * @param currentDenomination the coin's Denomination field, so an existing
 *                          value outside the filter can be kept visible
 *
 * The decision tree, in order, with the bail-out at every step being "show
 * everything" rather than "show nothing":
 *
 *   country is blank              -> everything, grouped by country
 *   country does not resolve      -> everything (we have no basis to filter)
 *   country resolves but no
 *     denominations match it      -> everything (filtering would empty the
 *                                    list; Peru has no rows on file)
 *   otherwise                     -> just that country's denominations,
 *                                    plus the coin's existing value if it
 *                                    happens to fall outside them
 */
export function denominationOptionGroups(
  denominations: readonly Denomination[],
  coinCountry: string | null | undefined,
  currentDenomination: string | null | undefined
): DenominationOptionGroup[] {
  const countryText = String(coinCountry ?? '').trim();

  // Rule 1, first gate: nothing to filter on.
  if (!countryText) return allGroupedByCountry(denominations);

  // Rule 1, second gate: a country we cannot place. 'Ruritania' must still
  // leave the user able to choose a denomination.
  const canonical = resolveCountryName(countryText);
  if (!canonical) return allGroupedByCountry(denominations);

  const active = activeDenominations(denominations);
  const matching = active.filter((denomination) => isSameCountry(denomination.country, countryText));

  // Rule 1, third gate: a country we DO recognise but have no denominations
  // for — Peru, say, which the country vocabulary knows but the Denominations
  // table has never had a row for. Filtering here would empty the dropdown.
  if (matching.length === 0) return allGroupedByCountry(denominations);

  const groups: DenominationOptionGroup[] = [
    {
      heading: countryDisplayName(canonical),
      options: matching.map((denomination) => ({ label: denomination.label, outOfCountry: false }))
    }
  ];

  // Rule 2: the coin's existing denomination belongs to a different country.
  //
  // This is the data-loss case the whole feature most needs to get right: the
  // coin is saved with 'Sovereign' (GB) and the user edits the country to the
  // United States. 'Sovereign' is now outside the filter, and if it simply
  // disappeared from the <select> the browser would show a blank box — the
  // user would believe the field had been emptied, and the next thing they
  // picked would overwrite it for real.
  //
  // So it is kept, in its own group, flagged. Note this only applies to a
  // KNOWN denomination: a value that is in no group at all is a custom one,
  // and custom-option-mode.ts already handles it by opening the text box.
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
 * What to write when the user picks a denomination.
 *
 * Returns a LIST of single-field updates, never a combined patch. The caller
 * sends each one through the ordinary one-field-at-a-time save path. That is
 * a hard rule in this app rather than a style preference: a wider payload has
 * previously overwritten fields the user never touched, so "two fields
 * changed" must still mean "two separate single-field writes".
 *
 * The denomination is always written. The country is appended only when ALL
 * of these hold:
 *
 *   - the coin's Country field is currently BLANK. A country the user typed
 *     outranks one we inferred, always. If they have written 'Canada' and
 *     then pick a GB denomination, their text is left exactly as it is — we
 *     do not correct them, and we do not ask.
 *   - the chosen denomination is a known row with a country we can resolve.
 *     We write the canonical FULL NAME ('Great Britain'), never the raw code
 *     from the lookup table, because coins store full names — writing 'GB'
 *     into a coin would be creating the very mismatch this file bridges.
 *   - the label is not ambiguous. If two rows share a label under different
 *     countries, we have no way to know which was meant, so we write nothing
 *     and leave the user to it. Same conservatism as coin-countries.ts, which
 *     refuses to guess 'Mexico' from a bare '50 Pesos'.
 */
export function denominationChoiceUpdates(
  denominationLabel: string,
  currentCountry: string | null | undefined,
  denominations: readonly Denomination[]
): CoinFieldUpdate[] {
  const updates: CoinFieldUpdate[] = [{ field: 'denomination', value: denominationLabel }];

  // The user has already said what country this is. Their answer stands.
  if (String(currentCountry ?? '').trim()) return updates;

  const label = String(denominationLabel ?? '').trim();
  if (!label) return updates;

  const matches = activeDenominations(denominations).filter((denomination) => denomination.label === label);
  if (matches.length === 0) return updates;

  // Resolve every match and see whether they agree on exactly one country.
  const resolved = matches.map((denomination) => resolveCountryName(denomination.country));

  // One of them is filed under something unplaceable (a typo, a made-up code).
  // We have no full name to write, so we write nothing rather than a guess.
  if (resolved.some((name) => name === '')) return updates;

  const canonicals = new Set(resolved);
  if (canonicals.size !== 1) return updates;

  const [country] = [...canonicals];
  updates.push({ field: 'country', value: country });
  return updates;
}
