/**
 * report-html.spec.ts
 *
 * renderReportHtml() is a pure string function on purpose. These specs run
 * under Node with no jsdom, so "open the report and look at it" is not
 * available; building the document as a string means the parts that MATTER —
 * the escaping, the page rules that control pagination, the totals block and
 * the honesty caveats — are all assertable without a browser.
 */
import { describe, expect, it } from 'vitest';
import { ReportDocument } from './report-types';
import { escapeHtml, renderReportHtml } from './report-html';

function doc(overrides: Partial<ReportDocument> = {}): ReportDocument {
  return {
    kind: 'insurance',
    title: 'Insurance & Appraisal Schedule',
    purpose: 'A dated, printable list of the coins owned and what each is worth.',
    generatedAt: 'November 8, 2026',
    scopeNote: null,
    columns: [
      { key: 'coinType', label: 'Type', numeric: false },
      { key: 'currentValue', label: 'Current Value', numeric: true }
    ],
    rows: [
      { coinId: 'c1', cells: ['Morgan Dollar', '$1400.00'], images: [] }
    ],
    totals: [
      {
        label: 'Total insured value',
        amount: { total: 1400, counted: 1, unknown: 0 },
        amountText: '$1,400.00',
        basis: '1 coin',
        caveat: null
      }
    ],
    exclusions: [],
    imageNote: null,
    hasImages: false,
    ...overrides
  };
}

describe('escapeHtml', () => {
  it('neutralises the characters that would break out of a cell', () => {
    expect(escapeHtml('<script>alert("x")</script>'))
      .toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });

  it('escapes ampersands first, so an escape cannot be double-escaped', () => {
    expect(escapeHtml('Tom & Jerry <b>')).toBe('Tom &amp; Jerry &lt;b&gt;');
  });

  it('leaves ordinary numismatic text alone', () => {
    expect(escapeHtml('1881-S Morgan — MS63')).toBe('1881-S Morgan — MS63');
  });
});

describe('renderReportHtml', () => {
  it('produces a complete, self-contained document', () => {
    // Self-contained because it is written into a brand-new window that has
    // none of the app stylesheets. Nothing may be linked; everything is
    // inline.
    const html = renderReportHtml(doc());
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('</html>');
    expect(html).toContain('<style>');
    expect(html).not.toContain('<link');
  });

  it('carries the title, the purpose and the date', () => {
    const html = renderReportHtml(doc());
    expect(html).toContain('Insurance &amp; Appraisal Schedule');
    expect(html).toContain('November 8, 2026');
    expect(html).toContain('A dated, printable list');
  });

  it('sets the page rules that make a long table paginate properly', () => {
    const html = renderReportHtml(doc());
    // Repeat the column headings at the top of every printed page.
    expect(html).toContain('thead { display: table-header-group; }');

    // Never split a coin across two pages.
    //
    // MATCH THE DECLARATION TOGETHER WITH ITS SELECTOR. A bare
    // toContain('break-inside: avoid') is vacuous here: the `.totals` block
    // further down the same stylesheet carries the identical text, so the
    // assertion stays green with the `tr` rule deleted.
    expect(html).toContain('tr { break-inside: avoid;');

    // The totals block must not be split either — it is the part a reader
    // goes looking for, and half of it on each side of a page break is the
    // one place a number can be misread.
    expect(html).toMatch(/\.totals \{[^}]*break-inside: avoid/);

    // A printable margin. Browsers default to a platform-dependent one, and a
    // table set to 100% width will happily run into the unprintable edge.
    expect(html).toContain('@page { size: letter; margin:');
  });

  it('writes one row per coin, in order', () => {
    const html = renderReportHtml(doc({
      rows: [
        { coinId: 'c1', cells: ['Morgan Dollar', '$1400.00'], images: [] },
        { coinId: 'c2', cells: ['Peace Dollar', '$40.00'], images: [] }
      ]
    }));
    expect(html.indexOf('Morgan Dollar')).toBeLessThan(html.indexOf('Peace Dollar'));
    expect((html.match(/<tr class="coin-row"/g) ?? [])).toHaveLength(2);
  });

  it('escapes everything that came out of the database', () => {
    const html = renderReportHtml(doc({
      rows: [{ coinId: 'c1', cells: ['<img onerror=alert(1)>', '$0.00'], images: [] }]
    }));
    expect(html).not.toContain('<img onerror');
    expect(html).toContain('&lt;img onerror');
  });

  it('right-aligns the numeric columns so decimal points line up', () => {
    const html = renderReportHtml(doc());
    expect(html).toContain('class="num"');
  });

  it('renders the photographs as inline images when there are any', () => {
    const html = renderReportHtml(doc({
      hasImages: true,
      rows: [{ coinId: 'c1', cells: ['Morgan Dollar', '$1400.00'], images: ['data:image/jpeg;base64,AAA'] }]
    }));
    expect(html).toContain('src="data:image/jpeg;base64,AAA"');
  });

  it('adds no photo column at all when the report carries no photographs', () => {
    const html = renderReportHtml(doc({ hasImages: false }));
    expect(html).not.toContain('<img');
    expect(html).not.toContain('Photograph');
  });

  it('prints the totals with their basis', () => {
    const html = renderReportHtml(doc());
    expect(html).toContain('Total insured value');
    expect(html).toContain('$1,400.00');
    expect(html).toContain('1 coin');
  });

  it('prints the unknown-value caveat where the reader cannot miss it', () => {
    const html = renderReportHtml(doc({
      totals: [{
        label: 'Total insured value',
        amount: { total: 1400, counted: 1, unknown: 3 },
        amountText: '$1,400.00',
        basis: '1 coin',
        caveat: '3 coins have no Current Value recorded and are NOT included in this total.'
      }]
    }));
    expect(html).toContain('NOT included in this total');
  });

  it('prints what was excluded from the report and why', () => {
    const html = renderReportHtml(doc({
      exclusions: [{ reason: 'Sold — no longer owned, so not insurable', count: 4 }]
    }));
    expect(html).toContain('Sold');
    expect(html).toContain('4');
  });

  it('prints the filter note when the listing is only part of the collection', () => {
    const html = renderReportHtml(doc({ kind: 'inventory', scopeNote: 'Category: Silver' }));
    expect(html).toContain('Category: Silver');
  });

  it('prints the photograph note so the reader knows what is missing', () => {
    const html = renderReportHtml(doc({
      hasImages: true,
      imageNote: '2 photographs included. 7 coins have no photograph on file.'
    }));
    expect(html).toContain('7 coins have no photograph on file');
  });

  it('says so plainly when there is nothing to report', () => {
    const html = renderReportHtml(doc({ rows: [] }));
    expect(html).toMatch(/No coins/i);
  });
});
