 /*
 * denomination-countries.ts — which <optgroup> headings the denomination
 * dropdown should show.
 *
 * The headings are DERIVED FROM THE DATA rather than hard-coded. A group
 * exists if and only if some active denomination belongs to it, which makes
 * two failures impossible by construction: an <optgroup> heading rendered with
 * nothing under it, and a denomination filed under a country with no heading
 * to live in (the Categories & Sets dialog can create one under any code it
 * offers).
 *
 * It is a separate file, rather than a method on the component, purely so it
 * can be unit-tested: CoinEditorForm takes a required signal input, which
 * needs TestBed and a DOM to construct, and this suite runs under Node.
  */

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
