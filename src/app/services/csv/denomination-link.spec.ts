 /*
 * denomination-link.spec.ts — the CSV and Excel import path, linking
 * ---- WHAT IS UNDER TEST ----
 * `CsvService.mapRowToCoin` is where a spreadsheet row becomes a coin, and
 * since migration 011 a coin carries BOTH the text the file gave and a link
 * to the Denominations row it names (design §4.1, §6). Excel is not a second
 * path: `.xlsx` sheets converge on this same mapper below the mapping grid,
 * so what is proved here is proved for both.
 *
 * ---- THE THREE THINGS THAT MUST STAY TRUE ----
 *   1. THE TEXT IS NEVER TOUCHED. Not trimmed into a label, not replaced by
 *      the row it resolved to, not cleared when it resolves to nothing. It
 *      is the only surviving record of what the file said (§4.1) and the
 *      input to a later, smarter resolver.
 *   2. UNRESOLVED IS NORMAL. No warning, no rejection, no invented
 *      denomination. The coin imports and reads `Other (8 Reales)`.
 *   3. THE COUNTRY IS THE ROW'S OWN. Resolution is scoped by it before it
 *      widens, so feeding a constant would silently change which coins link.
  */

import { describe, expect, it } from 'vitest';

import { CsvService } from '../csv.service';
import { planImport } from './import-plan';
import { SEED_DENOMINATIONS, seedDenomination } from '../../testing/seed-denominations.fixture';
import type { Denomination } from '../../types/coin.model';

const csv = new CsvService();

/** One row, mapped the way the import screen maps it. */
function mapRow(
  cells: Record<string, string>,
  denominations: readonly Denomination[] = SEED_DENOMINATIONS
) {
  const headers = Object.keys(cells);
  const mapping: Record<string, string> = {};
  for (const header of headers) mapping[header] = header;
  return csv.mapRowToCoin(headers.map(header => cells[header]), headers, mapping, denominations);
}

describe('mapRowToCoin links the denomination it was given', () => {
  it('sets the id and leaves the text exactly as the file wrote it', () => {
    const dollar = seedDenomination('United States', '$1');
    const coin = mapRow({ coinType: 'Morgan Dollar', denomination: 'Dollar', year: '1881' });

    expect(coin.denominationId).toBe(dollar!.denominationId);
    // NOT '$1'. The label is what the id means; the text is what the file
    // said, and rewriting it here would destroy the evidence §4.1 exists to
    // keep.
    expect(coin.denomination).toBe('Dollar');
  });

  it('folds spellings through the existing alias layer', () => {
    // '3CS', 'Trime' and 'Three Cent Silver' are one denomination. The
    // alias table already knew that; nothing here re-states it.
    const trime = seedDenomination('United States', '3CS');
    for (const spelling of ['3CS', 'Trime', 'Three Cent Silver', '3cs']) {
      const coin = mapRow({ denomination: spelling, year: '1861' });
      expect(coin.denominationId, spelling).toBe(trime!.denominationId);
      expect(coin.denomination, spelling).toBe(spelling);
    }
  });

  it('uses the COUNTRY COLUMN of the row, not a constant', () => {
    /* The assertion that catches a hard-coded country, and the pair matters
     * more than either half. 'Penny' is a label under Australia, New Zealand
     * and Ireland: scoped to one of them it is unambiguous and must link;
     * unscoped it has no right answer and must not. */
    const australian = seedDenomination('Australia', 'Penny');
    expect(australian, 'the seed should carry an Australian Penny').toBeTruthy();

    expect(mapRow({ denomination: 'Penny', country: 'Australia', year: '1920' }).denominationId)
      .toBe(australian!.denominationId);

    // No Country column at all: the mapper's own default, 'United States',
    // which strikes no Penny. Three issuers do, so the id stays null.
    expect(mapRow({ denomination: 'Penny', year: '1920' }).denominationId).toBeNull();
  });

  it('widens past the country rather than giving up', () => {
    // Only Peru struck a 100 Soles, so a row filed under the United States
    // still links. This is the case design §5 widens for.
    const soles = seedDenomination('Peru', '100 Soles');
    const coin = mapRow({ denomination: '100 Soles', country: 'United States', year: '1967' });
    expect(coin.denominationId).toBe(soles!.denominationId);
  });
});

describe('an unlinked row is a normal import, not a problem', () => {
  it('imports an ambiguous value with its text and no link', () => {
    // Six issuers struck an 8 Reales. Guessing one would file the coin
    // under an issuer the owner never chose, invisibly and permanently.
    const coin = mapRow({ denomination: '8 Reales', country: 'United States', year: '1753' });
    expect(coin.denominationId).toBeNull();
    expect(coin.denomination).toBe('8 Reales');
  });

  it('imports a value no row names, with its text and no link', () => {
    const coin = mapRow({ denomination: 'Pillar Dollar', year: '1753', coinType: 'Pillar' });
    expect(coin.denominationId).toBeNull();
    expect(coin.denomination).toBe('Pillar Dollar');
  });

  it('counts both as accepted rows — unresolved never blocks an import', () => {
    /* THE RULE THIS PROTECTS. The 2-of-3 completeness rule decides what is
     * imported; resolution decides only whether there is a link. Wiring the
     * second into the first would reject several hundred perfectly good
     * rows per file, and the "import anyway" override was deliberately
     * removed precisely because the completeness rule is the only gate
     * there is. */
    const headers = ['Denomination', 'Year'];
    const mapping = { Denomination: 'denomination', Year: 'year' };
    const plan = planImport(
      [{ headers, rows: [['8 Reales', '1753'], ['Pillar Dollar', '1753'], ['Dollar', '1881']] }],
      mapping,
      (row, heads, map) => csv.mapRowToCoin(row, heads, map, SEED_DENOMINATIONS)
    );

    expect(plan.acceptedCount).toBe(3);
    expect(plan.rejected).toEqual([]);
  });

  it('leaves a blank denomination alone', () => {
    const coin = mapRow({ denomination: '', year: '1881', coinType: 'Morgan Dollar' });
    expect(coin.denominationId).toBeNull();
    expect(coin.denomination).toBe('');
  });
});

describe('without a lookup list', () => {
  it('maps exactly as it always did', () => {
    // The lookup has not arrived from the server, or a caller predates this
    // argument. Nothing links, nothing fails, and the text is intact.
    const coin = csv.mapRowToCoin(['Dollar', '1881'], ['Denomination', 'Year'], {
      Denomination: 'denomination',
      Year: 'year'
    });
    expect(coin.denomination).toBe('Dollar');
    expect(coin.denominationId).toBeNull();
  });
});

/* ---- THE PREVIEW'S COUNT ---- */

describe('planImport reports how many rows linked', () => {
  const headers = ['Denomination', 'Year'];
  const mapping = { Denomination: 'denomination', Year: 'year' };

  function plan(rows: string[][]) {
    return planImport([{ headers, rows }], mapping, (row, heads, map) =>
      csv.mapRowToCoin(row, heads, map, SEED_DENOMINATIONS)
    );
  }

  it('counts the accepted rows that carry a link', () => {
    const result = plan([
      ['Dollar', '1881'],      // links
      ['3CS', '1861'],         // links
      ['8 Reales', '1753'],    // ambiguous — no link
      ['', '1881']             // rejected by the 2-of-3 rule, not counted at all
    ]);

    expect(result.acceptedCount).toBe(3);
    expect(result.linkedDenominations).toBe(2);
    expect(result.rejected).toHaveLength(1);
  });

  it('counts per sheet as well, because that is where the user looks', () => {
    const result = planImport(
      [
        { sheetName: 'US', headers, rows: [['Dollar', '1881'], ['3CS', '1861']] },
        { sheetName: 'World', headers, rows: [['8 Reales', '1753']] }
      ],
      mapping,
      (row, heads, map) => csv.mapRowToCoin(row, heads, map, SEED_DENOMINATIONS)
    );

    expect(result.perSheet).toEqual([
      { sheetName: 'US', accepted: 2, rejected: 0, linkedDenominations: 2 },
      { sheetName: 'World', accepted: 1, rejected: 0, linkedDenominations: 0 }
    ]);
  });

  it('reads zero when the whole column is wrong, which is the point of showing it', () => {
    // A `Grade` column mapped onto Denomination. Every row still imports if
    // it has 2 of 3, and nothing warns -- but the count says 0, which is
    // the cheap signal that the mapping is wrong while it is still cheap to
    // fix.
    const result = plan([['MS63', '1881'], ['VF30', '1943']]);
    expect(result.acceptedCount).toBe(2);
    expect(result.linkedDenominations).toBe(0);
  });
});

/* ---- COST ---- */

describe('a 2,000-row spreadsheet does not re-read the lookup table', () => {
  it('reads the lookup the same number of times for 10 rows and for 2,000', () => {
    /* A DETERMINISTIC COST ASSERTION, NOT A TIMING ONE.
     *
     * `resolveDenomination`'s first act is to fold EVERY row it is given
     * through the alias table. Called the naive way, 2,000 spreadsheet rows
     * against 1,161 denominations is 2.3 million folds -- and the CSV
     * preview re-plans on every change to the mapping grid, so that cost
     * sits on the keystroke path, not just behind the Import button.
     *
     * Counting the reads of every lookup row's `label` proves the index is
     * built once and reused: the SAME number of reads for ten rows as for
     * two thousand. How many reads one build costs is an implementation
     * detail and is deliberately not asserted -- what matters is that the
     * number does not grow with the file. A timing assertion would say the
     * same thing less clearly and would flake on a loaded machine. */
    function countingLookup(): { rows: Denomination[]; reads: () => number } {
      let reads = 0;
      const rows = SEED_DENOMINATIONS.map(row => {
        const { label, ...rest } = row;
        return {
          ...rest,
          get label() {
            reads += 1;
            return label;
          }
        } as Denomination;
      });
      return { rows, reads: () => reads };
    }

    function planRows(count: number, lookup: Denomination[]) {
      const rows = Array.from({ length: count }, (_unused, i) => [
        i % 2 === 0 ? 'Dollar' : '8 Reales',
        String(1850 + (i % 100))
      ]);
      return planImport(
        [{ headers: ['Denomination', 'Year'], rows }],
        { Denomination: 'denomination', Year: 'year' },
        (row, heads, map) => csv.mapRowToCoin(row, heads, map, lookup)
      );
    }

    const small = countingLookup();
    const large = countingLookup();

    expect(planRows(10, small.rows).acceptedCount).toBe(10);
    const big = planRows(2000, large.rows);

    expect(big.acceptedCount).toBe(2000);
    expect(big.linkedDenominations).toBe(1000);

    // Non-vacuity: the lookup really was read, so an index that read
    // nothing at all could not pass this by scoring zero twice.
    expect(small.reads()).toBeGreaterThanOrEqual(SEED_DENOMINATIONS.length);
    // 200x the rows, the same work against the lookup table.
    expect(large.reads()).toBe(small.reads());
  });
});
