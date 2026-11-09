/**
 * report-scope.spec.ts
 *
 * THE BUG THIS PREVENTS
 * A printed listing of 12 coins, produced while a category filter was on,
 * looks exactly like a printed listing of a 12-coin collection. Nothing on
 * the paper says otherwise, and the person reading it a year later has no way
 * to tell. This line of text is the whole defence, so its content is tested.
 */
import { describe, expect, it } from 'vitest';
import { ReportScopeInput, describeReportScope } from './report-scope';

function scope(overrides: Partial<ReportScopeInput> = {}): ReportScopeInput {
  return {
    searchQuery: '',
    category: 'All',
    coinSet: 'All',
    grade: '',
    valueMin: '',
    valueMax: '',
    source: '',
    country: '',
    sort: { column: 'year', direction: 'asc' },
    shown: 412,
    total: 412,
    ...overrides
  };
}

describe('describeReportScope', () => {
  it('says the listing is complete when no filter is active', () => {
    const note = describeReportScope(scope());
    expect(note).toContain('All 412 coins');
    expect(note).not.toMatch(/of 412/);
  });

  it('always states the sort order, in words', () => {
    expect(describeReportScope(scope())).toContain('Sorted by Year, ascending');
    expect(describeReportScope(scope({ sort: { column: 'currentValue', direction: 'desc' } })))
      .toContain('Sorted by Current Value, descending');
  });

  it('names an active category filter and the count it produced', () => {
    const note = describeReportScope(scope({ category: 'Silver Dollars', shown: 12 }));
    expect(note).toContain('Category: Silver Dollars');
    expect(note).toContain('12 of 412 coins');
  });

  it('treats the All sentinel as no filter at all', () => {
    // 'All' is InventoryFilterStore's sentinel, not a category anybody named.
    expect(describeReportScope(scope({ category: 'All', coinSet: 'All' })))
      .not.toContain('Category:');
  });

  it('reports a search term', () => {
    expect(describeReportScope(scope({ searchQuery: 'morgan', shown: 30 })))
      .toContain('Search: morgan');
  });

  it('reports every other advanced filter that is set', () => {
    const note = describeReportScope(scope({
      grade: 'MS', valueMin: '100', valueMax: '5000',
      source: 'quicken', country: 'United States', coinSet: 'Morgan Set',
      shown: 3
    }));
    expect(note).toContain('Grade starts with: MS');
    expect(note).toContain('Value from: 100');
    expect(note).toContain('Value to: 5000');
    expect(note).toContain('Source: quicken');
    expect(note).toContain('Country: United States');
    expect(note).toContain('Set: Morgan Set');
  });

  it('ignores blank filter boxes', () => {
    const note = describeReportScope(scope({ grade: '   ', country: '' }));
    expect(note).not.toContain('Grade');
    expect(note).not.toContain('Country');
  });

  it('copes with an empty collection', () => {
    expect(describeReportScope(scope({ shown: 0, total: 0 }))).toContain('All 0 coins');
  });

  it('uses the report heading for the sort column, not the grid abbreviation', () => {
    // The grid header reads 'MM'. On paper that means nothing.
    expect(describeReportScope(scope({ sort: { column: 'mintMark', direction: 'asc' } })))
      .toContain('Sorted by Mint Mark');
  });
});
