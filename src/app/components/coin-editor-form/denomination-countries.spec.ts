/**
 * Tests for the denomination dropdown's country groupings.
 *
 * The reported symptom was a dropdown that "doesn't list anything but the
 * countries": two <optgroup> headings with no options under either. The cause
 * was a hard-coded ['US', 'GB'] in the template meeting denominations whose
 * country had been rewritten to 'United States', so neither group matched
 * anything but both still rendered.
 */
import { describe, expect, it } from 'vitest';
import { Denomination } from '../../types/coin.model';
import { denominationCountriesOf } from './denomination-countries';

function denomination(overrides: Partial<Denomination> = {}): Denomination {
  return {
    denominationId: 1,
    label: '1¢',
    country: 'US',
    sortOrder: 1,
    isActive: true,
    ...overrides
  };
}

describe('denominationCountriesOf', () => {
  it('returns the distinct countries actually present', () => {
    const countries = denominationCountriesOf([
      denomination({ denominationId: 1, country: 'US' }),
      denomination({ denominationId: 2, country: 'US' }),
      denomination({ denominationId: 3, country: 'GB' })
    ]);

    expect(countries).toEqual(['US', 'GB']);
  });

  it('never invents a heading with nothing under it', () => {
    // The regression. With only 'United States' in the data, the old
    // hard-coded list produced empty 'US' and 'GB' groups; the derived list
    // produces one group that actually has entries.
    const countries = denominationCountriesOf([
      denomination({ country: 'United States' })
    ]);

    expect(countries).toEqual(['United States']);
    expect(countries).not.toContain('GB');
  });

  it('includes a country the hard-coded pair left out', () => {
    // The Categories & Sets dialog can create a 'CA' denomination. Under the
    // old template it existed but was unreachable, because there was no CA
    // group to render it in.
    const countries = denominationCountriesOf([
      denomination({ denominationId: 1, country: 'US' }),
      denomination({ denominationId: 2, country: 'CA' })
    ]);

    expect(countries).toContain('CA');
  });

  it('puts US first and sorts the rest alphabetically', () => {
    const countries = denominationCountriesOf([
      denomination({ denominationId: 1, country: 'GB' }),
      denomination({ denominationId: 2, country: 'CA' }),
      denomination({ denominationId: 3, country: 'US' }),
      denomination({ denominationId: 4, country: 'AU' })
    ]);

    expect(countries).toEqual(['US', 'AU', 'CA', 'GB']);
  });

  it('sorts correctly when US is absent entirely', () => {
    const countries = denominationCountriesOf([
      denomination({ denominationId: 1, country: 'GB' }),
      denomination({ denominationId: 2, country: 'CA' })
    ]);

    expect(countries).toEqual(['CA', 'GB']);
  });

  it('ignores inactive denominations', () => {
    // The template does not render them, so counting them here would produce
    // the empty-heading bug for a country whose entries are all retired.
    const countries = denominationCountriesOf([
      denomination({ denominationId: 1, country: 'US', isActive: true }),
      denomination({ denominationId: 2, country: 'GB', isActive: false })
    ]);

    expect(countries).toEqual(['US']);
  });

  it('ignores blank and whitespace-only countries', () => {
    const countries = denominationCountriesOf([
      denomination({ denominationId: 1, country: 'US' }),
      denomination({ denominationId: 2, country: '' }),
      denomination({ denominationId: 3, country: '   ' })
    ]);

    expect(countries).toEqual(['US']);
  });

  it('trims surrounding whitespace rather than making a second group', () => {
    const countries = denominationCountriesOf([
      denomination({ denominationId: 1, country: 'US' }),
      denomination({ denominationId: 2, country: ' US ' })
    ]);

    expect(countries).toEqual(['US']);
  });

  it('returns nothing for an empty list, so no headings render at all', () => {
    expect(denominationCountriesOf([])).toEqual([]);
  });
});
