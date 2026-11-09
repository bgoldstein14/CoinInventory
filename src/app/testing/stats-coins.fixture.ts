/*
 * One coin builder for the statistics specs.
 *
 * WHY THIS IS A FIXTURE AND NOT A LITERAL IN EACH SPEC
 * CoinRecord has thirty-odd fields and the statistics maths cares about eight
 * of them. Writing a full literal per test would bury the one field under
 * test — the blank `pmWeightGrams`, the zero `currentValue` — in two dozen
 * irrelevant empty strings, and the point of most of these tests is exactly
 * "which field was left blank".
 *
 * So the builder starts from a coin with NOTHING optional filled in. That is
 * deliberate and it is the harder case: the statistics view's whole job is to
 * be honest about absent data, so the default fixture must be absent data,
 * not a tidy fully-populated record that never occurs in a real collection.
 *
 * Lives under `src/app/testing/` because that folder is excluded from
 * `tsconfig.app.json` — a test helper must never be reachable from the
 * production build.
 */

import { CoinRecord } from '../types/coin.model';

let nextId = 0;

/**
 * A coin with every required field present and every optional field absent.
 *
 * `purchasePrice` and `currentValue` default to 0, which in this app means
 * "no figure was ever recorded" — see the header of collection-totals.ts.
 * Pass them explicitly in any test that wants a priced coin.
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
