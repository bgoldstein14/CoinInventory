/* ===========================================================================
 * denomination-countries.ts — which <optgroup> headings the denomination
 * dropdown should show.
 * ---------------------------------------------------------------------------
 * THE BUG THIS EXISTS TO PREVENT
 * ---------------------------------------------------------------------------
 * The coin editor groups its denomination dropdown by country. The template
 * used to loop a hard-coded `['US', 'GB']` and, inside each group, filter the
 * denominations down to the ones whose `country` matched.
 *
 * That has an ugly failure mode: if no denomination matches a heading, the
 * heading still renders — an <optgroup> with nothing in it. The owner hit
 * exactly this and reported that the dropdown "doesn't list anything but the
 * countries". The Settings dialog had rewritten every denomination's country
 * to 'United States', which matched neither 'US' nor 'GB', so both groups
 * emptied out and all that was left was two labels.
 *
 * The mirror-image failure was live too: the Categories & Sets dialog offers
 * 'CA' when adding a denomination, but 'CA' was not in the hard-coded pair, so
 * such a denomination could be created and then never appear anywhere.
 *
 * Deriving the headings from the data makes both impossible by construction.
 * A group exists if and only if some active denomination belongs to it, so
 * there can never be an empty heading, and never an entry with no heading to
 * live under.
 *
 * It is a separate file, rather than a method on the component, purely so it
 * can be unit-tested: CoinEditorForm takes a required signal input, which
 * needs TestBed and a DOM to construct, and this suite runs under Node.
 * =========================================================================== */

import { Denomination } from '../../types/coin.model';

/**
 * The distinct countries of the ACTIVE denominations, ordered for display.
 *
 * Inactive rows are excluded because the template does not render them either.
 * Counting them would be the empty-heading bug all over again: a group whose
 * only members are retired would show a heading with nothing beneath it.
 *
 * Blank and whitespace-only countries are dropped rather than becoming a
 * nameless group. A denomination with no country is not reachable from this
 * dropdown, which is a real (if unlikely) gap worth knowing about — but an
 * untitled <optgroup> would be a worse answer than leaving it out.
 *
 * US sorts first because this is a US collection and it is the overwhelming
 * majority of the list; everything else follows alphabetically.
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
