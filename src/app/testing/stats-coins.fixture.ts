/*
 * Coin builder for the statistics specs. Starts with every optional field
 * absent, since handling missing data is what those specs test.
 */

import { CoinRecord } from '../types/coin.model';

let nextId = 0;

/**
 * A coin with every required field present and every optional field absent.
 * `purchasePrice` and `currentValue` default to 0, meaning "not recorded".
 */
export function statsCoin(overrides: Partial<CoinRecord> = {}): CoinRecord {
  nextId += 1;
  return {
    id: `fixture-${nextId}`,
    denomination: '',
    year: '',
    coinType: '',
    category: '',
    country: '',
    grade: '',
    certCompany: '',
    certNumber: '',
    variety: '',
    mintMark: '',
    composition: '',
    purchaseDate: '',
    purchasePrice: 0,
    currentValue: 0,
    notes: '',
    imagePaths: [],
    source: 'manual',
    ...overrides
  };
}
