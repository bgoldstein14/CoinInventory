/**
 * Tests for the one-time "backfill precious-metal data" maintenance action.
 *
 * WHAT IS BEING PROTECTED HERE
 * ----------------------------
 * This feature rewrites part of every row in the owner's collection in one
 * press of a button, so the tests are mostly about what it REFUSES to do:
 *
 *   * it never overwrites a value that is already there (it may have been
 *     typed in by hand, and a hand-entered figure outranks an inferred one);
 *   * it never guesses where pm-reference.ts deliberately declines to, because
 *     a wrong purity silently produces a wrong melt value;
 *   * it never sends a field it did not intend to — this project has a history
 *     of whole-record writes blanking out unrelated columns; and
 *   * what the preview promises is exactly what the run performs.
 */
import { describe, expect, it, vi } from 'vitest';
import { CoinRecord } from '../types/coin.model';
import {
  PmBackfillPlan,
  onlyPmFields,
  planPmBackfill,
  runPmBackfill
} from './pm-backfill';
import { PM_FIELD_KEYS, composePmFields, pmFieldsToFill } from './pm-fill';

/** A coin with everything filled in EXCEPT whatever the test overrides. */
function coin(overrides: Partial<CoinRecord>): CoinRecord {
  return {
    id: 'c1',
    denomination: '',
    year: '',
    coinType: '',
    category: '',
    country: 'United States',
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

/* ===========================================================================
 * THE SHARED INFERENCE
 * ---------------------------------------------------------------------------
 * `composePmFields` is the single adapter the Quicken import AND this backfill
 * both call. If the two ever stopped sharing it, the first symptom would be an
 * imported coin and a backfilled coin disagreeing about the same object.
 * ======================================================================== */

describe('composePmFields — the mapping both the import and the backfill use', () => {
  it('names its result with CoinRecord field names, not the reference table\'s', () => {
    // pm-reference.ts calls it `metal`; a coin record calls it `metalContent`.
    // Doing that rename in one place is the whole reason pm-fill.ts exists.
    const fields = composePmFields('$20', '1927', 'United States');

    expect(fields).toEqual({
      metalContent: 'Gold',
      composition: '90% Gold, 10% Copper',
      pmPercent: 90,
      pmWeightGrams: 30.09,
      // The reference table calls this `grossWeightGrams`, because it sits
      // next to `pmWeightGrams` and the two must never be confused. A coin
      // record calls it plainly `weight`. That rename is the fifth and last
      // thing pm-fill.ts does.
      weight: 33.436
    });
  });

  it('distinguishes the coin\'s GROSS weight from the pure metal in it', () => {
    // The single most important thing about these two numbers is that they
    // are not the same number. A $20 double eagle weighs 33.436 g and
    // contains 30.09 g of gold; confusing the two is the exact mistake behind
    // the melt-value bug written up in the README.
    const fields = composePmFields('$20', '1927', 'United States');

    expect(fields?.weight).toBeCloseTo(33.436, 3);
    expect(fields?.pmWeightGrams).toBeCloseTo(30.09, 2);
    // ...and they agree with the purity, which is what proves neither was
    // transcribed wrong.
    expect(fields!.weight! * (fields!.pmPercent! / 100)).toBeCloseTo(fields!.pmWeightGrams!, 2);
  });

  it('reports a GROSS weight for base metal, where there is no PM weight at all', () => {
    // `weight` is the one of the five that is not about precious metal, so it
    // is filled on coins the other four cannot describe. A 1983 cent has no
    // melt value and a perfectly well-known weight.
    const fields = composePmFields('1¢', '1983', 'United States');

    expect(fields?.weight).toBeCloseTo(2.50, 2);
    expect(fields?.pmWeightGrams).toBeUndefined();
  });

  it('offers no weight when only the COARSE metal fallback could answer', () => {
    // "A US $20 is gold" is a statement about the metal. It says nothing
    // about the planchet, so no weight is invented to go with it. (1934 is
    // outside the double eagle's 1849-1933 band, so the table has no row and
    // metal-inference.ts answers on its own.)
    const fields = composePmFields('$20', '1934', 'United States');

    expect(fields?.metalContent).toBe('Gold');
    expect(fields?.weight).toBeUndefined();
    expect(fields?.pmWeightGrams).toBeUndefined();
  });

  it('answers for base metal too, with the two PM numbers left undefined', () => {
    // A bronze cent HAS a metal and a composition but no precious metal, so
    // writing 0 into the PM fields would be a lie that computeMeltValue would
    // then have to interpret. They stay absent.
    const fields = composePmFields('1¢', '1909', 'United States');

    expect(fields?.metalContent).toBe('Bronze');
    expect(fields?.pmWeightGrams).toBeUndefined();
    expect(fields?.pmPercent).toBeUndefined();
  });
});

/* ===========================================================================
 * ONLY FILL BLANKS
 * ======================================================================== */

describe('pmFieldsToFill — which fields may be written for one coin', () => {
  it('fills all five on a coin that has none of them', () => {
    const updates = pmFieldsToFill(coin({ denomination: '$20', year: '1927' }));

    expect(updates).toEqual({
      metalContent: 'Gold',
      composition: '90% Gold, 10% Copper',
      pmPercent: 90,
      pmWeightGrams: 30.09,
      weight: 33.436
    });
  });

  it('NEVER overwrites a value that is already there', () => {
    // The owner has typed a deliberately "wrong" purity and a deliberately
    // "wrong" weight. The backfill is not entitled to an opinion about
    // either: they may know something about this specific coin — a worn or
    // damaged example really does weigh less — that a year-and-denomination
    // table cannot.
    //
    // Note the weight in particular. It is the newest of the five fields and
    // the one most likely to have been measured on an actual scale, so it is
    // the LAST one an inferred catalogue figure should be allowed to replace.
    const updates = pmFieldsToFill(coin({
      denomination: '$20',
      year: '1927',
      metalContent: 'Gold',
      composition: 'Hand-checked: 90% Gold',
      pmPercent: 89.5,
      pmWeightGrams: 29.5,
      weight: 33.1                 // weighed on a scale; table says 33.436
    }));

    expect(updates).toEqual({});
  });

  it('leaves a hand-measured WEIGHT alone while still filling the rest', () => {
    // The sharpest form of the rule: the one field the user supplied is the
    // one the table also knows, and the table loses.
    const updates = pmFieldsToFill(coin({
      denomination: '$20',
      year: '1927',
      weight: 33.1
    }));

    expect(updates).not.toHaveProperty('weight');
    expect(updates).toEqual({
      metalContent: 'Gold',
      composition: '90% Gold, 10% Copper',
      pmPercent: 90,
      pmWeightGrams: 30.09
    });
  });

  it('treats a weight of zero as a value, not as a blank', () => {
    // Same rule as the PM numbers below: a 0 is something somebody put there.
    const updates = pmFieldsToFill(coin({ denomination: '$20', year: '1927', weight: 0 }));

    expect(updates).not.toHaveProperty('weight');
    expect(updates).toHaveProperty('metalContent', 'Gold');
  });

  it('completes the GAPS on a partly-filled coin rather than skipping it', () => {
    /* This is the decision the brief asked to be stated explicitly, and it is
     * the case the whole feature exists for. Melt value needs BOTH
     * metalContent and pmWeightGrams. A coin where only the metal was ever
     * typed in still shows a blank melt figure — so a "skip anything partly
     * filled" rule would refuse to fix precisely the coins that are broken. */
    const updates = pmFieldsToFill(coin({
      denomination: '50¢',
      year: '1964',
      metalContent: 'Silver'       // hand-entered; must survive untouched
    }));

    expect(updates).toEqual({
      composition: '90% Silver, 10% Copper',
      pmPercent: 90,
      pmWeightGrams: 11.25,
      weight: 12.50
    });
    expect(updates).not.toHaveProperty('metalContent');
  });

  it('treats a zero as a value, not as a blank', () => {
    // A 0 is a number somebody put there. The rule is "only fill blanks", and
    // 0 is not a blank. (Contrast spot PRICES, where 0 does mean "unknown" —
    // gold does not trade at zero, but a coin's PM weight genuinely can be.)
    const updates = pmFieldsToFill(coin({
      denomination: '$20',
      year: '1927',
      pmWeightGrams: 0,
      pmPercent: 0
    }));

    expect(updates).not.toHaveProperty('pmWeightGrams');
    expect(updates).not.toHaveProperty('pmPercent');
    expect(updates).toHaveProperty('metalContent', 'Gold');
  });

  it('never invents a value the reference table does not have', () => {
    // A 1983 cent is copper-plated zinc. It has no precious metal, so the two
    // PM numbers must stay blank — not be filled with zeros. Its WEIGHT, on
    // the other hand, is perfectly well known (2.50 g) and is filled, which
    // is the difference between "no precious metal" and "no information".
    const updates = pmFieldsToFill(coin({ denomination: '1¢', year: '1983' }));

    expect(Object.keys(updates).sort()).toEqual(['composition', 'metalContent', 'weight']);
    expect(updates).not.toHaveProperty('pmWeightGrams');
    expect(updates).not.toHaveProperty('pmPercent');
  });

  it('withholds the weight too where the table genuinely does not have one', () => {
    // The large cent spans two planchet standards (13.48 g then 10.89 g) in
    // one reference row, so pm-reference.ts records no gross weight for it.
    // Metal and composition are still filled; weight is not invented.
    const updates = pmFieldsToFill(coin({ denomination: '1¢', year: '1820' }));

    expect(updates).toHaveProperty('metalContent', 'Copper');
    expect(updates).not.toHaveProperty('weight');
  });

  it('uses the coin\'s own recorded metal to settle a tie the table refuses', () => {
    /* An 1855 "$1" is either a 24 g silver dollar or a 1.5 g gold dollar, and
     * pm-reference.ts answers null rather than choose. But if the owner has
     * already written "Gold" in the Metal field, that is not a guess — it is
     * their own statement, and it is the same kind of evidence the Quicken
     * import gets from a security name reading "G$1". */
    const withoutHint = pmFieldsToFill(coin({ denomination: '$1', year: '1855' }));
    expect(withoutHint).toEqual({});

    const withHint = pmFieldsToFill(coin({
      denomination: '$1',
      year: '1855',
      metalContent: 'Gold'
    }));
    expect(withHint).toEqual({
      composition: '90% Gold, 10% Copper',
      pmPercent: 90,
      pmWeightGrams: 1.50,
      // 1.672 g gross — the gold dollar is the smallest coin the US ever
      // struck, and getting this instead of the silver dollar's 26.73 g is
      // the whole value of the hint.
      weight: 1.672
    });
  });
});

/* ===========================================================================
 * THE DELIBERATE GAPS — coins the backfill must leave alone
 * ======================================================================== */

describe('the deliberate gaps are inherited, not patched over', () => {
  // Each of these is a year/denomination where TWO alloys were struck and
  // nothing in the record says which. pm-reference.ts marks them
  // "*** DELIBERATE GAP ***" and answers null. The backfill adds no new rules,
  // so it must answer "nothing to do" for all of them.
  const ambiguous: { what: string; denomination: string; year: string }[] = [
    { what: 'the 1942 Jefferson nickel (cupronickel AND 35% silver)', denomination: '5¢', year: '1942' },
    { what: 'the 1982 Lincoln cent (bronze AND copper-plated zinc)', denomination: '1¢', year: '1982' },
    { what: 'a 1974 Eisenhower dollar (clad AND 40% silver)', denomination: '$1', year: '1974' },
    { what: 'a bare $1 in the gold-dollar era', denomination: '$1', year: '1860' }
  ];

  for (const { what, denomination, year } of ambiguous) {
    it(`leaves ${what} completely alone`, () => {
      expect(pmFieldsToFill(coin({ denomination, year }))).toEqual({});

      const plan = planPmBackfill([coin({ id: 'amb', denomination, year })]);
      expect(plan.fillableCount).toBe(0);
      expect(plan.undeterminedCount).toBe(1);
      expect(plan.candidates).toEqual([]);
    });
  }

  it('leaves a coin the reference table has never heard of alone', () => {
    // Nothing in the table covers a Japanese 100 Yen. No entry means no guess:
    // the coin is reported as undetermined and never written to.
    const plan = planPmBackfill([
      coin({ id: 'yen', denomination: '100 Yen', year: '1964', country: 'Japan' })
    ]);

    expect(plan.fillableCount).toBe(0);
    expect(plan.undeterminedCount).toBe(1);
  });

  it('leaves a coin with no year alone', () => {
    // Almost every rule in the reference table is year-dependent, so a record
    // with no year is unanswerable by construction.
    const plan = planPmBackfill([coin({ id: 'noyear', denomination: '25¢', year: '' })]);

    expect(plan.fillableCount).toBe(0);
    expect(plan.undeterminedCount).toBe(1);
  });
});

/* ===========================================================================
 * THE PREVIEW
 * ======================================================================== */

describe('planPmBackfill — the preview the user confirms', () => {
  /** One of each kind of coin, so every bucket gets exactly one member. */
  function mixedInventory(): CoinRecord[] {
    return [
      // fillable: nothing recorded, and the table knows it
      coin({ id: 'fill-1', denomination: '$20', year: '1927' }),
      // fillable: partly recorded, gaps can be completed
      coin({ id: 'fill-2', denomination: '50¢', year: '1964', metalContent: 'Silver' }),
      // already complete: all five present
      coin({
        id: 'done-1',
        denomination: '$10',
        year: '1901',
        metalContent: 'Gold',
        composition: '90% Gold, 10% Copper',
        pmPercent: 90,
        pmWeightGrams: 15.05,
        weight: 16.718
      }),
      // already complete: base metal with everything the table knows
      // recorded. For a base-metal coin that is three of the five — metal,
      // composition and gross weight — because it genuinely has no precious
      // metal content to record.
      coin({
        id: 'done-2',
        denomination: '1¢',
        year: '1983',
        metalContent: 'Zinc',
        composition: 'Copper-plated zinc (97.5% Zn, 2.5% Cu)',
        weight: 2.50
      }),
      // undetermined: a deliberate gap
      coin({ id: 'gap-1', denomination: '5¢', year: '1942' })
    ];
  }

  it('counts fillable, already-complete and undetermined coins separately', () => {
    const plan = planPmBackfill(mixedInventory());

    expect(plan.fillableCount).toBe(2);
    expect(plan.alreadyCompleteCount).toBe(2);
    expect(plan.undeterminedCount).toBe(1);
    expect(plan.totalScanned).toBe(5);
  });

  it('partitions the inventory — the counts add up to the total', () => {
    // A preview whose numbers do not add up is a preview nobody should trust
    // enough to press Run on.
    const plan = planPmBackfill(mixedInventory());

    expect(
      plan.fillableCount + plan.alreadyCompleteCount +
      plan.undeterminedCount + plan.skippedDraftCount
    ).toBe(plan.totalScanned);
  });

  it('does not count a base-metal coin as "cannot be determined"', () => {
    /* A 1983 cent that already says "Zinc" is missing PM % and PM weight only
     * because it HAS no precious metal. Reporting it alongside the 1942 nickel
     * would make the "cannot be determined" figure look alarming and would be
     * untrue: the table answered perfectly well. */
    const plan = planPmBackfill([coin({
      id: 'zinc',
      denomination: '1¢',
      year: '1983',
      metalContent: 'Zinc',
      composition: 'Copper-plated zinc (97.5% Zn, 2.5% Cu)',
      weight: 2.50
    })]);

    expect(plan.undeterminedCount).toBe(0);
    expect(plan.alreadyCompleteCount).toBe(1);
  });

  it('counts a base-metal coin that is only missing its WEIGHT as fillable', () => {
    /* The same 1983 cent with its weight not yet recorded. It is not
     * "already complete" any more, and it is certainly not "undetermined" —
     * the table knows it weighs 2.50 g. It is a coin with something to gain,
     * which is exactly what `fillable` means. This is the single commonest
     * case in the owner's existing database, because nothing before now ever
     * wrote the Weight column. */
    const plan = planPmBackfill([coin({
      id: 'zinc-no-weight',
      denomination: '1¢',
      year: '1983',
      metalContent: 'Zinc',
      composition: 'Copper-plated zinc (97.5% Zn, 2.5% Cu)'
    })]);

    expect(plan.undeterminedCount).toBe(0);
    expect(plan.fillableCount).toBe(1);
    expect(plan.candidates[0].updates).toEqual({ weight: 2.50 });
  });

  it('skips rows that have never been saved to the database', () => {
    // A draft has no server row, so a PUT would 404. It is excluded rather
    // than counted as a failure — it will be picked up by a later run once the
    // row saves itself.
    const coins = [
      coin({ id: 'saved', denomination: '$20', year: '1927' }),
      coin({ id: 'draft', denomination: '$20', year: '1927' })
    ];

    const plan = planPmBackfill(coins, (id) => id === 'draft');

    expect(plan.skippedDraftCount).toBe(1);
    expect(plan.fillableCount).toBe(1);
    expect(plan.candidates.map(c => c.coinId)).toEqual(['saved']);
  });

  it('writes nothing — the preview is pure', () => {
    // There is no way to assert "no HTTP happened" on a pure function, so the
    // guarantee is structural: planPmBackfill takes an array and returns an
    // object, and the coins it was handed come back unmodified.
    const coins = mixedInventory();
    const before = JSON.stringify(coins);

    planPmBackfill(coins);

    expect(JSON.stringify(coins)).toBe(before);
  });
});

/* ===========================================================================
 * THE PAYLOAD
 * ======================================================================== */

describe('the update payload carries ONLY precious-metal fields', () => {
  it('never includes a key outside the five alloy / weight fields', () => {
    /* THE RULE THIS GUARDS: `PUT /api/coins/:id` applies whatever it is given,
     * and this project has previously blanked out columns by sending whole
     * records. Every candidate payload is checked against the allow-list by
     * name, not just by count. */
    const plan = planPmBackfill([
      coin({ id: 'a', denomination: '$20', year: '1927', notes: 'do not touch me' }),
      coin({ id: 'b', denomination: '50¢', year: '1964', grade: 'MS65' }),
      coin({ id: 'c', denomination: '1¢', year: '1909', purchasePrice: 400 })
    ]);

    expect(plan.candidates.length).toBe(3);
    for (const candidate of plan.candidates) {
      for (const key of Object.keys(candidate.updates)) {
        expect(PM_FIELD_KEYS).toContain(key);
      }
    }
  });

  it('strips anything that is not an alloy field, as a second line of defence', () => {
    const cleaned = onlyPmFields({
      metalContent: 'Gold',
      pmWeightGrams: 30.09,
      // `weight` is on the allow-list and must SURVIVE. It was the newest
      // addition to PM_FIELD_KEYS, and an allow-list that silently dropped it
      // would turn the whole gross-weight feature into a no-op on the
      // backfill path without failing anything else.
      weight: 33.436,
      notes: 'should be dropped',
      imagePaths: ['definitely should be dropped']
    } as Partial<CoinRecord>);

    expect(Object.keys(cleaned).sort()).toEqual(['metalContent', 'pmWeightGrams', 'weight']);
  });

  it('still drops a non-alloy numeric field that looks weight-ish', () => {
    // `weight` is allowed; nothing else is, however plausible it looks.
    const cleaned = onlyPmFields({
      weight: 33.436,
      purchasePrice: 1800,
      currentValue: 2400
    } as Partial<CoinRecord>);

    expect(Object.keys(cleaned)).toEqual(['weight']);
  });
});

/* ===========================================================================
 * THE RUN
 * ======================================================================== */

describe('runPmBackfill — the writes', () => {
  function planFor(coins: CoinRecord[]): PmBackfillPlan {
    return planPmBackfill(coins);
  }

  it('writes every candidate exactly once, and nothing else', async () => {
    const coins = [
      coin({ id: 'a', denomination: '$20', year: '1927' }),
      coin({ id: 'b', denomination: '50¢', year: '1964' }),
      coin({ id: 'gap', denomination: '5¢', year: '1942' }),     // undetermined
      coin({                                                       // already complete
        id: 'done',
        denomination: '$10',
        year: '1901',
        metalContent: 'Gold',
        composition: '90% Gold, 10% Copper',
        pmPercent: 90,
        pmWeightGrams: 15.05,
        weight: 16.718
      })
    ];
    const plan = planFor(coins);
    const write = vi.fn(async (_coinId: string, _updates: Partial<CoinRecord>) => undefined);

    const outcome = await runPmBackfill(plan, write);

    // The preview said 2 could be filled; exactly 2 writes went out.
    expect(plan.fillableCount).toBe(2);
    expect(write).toHaveBeenCalledTimes(2);
    expect(outcome.attempted).toBe(2);
    expect(outcome.filled).toBe(2);

    const writtenIds = write.mock.calls.map(([id]) => id);
    expect(writtenIds.sort()).toEqual(['a', 'b']);
    // No duplicates — "exactly once" means exactly once.
    expect(new Set(writtenIds).size).toBe(writtenIds.length);
  });

  it('what the preview promised is what the run performed', async () => {
    // Not merely the same COUNT: the same coins and the same payload objects.
    const plan = planFor([
      coin({ id: 'a', denomination: '$20', year: '1927' }),
      coin({ id: 'b', denomination: '50¢', year: '1964', metalContent: 'Silver' })
    ]);
    const write = vi.fn(async (_coinId: string, _updates: Partial<CoinRecord>) => undefined);

    await runPmBackfill(plan, write);

    expect(write.mock.calls).toEqual(
      plan.candidates.map(candidate => [candidate.coinId, candidate.updates])
    );
  });

  it('writes one coin at a time, never in parallel', async () => {
    /* THE TRAP THIS GUARDS AGAINST. The ordinary edit path debounces saves by
     * one second, keyed per coin — so a loop over several hundred coins would
     * set several hundred independent timers in one tick and then fire every
     * PUT simultaneously. This run awaits each write before starting the next,
     * so there is never more than one request in flight. */
    let inFlight = 0;
    let maxInFlight = 0;

    const plan = planFor([
      coin({ id: 'a', denomination: '$20', year: '1927' }),
      coin({ id: 'b', denomination: '50¢', year: '1964' }),
      coin({ id: 'c', denomination: '10¢', year: '1916' }),
      coin({ id: 'd', denomination: '25¢', year: '1932' })
    ]);

    await runPmBackfill(plan, async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 0));
      inFlight -= 1;
    });

    expect(plan.fillableCount).toBe(4);
    expect(maxInFlight).toBe(1);
  });

  it('reports progress as a real count of completed writes', async () => {
    const plan = planFor([
      coin({ id: 'a', denomination: '$20', year: '1927' }),
      coin({ id: 'b', denomination: '50¢', year: '1964' })
    ]);
    const seen: number[] = [];

    await runPmBackfill(plan, async () => undefined, (p) => seen.push(p.processed));

    expect(seen).toEqual([0, 1, 2]);
  });

  it('keeps going after a failure and names the coins that failed', async () => {
    // Giving up halfway because one row was locked would be worse than
    // finishing and reporting "2 of 3, here is the one that failed".
    const plan = planFor([
      coin({ id: 'a', denomination: '$20', year: '1927' }),
      coin({ id: 'b', denomination: '50¢', year: '1964' }),
      coin({ id: 'c', denomination: '10¢', year: '1916' })
    ]);

    const outcome = await runPmBackfill(plan, async (coinId) => {
      if (coinId === 'b') throw new Error('deadlock victim');
    });

    expect(outcome.attempted).toBe(3);
    expect(outcome.filled).toBe(2);
    expect(outcome.failed).toBe(1);
    expect(outcome.failures).toEqual([
      { coinId: 'b', label: '1964 50¢', reason: 'deadlock victim' }
    ]);
  });
});
