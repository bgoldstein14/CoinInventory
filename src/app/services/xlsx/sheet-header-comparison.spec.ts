/**
 * Telling the user exactly how two worksheets disagree.
 *
 * WHY A MESSAGE THAT NAMES THINGS
 *
 * A dealer's workbook has a tab per metal, or per year, or per box. They are
 * usually the same shape, and occasionally not -- the Gold tab grew an `AGW`
 * column in 2015 and nothing else did. Importing them together is still the
 * right thing to do; the user just needs to know what is different before
 * they commit.
 *
 * "Columns are inconsistent across sheets" tells them nothing and sends them
 * back to Excel to find out. "Sheet 'Gold' has a column 'AGW' that 'Silver'
 * does not" tells them whether they care, without leaving the dialog. The
 * assertions below are mostly about the wording for that reason.
 *
 * MATCHING IGNORES CASE AND PUNCTUATION, REPORTING DOES NOT
 *
 * `Cost` and `cost ` are the same column and must not be reported as a
 * difference. But the message quotes the heading as the user actually typed
 * it, because that is what they will be looking for when they go and check.
 */
import { describe, expect, it } from 'vitest';
import { compareSheetHeaders } from './sheet-header-comparison';

describe('compareSheetHeaders', () => {
  it('reports nothing for a single sheet', () => {
    const comparison = compareSheetHeaders([{ name: 'Silver', headers: ['Coin Type', 'Year'] }]);
    expect(comparison.consistent).toBe(true);
    expect(comparison.messages).toEqual([]);
  });

  it('reports nothing when every sheet has the same columns', () => {
    const comparison = compareSheetHeaders([
      { name: 'Silver', headers: ['Coin Type', 'Year', 'Cost'] },
      { name: 'Gold', headers: ['Coin Type', 'Year', 'Cost'] }
    ]);
    expect(comparison.consistent).toBe(true);
    expect(comparison.messages).toEqual([]);
  });

  it('ignores a difference of case, spacing or punctuation', () => {
    const comparison = compareSheetHeaders([
      { name: 'Silver', headers: ['Coin Type', 'Cert #'] },
      { name: 'Gold', headers: ['coin  type', 'Cert#'] }
    ]);
    expect(comparison.consistent).toBe(true);
  });

  it('ignores the ORDER of the columns', () => {
    // Order genuinely does not matter: the mapping is keyed by header text
    // and applied against each sheet's own header array, so a reordered
    // sheet imports correctly. Flagging it would be a false alarm.
    const comparison = compareSheetHeaders([
      { name: 'Silver', headers: ['Coin Type', 'Year'] },
      { name: 'Gold', headers: ['Year', 'Coin Type'] }
    ]);
    expect(comparison.consistent).toBe(true);
  });

  it('names the sheet, the column and the sheet that lacks it', () => {
    const comparison = compareSheetHeaders([
      { name: 'Silver', headers: ['Coin Type', 'Year'] },
      { name: 'Gold', headers: ['Coin Type', 'Year', 'AGW'] }
    ]);

    expect(comparison.consistent).toBe(false);
    expect(comparison.messages).toEqual([
      `Sheet 'Gold' has a column 'AGW' that 'Silver' does not.`
    ]);
  });

  it('lists every sheet that lacks the column, not just the first', () => {
    const comparison = compareSheetHeaders([
      { name: 'Silver', headers: ['Coin Type'] },
      { name: 'Copper', headers: ['Coin Type'] },
      { name: 'Gold', headers: ['Coin Type', 'AGW'] }
    ]);

    expect(comparison.messages).toEqual([
      `Sheet 'Gold' has a column 'AGW' that 'Silver' and 'Copper' do not.`
    ]);
  });

  it('groups several extra columns on one sheet into one sentence', () => {
    const comparison = compareSheetHeaders([
      { name: 'Silver', headers: ['Coin Type'] },
      { name: 'Gold', headers: ['Coin Type', 'AGW', 'Melt'] }
    ]);

    expect(comparison.messages).toEqual([
      `Sheet 'Gold' has columns 'AGW' and 'Melt' that 'Silver' does not.`
    ]);
  });

  it('reports a difference in both directions', () => {
    const comparison = compareSheetHeaders([
      { name: 'Silver', headers: ['Coin Type', 'Toning'] },
      { name: 'Gold', headers: ['Coin Type', 'AGW'] }
    ]);

    expect(comparison.messages).toEqual([
      `Sheet 'Silver' has a column 'Toning' that 'Gold' does not.`,
      `Sheet 'Gold' has a column 'AGW' that 'Silver' does not.`
    ]);
  });

  it('exposes the columns every sheet shares', () => {
    const comparison = compareSheetHeaders([
      { name: 'Silver', headers: ['Coin Type', 'Year', 'Toning'] },
      { name: 'Gold', headers: ['Year', 'Coin Type', 'AGW'] }
    ]);

    expect(comparison.common).toEqual(['Coin Type', 'Year']);
  });

  it('ignores sheets with no headers at all', () => {
    // An empty tab is not a disagreement, it is an absence. Counting it
    // would make every workbook with a spare Sheet3 look inconsistent.
    const comparison = compareSheetHeaders([
      { name: 'Silver', headers: ['Coin Type'] },
      { name: 'Sheet3', headers: [] }
    ]);
    expect(comparison.consistent).toBe(true);
  });
});
