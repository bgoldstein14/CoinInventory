 /*
 * resolution-cost.spec.ts — resolution must not be O(table) per row
 *
 * WHY THIS IS A TEST AND NOT A COMMENT
 *
 * `resolveDenomination` folds EVERY row it is handed through the alias table
 * before it compares anything. Called the obvious way, a 2,000-row
 * spreadsheet against the 1,161-row seed is 2.3 million alias folds — and
 * the CSV preview re-plans on every change to the mapping grid, so that cost
 * lands on the keystroke path rather than behind the Import button.
 *
 * `denomination-index.ts` removes it by folding the table once and handing
 * the resolver only the rows that could possibly match. Nothing about the
 * ANSWERS changes, which is exactly why no behavioural test can notice if
 * the shortcut is lost: `denomination-index.spec.ts` deliberately asserts
 * that both paths agree. So the cost needs its own measurement, or it can be
 * thrown away silently.
 *
 * COUNTED, NOT TIMED
 *
 * The alias fold is the unit of work, so the fold is what is counted — by
 * wrapping `denominationKey` itself. A stopwatch assertion would measure the
 * machine as much as the code and would flake under a loaded CI box; a count
 * is the same number on every machine.
  */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({ folds: 0 }));

/* The whole module is re-exported untouched except for the one function,
 * which is wrapped rather than replaced — so every rule it implements is
 * still the real one and only the counting is added. `denomination-index`
 * and `denomination-resolution` both import from here, so this sees every
 * fold either of them performs. */
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

/** Spellings a real spreadsheet column holds: some link, some do not. */
const TEXTS = ['Dollar', '3CS', '8 Reales', '50¢', 'Pillar Dollar', '$20', 'Penny'];

describe('resolving 500 rows does not re-read the 1,161-row table 500 times', () => {
  beforeEach(() => {
    // Warm the index first and discard that cost: building it IS allowed to
    // touch every row, exactly once per lookup array.
    denominationIndexFor(SEED_DENOMINATIONS);
    probe.folds = 0;
  });

  it('costs a handful of folds per row, not one per row per lookup entry', () => {
    const rows = 500;
    for (let i = 0; i < rows; i++) {
      resolveDenominationId(TEXTS[i % TEXTS.length], 'United States', SEED_DENOMINATIONS);
    }

    // Non-vacuity: resolution really happened, so a no-op resolver could not
    // pass this by scoring zero.
    expect(probe.folds).toBeGreaterThan(rows);

    /* The budget. Per row the work is: fold the text to find its bucket,
     * fold it again inside the resolver, and fold the handful of candidate
     * labels in that bucket (one for '$20', eight for '1¢'). Ten is
     * comfortably above that and ~580,000 below the naive cost of
     * 500 x 1,161. */
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

    // Ten times the rows, about ten times the work -- and crucially a cost
    // per row that does not depend on how many denominations are seeded.
    expect(thousand).toBeLessThan(hundred * 11);
  });
});
