 /*
  * Resolution cost must not grow with the table size per row. denomination-index.ts
  * folds the table once; answers are unchanged, so only a cost measurement can
  * catch losing that shortcut. Alias folds are counted (by wrapping
  * `denominationKey`) rather than timed, so the result is machine-independent.
  */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({ folds: 0 }));

/* Re-export the module unchanged except `denominationKey`, which is wrapped to
 * count calls. Both denomination-index and denomination-resolution import it. */
vi.mock('../../components/coin-editor-form/denomination-aliases', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../components/coin-editor-form/denomination-aliases')
  >();
  return {
    ...actual,
    denominationKey: (value: string | null | undefined) => {
      probe.folds += 1;
      return actual.denominationKey(value);
    }
  };
});

const { SEED_DENOMINATIONS } = await import('../../testing/seed-denominations.fixture');
const { denominationIndexFor, resolveDenominationId } = await import('./denomination-index');

/** Spellings a real spreadsheet column holds: some link, some don't. */
const TEXTS = ['Dollar', '3CS', '8 Reales', '50¢', 'Pillar Dollar', '$20', 'Penny'];

describe('resolving 500 rows does not re-read the 1,161-row table 500 times', () => {
  beforeEach(() => {
    // Build the index first and discard that cost (once per lookup array is allowed).
    denominationIndexFor(SEED_DENOMINATIONS);
    probe.folds = 0;
  });

  it('costs a handful of folds per row, not one per row per lookup entry', () => {
    const rows = 500;
    for (let i = 0; i < rows; i++) {
      resolveDenominationId(TEXTS[i % TEXTS.length], 'United States', SEED_DENOMINATIONS);
    }

    // Non-vacuity: resolution really happened.
    expect(probe.folds).toBeGreaterThan(rows);

    /* Budget per row: fold the text for its bucket, fold again in the resolver,
     * and fold the bucket's few candidate labels. Ten is well above that and far
     * below the naive 500 x 1,161. */
    expect(probe.folds).toBeLessThan(rows * 10);
  });

  it('scales with the rows and not with the table', () => {
    for (let i = 0; i < 100; i++) {
      resolveDenominationId(TEXTS[i % TEXTS.length], 'United States', SEED_DENOMINATIONS);
    }
    const hundred = probe.folds;
    probe.folds = 0;

    for (let i = 0; i < 1000; i++) {
      resolveDenominationId(TEXTS[i % TEXTS.length], 'United States', SEED_DENOMINATIONS);
    }
    const thousand = probe.folds;

    // Ten times the rows, about ten times the work, independent of seed size.
    expect(thousand).toBeLessThan(hundred * 11);
  });
});
