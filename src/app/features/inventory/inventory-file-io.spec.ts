/*
 * The insurance CSV must list only coins actually held; the full CSV backup
 * keeps every coin.
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

/** Captures the coin list each export is handed, without touching the DOM. */
function ioOver(coins: CoinRecord[]) {
  const exportInsuranceCsv = vi.fn();
  const exportCsv = vi.fn();
  const csv = { exportInsuranceCsv, exportCsv } as unknown as CsvService;
  const inv = { inventory: signal(coins), catalogs: signal([]) } as unknown as InventoryService;

  return { io: new InventoryFileIo(inv, csv), exportInsuranceCsv, exportCsv };
}

describe('the insurance schedule', () => {
  it('leaves out a wanted coin', () => {
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
    // A coin listed for sale is still held.
    const { io, exportInsuranceCsv } = ioOver([
      makeCoin({ coinType: 'Morgan' }),
      makeCoin({ coinType: 'Peace', collectionStatus: 'for-sale' })
    ]);

    io.exportInsuranceCsv();

    expect(exportInsuranceCsv.mock.calls[0][0].map((c: CoinRecord) => c.coinType))
      .toEqual(['Morgan', 'Peace']);
  });

  it('INCLUDES every coin that has no status at all', () => {
    // No status means Owned.
    const { io, exportInsuranceCsv } = ioOver([makeCoin({ coinType: 'Morgan' })]);

    io.exportInsuranceCsv();

    expect(exportInsuranceCsv.mock.calls[0][0]).toHaveLength(1);
  });
});

describe('the full CSV backup', () => {
  it('still contains every coin, want list included', () => {
    // The backup carries its own Status column, so nothing is filtered.
    const { io, exportCsv } = ioOver([
      makeCoin({ coinType: 'Morgan' }),
      makeCoin({ coinType: 'Draped Bust', collectionStatus: 'wanted' })
    ]);

    io.exportCsv();

    expect(exportCsv.mock.calls[0][0].map((c: CoinRecord) => c.coinType))
      .toEqual(['Morgan', 'Draped Bust']);
  });
});
