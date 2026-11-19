 /*
  * Denomination linking in `CsvService.mapRowToCoin` (shared by CSV and Excel).
  * A coin keeps the text the file gave and may also link to a Denominations row.
  *   1. The text is never changed.
  *   2. Unresolved is normal: no warning or rejection; the coin reads e.g. `Other (8 Reales)`.
  *   3. Resolution is scoped by the row's own country.
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
    // Not '$1': the text stays what the file said.
    expect(coin.denomination).toBe('Dollar');
  });

  it('folds spellings through the existing alias layer', () => {
    // '3CS', 'Trime' and 'Three Cent Silver' are one denomination (via the alias table).
    const trime = seedDenomination('United States', '3CS');
    for (const spelling of ['3CS', 'Trime', 'Three Cent Silver', '3cs']) {
      const coin = mapRow({ denomination: spelling, year: '1861' });
      expect(coin.denominationId, spelling).toBe(trime!.denominationId);
      expect(coin.denomination, spelling).toBe(spelling);
    }
  });

  it('uses the COUNTRY COLUMN of the row, not a constant', () => {
    // 'Penny' exists under Australia, New Zealand and Ireland: scoped to one it
    // links; unscoped it must not.
    const australian = seedDenomination('Australia', 'Penny');
    expect(australian, 'the seed should carry an Australian Penny').toBeTruthy();

    expect(mapRow({ denomination: 'Penny', country: 'Australia', year: '1920' }).denominationId)
      .toBe(australian!.denominationId);

    // No Country column: defaults to 'United States', which has no Penny; three
    // other issuers do, so no link.
    expect(mapRow({ denomination: 'Penny', year: '1920' }).denominationId).toBeNull();
  });

  it('widens past the country rather than giving up', () => {
    // Only Peru struck a 100 Soles, so a row filed under the United States still links.
    const soles = seedDenomination('Peru', '100 Soles');
    const coin = mapRow({ denomination: '100 Soles', country: 'United States', year: '1967' });
    expect(coin.denominationId).toBe(soles!.denominationId);
  });
});

describe('an unlinked row is a normal import, not a problem', () => {
  it('imports an ambiguous value with its text and no link', () => {
    // Six issuers struck an 8 Reales; no guess.
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
    // Resolution never affects whether a row is imported; only the 2-of-3
    // completeness rule does.
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
    // No lookup (not loaded yet): nothing links, nothing fails, text intact.
    const coin = csv.mapRowToCoin(['Dollar', '1881'], ['Denomination', 'Year'], {
      Denomination: 'denomination',
      Year: 'year'
    });
    expect(coin.denomination).toBe('Dollar');
    expect(coin.denominationId).toBeNull();
  });
});

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
      ['8 Reales', '1753'],    // ambiguous, no link
      ['', '1881']             // rejected by the 2-of-3 rule, not counted
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
      { sheetName: 'US', accepted: 2, rejected: 0, linkedDenominations: 2, excludedAsSold: 0 },
      { sheetName: 'World', accepted: 1, rejected: 0, linkedDenominations: 0, excludedAsSold: 0 }
    ]);
  });

  it('reads zero when the whole column is wrong, which is the point of showing it', () => {
    // A Grade column mapped onto Denomination imports but links nothing; the
    // count of 0 flags the bad mapping.
    const result = plan([['MS63', '1881'], ['VF30', '1943']]);
    expect(result.acceptedCount).toBe(2);
    expect(result.linkedDenominations).toBe(0);
  });
});

describe('a 2,000-row spreadsheet does not re-read the lookup table', () => {
  it('reads the lookup the same number of times for 10 rows and for 2,000', () => {
    // Counts reads of each lookup row's `label` to prove the resolver index is
    // built once: the same reads for 10 rows as for 2,000. (The preview re-plans
    // on every mapping change.) Deterministic rather than a timing assertion.
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

    // Non-vacuity: the lookup really was read.
    expect(small.reads()).toBeGreaterThanOrEqual(SEED_DENOMINATIONS.length);
    // 200x the rows, the same work against the lookup table.
    expect(large.reads()).toBe(small.reads());
  });
});
