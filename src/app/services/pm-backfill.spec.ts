/**
 * Tests for the "backfill precious-metal data" maintenance action. It must not
 * overwrite existing values, guess where pm-reference.ts declines, send fields
 * other than the alloy fields, or do anything other than what the preview shows.
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

/** A coin with everything filled in except the overrides. */
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

 /*
  * `composePmFields` is the shared adapter used by both the Quicken import and
  * this backfill, so imported and backfilled coins agree.
  */

describe('composePmFields — the mapping both the import and the backfill use', () => {
  it('names its result with CoinRecord field names, not the reference table\'s', () => {
    // pm-reference.ts says `metal`; a coin record says `metalContent`.
    const fields = composePmFields('$20', '1927', 'United States');

    expect(fields).toEqual({
      metalContent: 'Gold',
      composition: '90% Gold, 10% Copper',
      pmPercent: 90,
      pmWeightGrams: 30.09,
      // The table's `grossWeightGrams` becomes the record's `weight`.
      weight: 33.436
    });
  });

  it('distinguishes the coin\'s GROSS weight from the pure metal in it', () => {
    // Gross (33.436 g) and pure gold (30.09 g) are different numbers.
    const fields = composePmFields('$20', '1927', 'United States');

    expect(fields?.weight).toBeCloseTo(33.436, 3);
    expect(fields?.pmWeightGrams).toBeCloseTo(30.09, 2);
    // ...and they agree with the purity.
    expect(fields!.weight! * (fields!.pmPercent! / 100)).toBeCloseTo(fields!.pmWeightGrams!, 2);
  });

  it('reports a GROSS weight for base metal, where there is no PM weight at all', () => {
    // A 1983 cent has no melt value but a known weight.
    const fields = composePmFields('1¢', '1983', 'United States');

    expect(fields?.weight).toBeCloseTo(2.50, 2);
    expect(fields?.pmWeightGrams).toBeUndefined();
  });

  it('offers no weight when only the COARSE metal fallback could answer', () => {
    // The coarse answer (1934 is outside the double eagle's band) names the metal
    // only; no weight is invented.
    const fields = composePmFields('$20', '1934', 'United States');

    expect(fields?.metalContent).toBe('Gold');
    expect(fields?.weight).toBeUndefined();
    expect(fields?.pmWeightGrams).toBeUndefined();
  });

  it('answers for base metal too, with the two PM numbers left undefined', () => {
    // A bronze cent has a metal and composition but no PM; the PM fields stay absent, not 0.
    const fields = composePmFields('1¢', '1909', 'United States');

    expect(fields?.metalContent).toBe('Bronze');
    expect(fields?.pmWeightGrams).toBeUndefined();
    expect(fields?.pmPercent).toBeUndefined();
  });
});

/* Only fill blanks */

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
    // The user's own purity and weight win: a worn coin really weighs less, and a
    // weight is the field most likely to have been measured.
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
    // The one field the user supplied is one the table also knows; the user's wins.
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
    // A 0 is a value someone entered.
    const updates = pmFieldsToFill(coin({ denomination: '$20', year: '1927', weight: 0 }));

    expect(updates).not.toHaveProperty('weight');
    expect(updates).toHaveProperty('metalContent', 'Gold');
  });

  it('completes the GAPS on a partly-filled coin rather than skipping it', () => {
    /* Melt value needs both metalContent and pmWeightGrams, so coins with only the
     * metal typed in must have their gaps completed, not skipped. */
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
    // 0 is not a blank here (unlike spot prices, a PM weight can really be 0).
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
    // Copper-plated zinc: PM fields stay blank, but the 2.50 g weight is filled.
    const updates = pmFieldsToFill(coin({ denomination: '1¢', year: '1983' }));

    expect(Object.keys(updates).sort()).toEqual(['composition', 'metalContent', 'weight']);
    expect(updates).not.toHaveProperty('pmWeightGrams');
    expect(updates).not.toHaveProperty('pmPercent');
  });

  it('withholds the weight too where the table genuinely does not have one', () => {
    // The large cent row has no gross weight (two planchets), so weight isn't invented.
    const updates = pmFieldsToFill(coin({ denomination: '1¢', year: '1820' }));

    expect(updates).toHaveProperty('metalContent', 'Copper');
    expect(updates).not.toHaveProperty('weight');
  });

  it('uses the coin\'s own recorded metal to settle a tie the table refuses', () => {
    /* An 1855 "$1" is a silver or a gold dollar and the table returns null. A
     * recorded "Gold" is the user's own statement, used as a hint. */
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
      // The gold dollar's 1.672 g rather than the silver dollar's 26.73 g.
      weight: 1.672
    });
  });
});

/* Deliberate gaps: coins the backfill must leave alone */

describe('the deliberate gaps are inherited, not patched over', () => {
  // Each had two alloys struck that year; pm-reference.ts returns null, so the
  // backfill does nothing.
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
    // No table entry for a Japanese 100 Yen: undetermined, never written.
    const plan = planPmBackfill([
      coin({ id: 'yen', denomination: '100 Yen', year: '1964', country: 'Japan' })
    ]);

    expect(plan.fillableCount).toBe(0);
    expect(plan.undeterminedCount).toBe(1);
  });

  it('leaves a coin with no year alone', () => {
    // Most rules are year-dependent, so no year means no answer.
    const plan = planPmBackfill([coin({ id: 'noyear', denomination: '25¢', year: '' })]);

    expect(plan.fillableCount).toBe(0);
    expect(plan.undeterminedCount).toBe(1);
  });
});

/* The preview */

describe('planPmBackfill — the preview the user confirms', () => {
  /** One coin per bucket. */
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
      // already complete: base metal with everything the table knows (metal,
      // composition, gross weight)
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
    // The counts must add up.
    const plan = planPmBackfill(mixedInventory());

    expect(
      plan.fillableCount + plan.alreadyCompleteCount +
      plan.undeterminedCount + plan.skippedDraftCount
    ).toBe(plan.totalScanned);
  });

  it('does not count a base-metal coin as "cannot be determined"', () => {
    /* A 1983 cent missing PM fields because it has none is "already complete",
     * not "undetermined". */
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
    /* The same cent without its weight is fillable (the table knows 2.50 g). The
     * most common case in existing data, since Weight was never written before. */
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
    // Drafts have no server row (a PUT would 404); excluded, not failed.
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
    // A pure function: coins come back unmodified.
    const coins = mixedInventory();
    const before = JSON.stringify(coins);

    planPmBackfill(coins);

    expect(JSON.stringify(coins)).toBe(before);
  });
});

/* The payload */

describe('the update payload carries ONLY precious-metal fields', () => {
  it('never includes a key outside the five alloy / weight fields', () => {
    /* `PUT /api/coins/:id` applies whatever it is given, so every payload is
     * checked against the allow-list by name. */
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
      // `weight` is on the allow-list and must survive.
      weight: 33.436,
      notes: 'should be dropped',
      imagePaths: ['definitely should be dropped']
    } as Partial<CoinRecord>);

    expect(Object.keys(cleaned).sort()).toEqual(['metalContent', 'pmWeightGrams', 'weight']);
  });

  it('still drops a non-alloy numeric field that looks weight-ish', () => {
    // `weight` is allowed; nothing else is.
    const cleaned = onlyPmFields({
      weight: 33.436,
      purchasePrice: 1800,
      currentValue: 2400
    } as Partial<CoinRecord>);

    expect(Object.keys(cleaned)).toEqual(['weight']);
  });
});

/* The run */

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

    // The preview said 2; exactly 2 writes went out.
    expect(plan.fillableCount).toBe(2);
    expect(write).toHaveBeenCalledTimes(2);
    expect(outcome.attempted).toBe(2);
    expect(outcome.filled).toBe(2);

    const writtenIds = write.mock.calls.map(([id]) => id);
    expect(writtenIds.sort()).toEqual(['a', 'b']);
    // No duplicates.
    expect(new Set(writtenIds).size).toBe(writtenIds.length);
  });

  it('what the preview promised is what the run performed', async () => {
    // The same coins and the same payload objects, not just the same count.
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
    /* The normal edit path debounces per coin, which would fire every PUT at once;
     * the run awaits each write, so at most one request is in flight. */
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
    // A failure doesn't stop the run: "2 of 3, here is the one that failed".
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
