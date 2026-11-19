/**
 * Tests for the optional Transactions section in the coin editor and for keeping its notes
 * box distinct from the coin's own Notes. Cost and Purchase Date live inside the section,
 * which sits above Notes. Text scan of the templates, since the suite has no DOM.
 *
 * Comments are stripped before every assertion so explanatory prose cannot satisfy them.
 * The stripper must span newlines; the [sS] typo once left multi-line comments in.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Removes HTML comments. */
function stripHtmlComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

/** Both Sass comment styles: `//` to end of line, and block comments. */
function stripScssComments(scss: string): string {
  return scss.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const EDITOR_DIR = __dirname;
const PANEL_DIR = join(__dirname, '..', 'coin-detail-panel');

const TEMPLATE = stripHtmlComments(
  readFileSync(join(EDITOR_DIR, 'coin-editor-form.html'), 'utf8')
);
const STYLES = stripScssComments(
  readFileSync(join(EDITOR_DIR, 'coin-editor-form.scss'), 'utf8')
);
const PANEL_TEMPLATE = stripHtmlComments(
  readFileSync(join(PANEL_DIR, 'coin-detail-panel.html'), 'utf8')
);

/** Checks the stripper itself; if it failed, assertions below could match comment prose. */
describe('the comment stripper actually strips', () => {
  it('removes a comment that spans several lines', () => {
    const stripped = stripHtmlComments('<p>a</p><!--\n  Cost\n  Purchase Date\n-->\n<p>b</p>');
    expect(stripped).not.toContain('Cost');
    expect(stripped).toBe('<p>a</p>\n<p>b</p>');
  });

  it('left no comment markers behind in the two templates it is used on', () => {
    expect(TEMPLATE).not.toContain('<!--');
    expect(PANEL_TEMPLATE).not.toContain('<!--');
  });
});

describe('the transactions section holds the whole deal', () => {
  it('is gated on the existing "show transactions" preference', () => {
    expect(TEMPLATE).toContain('@if (showTransactions()) {');
    // The panel passes the flag down rather than rendering the section.
    expect(PANEL_TEMPLATE).toContain('[showTransactions]="showTransactions()"');
  });

  it('carries Cost, bound to the coin’s purchase price', () => {
    // "Cost" is the caption for purchasePrice.
    expect(TEMPLATE).toContain('<span>Cost</span>');
    expect(TEMPLATE).toContain('[appNumericField]="coin().purchasePrice"');
    expect(TEMPLATE).toContain("updateNumericField('purchasePrice', $event)");
  });

  it('carries Purchase Date, bound to the coin’s purchase date', () => {
    expect(TEMPLATE).toContain('<span>Purchase Date</span>');
    expect(TEMPLATE).toContain("updateSelectedCoin('purchaseDate', $event)");
  });

  it('carries both counterparties, one per side of the deal', () => {
    // Separate purchase and sale counterparties.
    expect(TEMPLATE).toContain('<span>Purchased from</span>');
    expect(TEMPLATE).toContain("updateSelectedCoin('purchasedFrom', $event)");
    expect(TEMPLATE).toContain('<span>Sold to</span>');
    expect(TEMPLATE).toContain("updateSelectedCoin('soldTo', $event)");
  });

  it('carries the sale price and date, which the table used to hold', () => {
    expect(TEMPLATE).toContain("updateNumericField('soldPrice', $event)");
    expect(TEMPLATE).toContain("updateSelectedCoin('soldDate', $event)");
  });

  it('no longer offers Price or a stray Purchase date row outside it', () => {
    // Exactly one control per column.
    expect(TEMPLATE).not.toContain('<span>Price</span>');
    expect(TEMPLATE).not.toContain('<span>Purchase date</span>');
    // Counted on the write binding: the Cost box names purchasePrice twice (read and write).
    expect(TEMPLATE.match(/updateNumericField\('purchasePrice'/g) ?? []).toHaveLength(1);
    expect(TEMPLATE.match(/coin\(\)\.purchasePrice/g) ?? []).toHaveLength(1);
    expect(TEMPLATE.match(/'purchaseDate'/g) ?? []).toHaveLength(1);
  });

  it('leaves Value and Melt exactly where they were', () => {
    expect(TEMPLATE).toContain('<span>Value</span>');
    expect(TEMPLATE).toContain('<span>Melt</span>');
    expect(TEMPLATE).toContain('detail-editor__row--pricing');
    // Value and Melt stay outside the optional section.
    const sectionStart = TEMPLATE.indexOf('@if (showTransactions()) {');
    expect(TEMPLATE.indexOf('<span>Value</span>')).toBeLessThan(sectionStart);
    expect(TEMPLATE.indexOf('<span>Melt</span>')).toBeLessThan(sectionStart);
  });
});

describe('the transactions section sits ABOVE the notes block', () => {
  it('renders the section before the coin’s notes', () => {
    const section = TEMPLATE.indexOf('@if (showTransactions()) {');
    const notes = TEMPLATE.indexOf('<div class="detail-notes">');
    expect(section).toBeGreaterThan(-1);
    expect(notes).toBeGreaterThan(-1);
    expect(section).toBeLessThan(notes);
  });

  it('puts the deal’s notes box before the coin’s notes box', () => {
    // Order: coin fields, then the transaction, then the coin's notes.
    expect(TEMPLATE.indexOf("'transactionNotes'")).toBeLessThan(
      TEMPLATE.indexOf("updateSelectedCoin('notes', $event)")
    );
  });
});

describe('the two notes boxes cannot be read as the same field', () => {
  it('gives neither of them the bare caption "Notes"', () => {
    expect(TEMPLATE).toContain('>Notes about this purchase or sale<');
    expect(TEMPLATE).toContain('>Notes about the coin itself<');
    expect(TEMPLATE).not.toContain('>Notes</span>');
  });

  it('gives them DIFFERENT captions', () => {
    const captions = [...TEMPLATE.matchAll(/>(Notes about [^<]+)</g)].map((m) => m[1]);
    expect(captions).toHaveLength(2);
    expect(new Set(captions).size).toBe(2);
  });

  it('writes them to different fields on the coin', () => {
    expect(TEMPLATE).toContain("updateSelectedCoin('transactionNotes', $event)");
    expect(TEMPLATE).toContain("updateSelectedCoin('notes', $event)");
  });

  it('says under each caption what belongs in it', () => {
    expect(TEMPLATE).toContain('detail-transaction-notes-hint');
    expect(TEMPLATE).toContain('detail-notes-hint');
  });

  it('makes the transaction notes box the LARGER of the two', () => {
    // The transaction notes box is the taller one.
    const dealHeight = STYLES.match(
      /\.detail-transaction-notes textarea \{[\s\S]*?min-height:\s*(\d+)px/
    );
    const coinHeight = STYLES.match(/\.detail-notes textarea \{[\s\S]*?min-height:\s*(\d+)px/);
    expect(dealHeight).not.toBeNull();
    expect(coinHeight).not.toBeNull();
    expect(Number(dealHeight![1])).toBeGreaterThan(Number(coinHeight![1]));
  });

  it('puts only one of them inside a titled card', () => {
    // The transaction notes sit inside a tinted, titled section.
    expect(TEMPLATE).toContain('<h3 id="coin-transaction-heading">Transactions</h3>');
    expect(STYLES).toContain('.detail-transactions {');
  });
});

describe('what the detail panel no longer renders', () => {
  it('has no add-a-transaction form and no history list', () => {
    expect(PANEL_TEMPLATE).not.toContain('add-transaction-form');
    expect(PANEL_TEMPLATE).not.toContain('transaction-list');
    expect(PANEL_TEMPLATE).not.toContain('selectedCoinTransactions');
    expect(PANEL_TEMPLATE).not.toContain('addTransactionForSelectedCoin');
  });

  it('has no Original image files section', () => {
    // Removed from the panel only; the source path data is still stored and served.
    expect(PANEL_TEMPLATE).not.toContain('detail-image-paths');
    expect(PANEL_TEMPLATE).not.toContain('app-coin-image-path-link');
    expect(PANEL_TEMPLATE).not.toContain('Original image files');
  });

  it('still opens, closes and deletes', () => {
    // The remaining frame must stay intact.
    expect(PANEL_TEMPLATE).toContain('closeRequested.emit()');
    expect(PANEL_TEMPLATE).toContain('deleteRequested.emit()');
    expect(PANEL_TEMPLATE).toContain('images().toggleImageGallery()');
  });
});
