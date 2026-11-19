/**
 * Tests that header differences between worksheets are reported by name
 * ("Sheet 'Gold' has a column 'AGW' that 'Silver' does not"). Matching ignores
 * case and punctuation; messages quote headings as written.
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
    // Order doesn't matter: the mapping is keyed by header text per sheet.
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
    // An empty tab is ignored, not reported as a difference.
    const comparison = compareSheetHeaders([
      { name: 'Silver', headers: ['Coin Type'] },
      { name: 'Sheet3', headers: [] }
    ]);
    expect(comparison.consistent).toBe(true);
  });
});
