/**
 * Tests for planImport, which works out before importing which rows become
 * coins (at least two of Year / Coin Type / Denomination, and a denomination the
 * backend requires), so the button count is accurate. Rejected rows are listed
 * with reasons. Row numbers restart at 1 on each sheet.
 */
import { describe, expect, it } from 'vitest';
import { CsvService } from '../csv.service';
import { planImport } from './import-plan';

const csv = new CsvService();
const mapRow = (row: string[], headers: string[], mapping: Record<string, string>) =>
  csv.mapRowToCoin(row, headers, mapping);

describe('planImport', () => {
  it('accepts rows that carry enough detail', () => {
    const headers = ['Coin Type', 'Denomination', 'Year'];
    const plan = planImport(
      [{ headers, rows: [['Morgan Dollar', 'Dollar', '1881']] }],
      csv.autoMapHeaders(headers),
      mapRow
    );

    expect(plan.accepted).toHaveLength(1);
    expect(plan.accepted[0].coinType).toBe('Morgan Dollar');
    expect(plan.rejected).toEqual([]);
    expect(plan.acceptedCount).toBe(1);
  });

  it('rejects a row with only one of the three main details', () => {
    const headers = ['Coin Type', 'Denomination', 'Year'];
    const plan = planImport(
      [{ headers, rows: [['', '', '1881']] }],
      csv.autoMapHeaders(headers),
      mapRow
    );

    expect(plan.accepted).toEqual([]);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0].rowNumber).toBe(1);
    expect(plan.rejected[0].summary).toBe('1881');
    expect(plan.rejected[0].missing).toContain('Coin Type');
    expect(plan.rejected[0].missing).toContain('Denomination');
  });

  it('describes a row by its first filled cell when nothing mapped at all', () => {
    // Usually means the mapping is wrong, so show something recognisable from the row.
    const plan = planImport(
      [{ headers: ['Mystery'], rows: [['Rare thing']] }],
      {},
      mapRow
    );

    expect(plan.rejected[0].summary).toBe('Rare thing');
  });

  it('says "(empty row)" rather than nothing for a row with no content', () => {
    const plan = planImport([{ headers: ['A'], rows: [['']] }], {}, mapRow);
    expect(plan.rejected[0].summary).toBe('(empty row)');
  });

  it('numbers rows within their own sheet and names the sheet', () => {
    const headers = ['Coin Type', 'Denomination'];
    const mapping = csv.autoMapHeaders(headers);
    const plan = planImport(
      [
        { sheetName: 'Silver', headers, rows: [['Morgan Dollar', 'Dollar'], ['', '']] },
        { sheetName: 'Gold', headers, rows: [['', ''], ['Gold Eagle', '$5']] }
      ],
      mapping,
      mapRow
    );

    expect(plan.acceptedCount).toBe(2);
    expect(plan.rejected).toHaveLength(2);
    expect(plan.rejected[0]).toMatchObject({ sheetName: 'Silver', rowNumber: 2 });
    expect(plan.rejected[1]).toMatchObject({ sheetName: 'Gold', rowNumber: 1 });
  });

  it('applies ONE mapping across sheets whose columns are in a different order', () => {
    // The mapping is keyed by header text and applied per sheet, so reordered tabs still work.
    const mapping = csv.autoMapHeaders(['Coin Type', 'Denomination', 'Cost']);
    const plan = planImport(
      [
        {
          sheetName: 'Silver',
          headers: ['Coin Type', 'Denomination', 'Cost'],
          rows: [['Morgan Dollar', 'Dollar', '1250']]
        },
        {
          sheetName: 'Gold',
          headers: ['Cost', 'Denomination', 'Coin Type'],
          rows: [['395', '$5', 'Gold Eagle']]
        }
      ],
      mapping,
      mapRow
    );

    expect(plan.accepted).toHaveLength(2);
    expect(plan.accepted[0]).toMatchObject({ coinType: 'Morgan Dollar', purchasePrice: 1250 });
    expect(plan.accepted[1]).toMatchObject({ coinType: 'Gold Eagle', purchasePrice: 395 });
  });

  it('lets a column that exists on only one sheet map without disturbing the other', () => {
    const mapping = csv.autoMapHeaders(['Coin Type', 'Denomination', 'Grams']);
    const plan = planImport(
      [
        {
          sheetName: 'Gold',
          headers: ['Coin Type', 'Denomination', 'Grams'],
          rows: [['Gold Eagle', '$5', '3.393']]
        },
        {
          sheetName: 'Silver',
          headers: ['Coin Type', 'Denomination'],
          rows: [['Morgan Dollar', 'Dollar']]
        }
      ],
      mapping,
      mapRow
    );

    expect(plan.accepted[0].weight).toBe(3.393);
    expect(plan.accepted[1].weight).toBeUndefined();
  });

  it('counts the rejections per sheet so the preview can summarise them', () => {
    const headers = ['Coin Type', 'Denomination'];
    const mapping = csv.autoMapHeaders(headers);
    const plan = planImport(
      [
        { sheetName: 'Silver', headers, rows: [['Morgan Dollar', 'Dollar'], ['', '']] },
        { sheetName: 'Junk', headers, rows: [['', ''], ['', '']] }
      ],
      mapping,
      mapRow
    );

    // `linkedDenominations` is 0 because `mapRow` has no lookup here (see
    // denomination-link.spec.ts). The assertion is deliberately exhaustive.
    expect(plan.perSheet).toEqual([
      { sheetName: 'Silver', accepted: 1, rejected: 1, linkedDenominations: 0, excludedAsSold: 0 },
      { sheetName: 'Junk', accepted: 0, rejected: 2, linkedDenominations: 0, excludedAsSold: 0 }
    ]);
  });

  it('handles an empty source list without pretending it will import anything', () => {
    const plan = planImport([], {}, mapRow);
    expect(plan.acceptedCount).toBe(0);
    expect(plan.rejected).toEqual([]);
    expect(plan.perSheet).toEqual([]);
  });
});
