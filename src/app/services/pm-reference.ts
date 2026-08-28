/**
 * Precious metal reference data for coin melt value calculations.
 *
 * Provides lookup of precious metal weight and purity for known coin types.
 * Used during Quicken import to pre-fill PM data based on denomination and year.
 */

interface PmEntry {
  /** Denomination pattern to match (exact string or regex pattern) */
  denomination: string;
  /** Year range (inclusive). If undefined, matches all years. */
  yearRange?: { min: number; max: number };
  /** Precious metal weight in grams */
  pmWeightGrams: number;
  /** Precious metal purity as percentage (e.g., 90 for 90% silver) */
  pmPercent: number;
  /** Human-readable metal content description */
  metalContent: string;
  /** Optional country filter */
  country?: string;
}

/**
 * Reference table of known precious metal coin compositions.
 * Organized by region for readability.
 */
const PM_REFERENCE_DATA: PmEntry[] = [
  // ==========================================
  // United States - Gold
  // ==========================================
  {
    denomination: '$20',
    pmWeightGrams: 30.09,
    pmPercent: 90,
    metalContent: '0.9675 oz AGW',
    country: 'United States'
  },
  {
    denomination: '$10',
    pmWeightGrams: 15.05,
    pmPercent: 90,
    metalContent: '0.4837 oz AGW',
    country: 'United States'
  },
  {
    denomination: '$5',
    pmWeightGrams: 7.52,
    pmPercent: 90,
    metalContent: '0.2419 oz AGW',
    country: 'United States'
  },
  {
    denomination: '$3',
    pmWeightGrams: 4.54,
    pmPercent: 90,
    metalContent: '0.1452 oz AGW',
    country: 'United States'
  },
  {
    denomination: '$2.50',
    pmWeightGrams: 3.76,
    pmPercent: 90,
    metalContent: '0.1209 oz AGW',
    country: 'United States'
  },
  {
    denomination: '$1',
    pmWeightGrams: 1.50,
    pmPercent: 90,
    metalContent: '0.0484 oz AGW',
    country: 'United States'
  },

  // ==========================================
  // United States - Silver (Pre-1965 90%)
  // ==========================================
  {
    denomination: '$1',
    yearRange: { min: 1794, max: 1935 },
    pmWeightGrams: 24.06,
    pmPercent: 90,
    metalContent: '0.7734 oz ASW',
    country: 'United States'
  },
  {
    denomination: '50¢',
    yearRange: { min: 1794, max: 1964 },
    pmWeightGrams: 11.25,
    pmPercent: 90,
    metalContent: '0.3617 oz ASW',
    country: 'United States'
  },
  {
    denomination: '25¢',
    yearRange: { min: 1796, max: 1964 },
    pmWeightGrams: 5.63,
    pmPercent: 90,
    metalContent: '0.1808 oz ASW',
    country: 'United States'
  },
  {
    denomination: '20¢',
    yearRange: { min: 1875, max: 1878 },
    pmWeightGrams: 4.50,
    pmPercent: 90,
    metalContent: '0.1447 oz ASW',
    country: 'United States'
  },
  {
    denomination: '10¢',
    yearRange: { min: 1796, max: 1964 },
    pmWeightGrams: 2.25,
    pmPercent: 90,
    metalContent: '0.0723 oz ASW',
    country: 'United States'
  },
  {
    denomination: '5¢',
    yearRange: { min: 1794, max: 1873 }, // Half Dime series
    pmWeightGrams: 1.20,
    pmPercent: 90,
    metalContent: '0.0386 oz ASW',
    country: 'United States'
  },
  {
    denomination: '3¢ Silver',
    yearRange: { min: 1851, max: 1873 },
    pmWeightGrams: 0.75,
    pmPercent: 90,
    metalContent: '0.0241 oz ASW',
    country: 'United States'
  },

  // ==========================================
  // United States - 40% Silver (Kennedy Half 1965-1970)
  // ==========================================
  {
    denomination: '50¢',
    yearRange: { min: 1965, max: 1970 },
    pmWeightGrams: 9.20,
    pmPercent: 40,
    metalContent: '0.1479 oz ASW',
    country: 'United States'
  },

  // ==========================================
  // Great Britain - Gold
  // ==========================================
  {
    denomination: 'Sovereign',
    pmWeightGrams: 7.32,
    pmPercent: 91.67,
    metalContent: '0.2354 oz AGW',
    country: 'Great Britain'
  },
  {
    denomination: '½ Sovereign',
    pmWeightGrams: 3.66,
    pmPercent: 91.67,
    metalContent: '0.1177 oz AGW',
    country: 'Great Britain'
  },

  // ==========================================
  // Great Britain - Silver (Pre-1920 92.5% Sterling)
  // ==========================================
  {
    denomination: 'Crown',
    yearRange: { min: 1707, max: 1919 },
    pmWeightGrams: 26.18,
    pmPercent: 92.5,
    metalContent: '0.841 oz ASW',
    country: 'Great Britain'
  },
  {
    denomination: 'Half Crown',
    yearRange: { min: 1707, max: 1919 },
    pmWeightGrams: 13.09,
    pmPercent: 92.5,
    metalContent: '0.420 oz ASW',
    country: 'Great Britain'
  },
  {
    denomination: 'Florin',
    yearRange: { min: 1849, max: 1919 },
    pmWeightGrams: 10.47,
    pmPercent: 92.5,
    metalContent: '0.336 oz ASW',
    country: 'Great Britain'
  },
  {
    denomination: 'Shilling',
    yearRange: { min: 1707, max: 1919 },
    pmWeightGrams: 5.24,
    pmPercent: 92.5,
    metalContent: '0.168 oz ASW',
    country: 'Great Britain'
  },

  // ==========================================
  // Great Britain - Silver (1920-1946 50%)
  // ==========================================
  {
    denomination: 'Crown',
    yearRange: { min: 1920, max: 1946 },
    pmWeightGrams: 26.18,
    pmPercent: 50,
    metalContent: '0.454 oz ASW',
    country: 'Great Britain'
  },
  {
    denomination: 'Half Crown',
    yearRange: { min: 1920, max: 1946 },
    pmWeightGrams: 13.09,
    pmPercent: 50,
    metalContent: '0.227 oz ASW',
    country: 'Great Britain'
  },
  {
    denomination: 'Florin',
    yearRange: { min: 1920, max: 1946 },
    pmWeightGrams: 10.47,
    pmPercent: 50,
    metalContent: '0.182 oz ASW',
    country: 'Great Britain'
  },
  {
    denomination: 'Shilling',
    yearRange: { min: 1920, max: 1946 },
    pmWeightGrams: 5.24,
    pmPercent: 50,
    metalContent: '0.091 oz ASW',
    country: 'Great Britain'
  }
];

/**
 * Looks up precious metal data for a given coin.
 *
 * @param denomination Normalized denomination (e.g., "50¢", "$20", "Sovereign")
 * @param year Year as string (e.g., "1921", "1920-1930"). Uses first year for ranges.
 * @param country Country name (e.g., "United States", "Great Britain")
 * @returns PM data if found, null otherwise
 */
export function lookupPmData(
  denomination: string,
  year: string,
  country: string
): { pmWeightGrams: number; pmPercent: number; metalContent: string } | null {
  // Parse year from string (handle ranges like "1920-1930")
  const yearMatch = year.match(/^(\d{4})/);
  if (!yearMatch) {
    return null; // Cannot parse year
  }
  const yearInt = parseInt(yearMatch[1], 10);

  // Search for matching entry — prefer year-specific matches over generic ones
  let fallback: { pmWeightGrams: number; pmPercent: number; metalContent: string } | null = null;

  for (const entry of PM_REFERENCE_DATA) {
    if (entry.denomination.toLowerCase() !== denomination.toLowerCase()) continue;
    if (entry.country && entry.country.toLowerCase() !== country.toLowerCase()) continue;

    if (entry.yearRange) {
      if (yearInt < entry.yearRange.min || yearInt > entry.yearRange.max) continue;
      // Year-specific match wins immediately
      return { pmWeightGrams: entry.pmWeightGrams, pmPercent: entry.pmPercent, metalContent: entry.metalContent };
    }

    // Generic match (no yearRange) — save as fallback
    if (!fallback) {
      fallback = { pmWeightGrams: entry.pmWeightGrams, pmPercent: entry.pmPercent, metalContent: entry.metalContent };
    }
  }

  return fallback;
}
