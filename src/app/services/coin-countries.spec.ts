/**
 * Tests for the country code <-> name bridge in coin-countries.ts.
 *
 * WHY THIS MATTERS
 * The app stores a country two ways and they never match as plain strings:
 *
 *     Denominations.Country  -> 'US', 'GB'          (two-letter codes)
 *     Coins.Country          -> 'United States'     (full names)
 *
 * Everything that has to join those two — the coin editor's country-aware
 * denomination dropdown, above all — goes through `resolveCountryName` and
 * `isSameCountry`. If these are wrong, the dropdown filters to nothing.
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
    // These are the only two codes in the seed data, and the ones the whole
    // feature depends on.
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
    // '' is the "no opinion" signal every caller must fall back on. It is
    // what stops an unrecognised country emptying the denomination dropdown.
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
    // And through free text too.
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
    // Two rows filed under a made-up code still group with each other
    // rather than every unknown collapsing together.
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
    // It is still the user's data; a placeholder would hide it.
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
    // A drift guard. Every suggestion the Country box offers must be
    // something the filter can then recognise, or picking a suggestion
    // would leave the dropdown unfiltered.
    for (const name of allCountryNames()) {
      expect(resolveCountryName(name)).toBe(name);
    }
  });
});


/* =============================================================================
 * FOREIGN DENOMINATIONS READ OUT OF A SECURITY NAME
 * -----------------------------------------------------------------------------
 * These names are securities from the test corpus in testing/qif-corpus. The units
 * table is the only thing standing between "50 Euro" and a coin that imports
 * with no denomination at all and lands in the exceptions list, so a unit he
 * actually owns being absent from it is a silent data gap, not a cosmetic one.
 * =========================================================================== */
describe('detectForeignDenomination', () => {
  it('reads the euro, which no single country implies', () => {
    const found = detectForeignDenomination('2025 Italy 50 Euro 1/2 oz. Gold Proof');
    expect(found?.denomination).toBe('50 Euro');
    // Twenty-odd states issue euro coins, so the unit proves nothing about
    // the mint. The country comes from the word "Italy" instead.
    expect(found?.impliedCountry).toBe('');
    expect(detectCountry('2025 Italy 50 Euro 1/2 oz. Gold Proof')).toBe('Italy');
  });

  it('still reads a unit that DOES imply its country', () => {
    const found = detectForeignDenomination('1967 Peru 100 Soles - PCGS MS65');
    expect(found?.denomination).toBe('100 Soles');
    expect(found?.impliedCountry).toBe('Peru');
  });
});