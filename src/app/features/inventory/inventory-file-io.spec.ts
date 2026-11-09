/*
 * What goes into an insurance schedule, and what must not.
 *
 * THE MISTAKE THIS PREVENTS
 * "Export -> Insurance CSV" produces the list the owner hands to an insurer.
 * Because the inventory can hold a want list, the naive version of that
 * export — every row in the file — would schedule coins he does not own, at
 * the values he hopes to pay for them one day. That document would then be:
 *
 *   - a premium paid, every year, on coins that are not in the house; and
 *   - a claim that gets denied the first time it is tested, because the
 *     adjuster asks to see a coin that was never bought.
 *
 * It is the single most expensive thing this feature could get wrong, and it
 * would be invisible: the CSV would look perfectly ordinary.
 *
 * WHY THE FILTER LIVES AT THE CALL SITE AND NOT IN CsvService
 * `CsvService.exportInsuranceCsv(coins)` formats whatever list it is handed —
 * that is all it does, and it is the right shape for it. WHICH coins belong
 * in an insurance schedule is a policy question about the collection, and
 * this class is where the app decides what to hand the formatter. Pushing the
 * rule into the formatter would also make it the only export function with an
 * opinion about its own input.
 */

import { describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { InventoryFileIo } from './inventory-file-io';
import { CsvService } from '../../services/csv.service';
import { InventoryService } from '../../services/inventory.service';
import { CoinRecord } from '../../types/coin.model';

function makeCoin(overrides: Partial<CoinRecord> = {}): CoinRecord {
  return {
    id: crypto.randomUUID(), denomination: 'Dollar', year: '1881', coinType: 'Morgan',
    category: 'Silver', country: 'United States', grade: 'MS63', certCompany: '',
    certNumber: '', variety: '', mintMark: 'S', composition: '',
    purchaseDate: '2024-01-01', purchasePrice: 100, currentValue: 150, notes: '',
    imagePaths: [], source: 'manual', hasCacSticker: false,
    ...overrides
  } as CoinRecord;
}

/**
 * Captures the coin list each export is handed, without touching the DOM:
 * both real export functions end in a Blob and an invisible anchor click,
 * and these specs run under Node.
 */
function ioOver(coins: CoinRecord[]) {
  const exportInsuranceCsv = vi.fn();
  const exportCsv = vi.fn();
  const csv = { exportInsuranceCsv, exportCsv } as unknown as CsvService;
  const inv = { inventory: signal(coins) } as unknown as InventoryService;

  return { io: new InventoryFileIo(inv, csv), exportInsuranceCsv, exportCsv };
}

describe('the insurance schedule', () => {
  it('leaves out a wanted coin', () => {
    // The headline case. A want list scheduled for insurance is a premium
    // paid on coins that are not in the house.
    const { io, exportInsuranceCsv } = ioOver([
      makeCoin({ coinType: 'Morgan' }),
      makeCoin({ coinType: 'Draped Bust', collectionStatus: 'wanted', currentValue: 250000 })
    ]);

    io.exportInsuranceCsv();

    expect(exportInsuranceCsv).toHaveBeenCalledTimes(1);
    expect(exportInsuranceCsv.mock.calls[0][0].map((c: CoinRecord) => c.coinType))
      .toEqual(['Morgan']);
  });

  it('leaves out an ordered coin — it is still in the post', () => {
    const { io, exportInsuranceCsv } = ioOver([
      makeCoin({ coinType: 'Morgan' }),
      makeCoin({ coinType: 'Peace', collectionStatus: 'ordered' })
    ]);

    io.exportInsuranceCsv();

    expect(exportInsuranceCsv.mock.calls[0][0].map((c: CoinRecord) => c.coinType))
      .toEqual(['Morgan']);
  });

  it('leaves out a sold coin', () => {
    const { io, exportInsuranceCsv } = ioOver([
      makeCoin({ coinType: 'Morgan' }),
      makeCoin({ coinType: 'Trade', collectionStatus: 'sold' })
    ]);

    io.exportInsuranceCsv();

    expect(exportInsuranceCsv.mock.calls[0][0].map((c: CoinRecord) => c.coinType))
      .toEqual(['Morgan']);
  });

  it('INCLUDES a coin that is for sale', () => {
    // Listing a coin does not take it out of the house, and if the house
    // burns down tonight the insurer owes for it.
    const { io, exportInsuranceCsv } = ioOver([
      makeCoin({ coinType: 'Morgan' }),
      makeCoin({ coinType: 'Peace', collectionStatus: 'for-sale' })
    ]);

    io.exportInsuranceCsv();

    expect(exportInsuranceCsv.mock.calls[0][0].map((c: CoinRecord) => c.coinType))
      .toEqual(['Morgan', 'Peace']);
  });

  it('INCLUDES every coin that has no status at all', () => {
    // A coin saved before the status field existed is Owned. An insurance
    // schedule that silently dropped those would be the worst version of
    // this bug.
    const { io, exportInsuranceCsv } = ioOver([makeCoin({ coinType: 'Morgan' })]);

    io.exportInsuranceCsv();

    expect(exportInsuranceCsv.mock.calls[0][0]).toHaveLength(1);
  });
});

describe('the full CSV backup', () => {
  it('still contains every coin, want list included', () => {
    // Export -> CSV is a BACKUP, not a valuation. Dropping the want list from
    // it would mean the owner could not move his collection to another
    // machine without losing the half of it he has been building for months
    // -- and the file carries a Status column precisely so it does not have
    // to choose.
    const { io, exportCsv } = ioOver([
      makeCoin({ coinType: 'Morgan' }),
      makeCoin({ coinType: 'Draped Bust', collectionStatus: 'wanted' })
    ]);

    io.exportCsv();

    expect(exportCsv.mock.calls[0][0].map((c: CoinRecord) => c.coinType))
      .toEqual(['Morgan', 'Draped Bust']);
  });
});
