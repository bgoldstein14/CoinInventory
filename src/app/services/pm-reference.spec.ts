import { describe, expect, it } from 'vitest';
import { lookupPmData } from './pm-reference';

/**
 * Tests for the precious metal reference data lookup.
 *
 * The pm-reference module provides pmWeightGrams and pmPercent for known coins
 * to support melt value calculations. This data is pre-filled during Quicken import
 * and can be used for manual entry as well.
 *
 * Function signature: lookupPmData(denomination, year, country)
 * Denominations use symbolic format (25¢, 50¢, $1, $20, etc.).
 */
describe('pm-reference', () => {
  describe('lookupPmData', () => {
    // --- US Silver Coins (90% silver, pre-1965) ---

    it('returns PM data for 1960 US Quarter (90% silver)', () => {
      const data = lookupPmData('25¢', '1960', 'United States');
      expect(data).toBeDefined();
      expect(data?.pmWeightGrams).toBeCloseTo(5.63, 2);
      expect(data?.pmPercent).toBe(90);
    });

    it('returns PM data for 1964 US Dime (90% silver)', () => {
      const data = lookupPmData('10¢', '1964', 'United States');
      expect(data).toBeDefined();
      expect(data?.pmWeightGrams).toBeCloseTo(2.25, 2);
      expect(data?.pmPercent).toBe(90);
    });

    it('returns PM data for 1950 US Half Dollar (90% silver)', () => {
      const data = lookupPmData('50¢', '1950', 'United States');
      expect(data).toBeDefined();
      expect(data?.pmWeightGrams).toBeCloseTo(11.25, 2);
      expect(data?.pmPercent).toBe(90);
    });

    it('returns PM data for 1921 US Dollar (Morgan/Peace, 90% silver)', () => {
      const data = lookupPmData('$1', '1921', 'United States');
      expect(data).toBeDefined();
      expect(data?.pmWeightGrams).toBeCloseTo(24.06, 2);
      expect(data?.pmPercent).toBe(90);
    });

    // --- US 40% Silver Half Dollars (1965-1970) ---

    it('returns PM data for 1967 US Half Dollar (40% silver)', () => {
      const data = lookupPmData('50¢', '1967', 'United States');
      expect(data).toBeDefined();
      expect(data?.pmWeightGrams).toBeCloseTo(9.20, 2);
      expect(data?.pmPercent).toBe(40);
    });

    // --- US Gold Coins ---

    it('returns PM data for 1907 US Double Eagle (90% gold)', () => {
      const data = lookupPmData('$20', '1907', 'United States');
      expect(data).toBeDefined();
      expect(data?.pmWeightGrams).toBeCloseTo(30.09, 2);
      expect(data?.pmPercent).toBe(90);
    });

    it('returns PM data for 1895 US Eagle (90% gold)', () => {
      const data = lookupPmData('$10', '1895', 'United States');
      expect(data).toBeDefined();
      expect(data?.pmWeightGrams).toBeCloseTo(15.05, 2);
      expect(data?.pmPercent).toBe(90);
    });

    // --- British Silver Coins (50% silver, 1920-1946) ---

    it('returns PM data for 1945 GB Shilling (50% silver)', () => {
      const data = lookupPmData('Shilling', '1945', 'Great Britain');
      expect(data).toBeDefined();
      expect(data?.pmWeightGrams).toBeCloseTo(5.24, 2);
      expect(data?.pmPercent).toBe(50);
    });

    it('returns PM data for 1930 GB Florin (50% silver)', () => {
      const data = lookupPmData('Florin', '1930', 'Great Britain');
      expect(data).toBeDefined();
      expect(data?.pmWeightGrams).toBeCloseTo(10.47, 2);
      expect(data?.pmPercent).toBe(50);
    });

    // --- Unknown coins ---

    it('returns null for unknown country', () => {
      const data = lookupPmData('25¢', '1960', 'Unknown Country');
      expect(data).toBeNull();
    });

    it('returns null for unknown denomination', () => {
      const data = lookupPmData('Doubloon', '1800', 'United States');
      expect(data).toBeNull();
    });

    it('returns null for post-silver year (clad US quarter)', () => {
      // US quarters switched to clad (no PM) in 1965
      const data = lookupPmData('25¢', '1980', 'United States');
      expect(data).toBeNull();
    });

    it('returns null for missing parameters', () => {
      expect(lookupPmData('', '1960', 'United States')).toBeNull();
      expect(lookupPmData('25¢', '', 'United States')).toBeNull();
      expect(lookupPmData('25¢', '1960', '')).toBeNull();
    });
  });
});
