/**
 * Tests for the country code <-> name bridge. Denominations.Country holds codes
 * ('US', 'GB') and Coins.Country full names ('United States'); the editor's
 * country-aware denomination dropdown depends on `resolveCountryName` and
 * `isSameCountry` joining them.
 */
import { describe, expect, it } from 'vitest';
import {
  allCountryNames,
  countryDisplayName,
  detectCountry,
  detectForeignDenomination,
  isSameCountry,
  resolveCountryName
} from './coin-countries';

describe('resolveCountryName', () => {
  it('resolves the two-letter codes the Denominations table actually uses', () => {
    // The two codes in the seed data.
    expect(resolveCountryName('US')).toBe('United States');
    expect(resolveCountryName('GB')).toBe('Great Britain');
  });

  it('resolves a code regardless of case', () => {
    expect(resolveCountryName('gb')).toBe('Great Britain');
    expect(resolveCountryName('us')).toBe('United States');
  });

  it('resolves the full names coins are actually stored with', () => {
    expect(resolveCountryName('United States')).toBe('United States');
    expect(resolveCountryName('Great Britain')).toBe('Great Britain');
  });

  it('resolves the free text a user might type instead', () => {
    // The Country field is a text box, so all of these are reachable.
    expect(resolveCountryName('UK')).toBe('Great Britain');
    expect(resolveCountryName('United Kingdom')).toBe('Great Britain');
    expect(resolveCountryName('British')).toBe('Great Britain');
    expect(resolveCountryName('England')).toBe('Great Britain');
    expect(resolveCountryName('USA')).toBe('United States');
  });

  it('returns blank for nothing, and for anything it cannot place', () => {
    // '' means "no opinion"; callers fall back to showing everything.
    expect(resolveCountryName('')).toBe('');
    expect(resolveCountryName('   ')).toBe('');
    expect(resolveCountryName(null)).toBe('');
    expect(resolveCountryName(undefined)).toBe('');
    expect(resolveCountryName('Ruritania')).toBe('');
    expect(resolveCountryName('ZZ')).toBe('');
  });

  it('knows Canada, which the Categories dialog offers but the seed has no rows for', () => {
    expect(resolveCountryName('CA')).toBe('Canada');
  });
});

describe('isSameCountry', () => {
  it('matches a denomination code against a coin name — the whole point', () => {
    expect(isSameCountry('GB', 'Great Britain')).toBe(true);
    expect(isSameCountry('US', 'United States')).toBe(true);
    // Through free text too.
    expect(isSameCountry('GB', 'uk')).toBe(true);
  });

  it('does not match different countries', () => {
    expect(isSameCountry('GB', 'United States')).toBe(false);
    expect(isSameCountry('US', 'Great Britain')).toBe(false);
  });

  it('treats blank as matching nothing', () => {
    expect(isSameCountry('', 'US')).toBe(false);
    expect(isSameCountry('US', '')).toBe(false);
  });

  it('falls back to plain text when neither side is recognised', () => {
    // Unknown codes still group with themselves.
    expect(isSameCountry('XX', 'xx')).toBe(true);
    expect(isSameCountry('XX', 'YY')).toBe(false);
  });

  it('refuses to match a known country against an unknown one', () => {
    expect(isSameCountry('US', 'Ruritania')).toBe(false);
  });
});

describe('countryDisplayName', () => {
  it('humanises a code', () => {
    expect(countryDisplayName('GB')).toBe('Great Britain');
    expect(countryDisplayName('US')).toBe('United States');
  });

  it('hands back anything unrecognised exactly as stored', () => {
    // Unknown values are shown as stored.
    expect(countryDisplayName('Ruritania')).toBe('Ruritania');
    expect(countryDisplayName('')).toBe('');
  });
});

describe('allCountryNames', () => {
  it('offers the canonical names, sorted, including the two that matter', () => {
    const names = allCountryNames();
    expect(names).toContain('United States');
    expect(names).toContain('Great Britain');
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });

  it('offers only names that resolve back to themselves', () => {
    // Every suggestion the Country box offers must be recognised by the filter.
    for (const name of allCountryNames()) {
      expect(resolveCountryName(name)).toBe(name);
    }
  });
});


 /*
  * Foreign denominations read from security names in testing/qif-corpus. A
  * missing unit means the coin imports without a denomination.
  */
describe('detectForeignDenomination', () => {
  it('reads the euro, which no single country implies', () => {
    const found = detectForeignDenomination('2025 Italy 50 Euro 1/2 oz. Gold Proof');
    expect(found?.denomination).toBe('50 Euro');
    // Euro coins come from many states; the country comes from "Italy" instead.
    expect(found?.impliedCountry).toBe('');
    expect(detectCountry('2025 Italy 50 Euro 1/2 oz. Gold Proof')).toBe('Italy');
  });

  it('still reads a unit that DOES imply its country', () => {
    const found = detectForeignDenomination('1967 Peru 100 Soles - PCGS MS65');
    expect(found?.denomination).toBe('100 Soles');
    expect(found?.impliedCountry).toBe('Peru');
  });
});