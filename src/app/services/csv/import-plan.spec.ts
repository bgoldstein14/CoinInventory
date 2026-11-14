/**
 * Working out what an import WOULD do, before it does it.
 *
 * THE RULE THIS SERVES
 *
 * A coin needs at least two of Year / Coin Type / Denomination
 * (services/coin-completeness.ts). The backend refuses one without a
 * denomination outright -- `400 {"error":"denomination is required"}` -- and
 * the project has a hard-won rule that the UI must never offer to create a
 * coin the backend would reject, because such a row shows up in the grid with
 * no database row behind it and every later edit fails against an id the
 * server never saw.
 *
 * WHY IT HAS TO HAPPEN BEFORE THE BUTTON IS PRESSED
 *
 * The CSV modal applied the rule, but only on the way through: the button
 * said "Import 412 rows" and afterwards the dialog admitted that 37 of them
 * had been skipped. The count on the button was a number the import could
 * not deliver. With a workbook of several sheets that gets worse, because
 * nobody can tell by eye which tab the 37 came from.
 *
 * So the same rule runs up front, the button promises only what will
 * actually be created, and the rows that will be skipped are listed with
 * their reason while there is still something the user can do about it --
 * map another column, or go and fix the file.
 *
 * MULTI-SHEET NUMBERING
 *
 * Row numbers restart at 1 on each sheet and carry the sheet name, because
 * that is how the user will find the row: they will open the tab and scroll.
 * A running total across sheets would be a number that appears nowhere in
 * their workbook.
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
    // Which almost always means the MAPPING is wrong, not the data, so
    // showing something recognisable from the row is the useful thing.
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
    // The mapping is keyed by header TEXT and applied against each sheet's
    // own header array. That is what makes a single set of dropdowns correct
    // for every sheet: a reordered tab still lands in the right fields.
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

    // `linkedDenominations` is 0 throughout because `mapRow` here is given
    // no lookup list to link against -- see denomination-link.spec.ts for
    // the counts with one. It is listed rather than omitted because this
    // assertion is exhaustive on purpose: a tally that grew a field nobody
    // noticed is how the preview and the import came to disagree before.
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
