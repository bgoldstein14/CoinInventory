/**
 * transactions-section.spec.ts — the deal record, and the two notes boxes.
 *
 * WHAT CHANGED AND WHY THIS FILE EXISTS
 * The Transactions TABLE was dropped. A coin has one purchase and at most
 * one sale, so the money, the dates, the two counterparties and the deal's
 * note are columns on Coins and are edited here, in an optional section
 * inside the coin editor.
 *
 * That move put TWO notes boxes next to each other on one panel — the
 * coin's own Notes and the deal's — and the owner said plainly that they
 * must not read as two of the same thing. Everything below exists to keep
 * that true, plus the two placement rules that came with the same request:
 * Cost and Purchase Date belong INSIDE the section, and the section sits
 * ABOVE the Notes block.
 *
 * WHY A TEXT SCAN. Vitest runs under plain Node with no jsdom, so nothing
 * here can render the component. What it can do is pin the decisions, which
 * are all expressible in the template text.
 *
 * *** COMMENTS ARE STRIPPED BEFORE EVERY ASSERTION. *** The template's own
 * comment block explains this section at length and names most of the
 * strings asserted below; against raw file text those comments would satisfy
 * the assertions and the tests would pass with the markup deleted. The
 * stripper is `/<!--[\s\S]*?-->/g` — `[\s\S]`, not `[sS]`. That exact typo
 * silently disabled four assertions in this repo, because `[sS]` matches the
 * two LETTERS s and S and therefore never spans a newline, so only one-line
 * comments were removed.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Everything between `<!--` and `-->`, which is where the reasoning lives. */
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

/**
 * Guard on the guard. If the stripper ever stops working — the `[sS]` typo
 * being the way that happens — every "the template contains X" assertion
 * below turns into "the file contains X", which the prose satisfies.
 */
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
    // And the panel hands it down rather than rendering the section itself.
    expect(PANEL_TEMPLATE).toContain('[showTransactions]="showTransactions()"');
  });

  it('carries Cost, bound to the coin’s purchase price', () => {
    // "Cost" is the owner's word for PurchasePrice. The field used to be
    // called "Price" and sat beside Value, where the two read as rivals.
    expect(TEMPLATE).toContain('<span>Cost</span>');
    expect(TEMPLATE).toContain('[appNumericField]="coin().purchasePrice"');
    expect(TEMPLATE).toContain("updateNumericField('purchasePrice', $event)");
  });

  it('carries Purchase Date, bound to the coin’s purchase date', () => {
    expect(TEMPLATE).toContain('<span>Purchase Date</span>');
    expect(TEMPLATE).toContain("updateSelectedCoin('purchaseDate', $event)");
  });

  it('carries both counterparties, one per side of the deal', () => {
    // One "dealer" string could not describe a coin bought from one dealer
    // and later sold to another. That was the whole argument for keeping a
    // transactions table; two fields answer it instead.
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
    // Exactly one of each. A second copy would be a second control writing
    // the same column, and the two would disagree the moment one was edited.
    expect(TEMPLATE).not.toContain('<span>Price</span>');
    expect(TEMPLATE).not.toContain('<span>Purchase date</span>');
    // One control each. Counted on the WRITE, which is what a duplicate
    // control would also have to carry: the Cost box legitimately names
    // `purchasePrice` twice (once to read it, once to write it).
    expect(TEMPLATE.match(/updateNumericField\('purchasePrice'/g) ?? []).toHaveLength(1);
    expect(TEMPLATE.match(/coin\(\)\.purchasePrice/g) ?? []).toHaveLength(1);
    expect(TEMPLATE.match(/'purchaseDate'/g) ?? []).toHaveLength(1);
  });

  it('leaves Value and Melt exactly where they were', () => {
    expect(TEMPLATE).toContain('<span>Value</span>');
    expect(TEMPLATE).toContain('<span>Melt</span>');
    expect(TEMPLATE).toContain('detail-editor__row--pricing');
    // Both still OUTSIDE the optional section: they describe the coin, not a
    // deal, and must not vanish when the preference is off.
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
    // The ordering that actually matters: read top to bottom the panel goes
    // the coin -> the deal -> what you want to remember about the coin.
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
    // Asked for explicitly: the deal's note is the one that gets paragraphs.
    const dealHeight = STYLES.match(
      /\.detail-transaction-notes textarea \{[\s\S]*?min-height:\s*(\d+)px/
    );
    const coinHeight = STYLES.match(/\.detail-notes textarea \{[\s\S]*?min-height:\s*(\d+)px/);
    expect(dealHeight).not.toBeNull();
    expect(coinHeight).not.toBeNull();
    expect(Number(dealHeight![1])).toBeGreaterThan(Number(coinHeight![1]));
  });

  it('puts only one of them inside a titled card', () => {
    // The fourth cue: the deal's note is inside a bordered, tinted section
    // with its own heading; the coin's note is on the plain panel.
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
    // Removed at the owner's request. The DATA is untouched — CoinImages
    // .SourcePath is still written and still served by GET /api/images/file
    // — so this is about the panel and nothing else.
    expect(PANEL_TEMPLATE).not.toContain('detail-image-paths');
    expect(PANEL_TEMPLATE).not.toContain('app-coin-image-path-link');
    expect(PANEL_TEMPLATE).not.toContain('Original image files');
  });

  it('still opens, closes and deletes', () => {
    // The frame is all that is left; losing any of it would strand the user.
    expect(PANEL_TEMPLATE).toContain('closeRequested.emit()');
    expect(PANEL_TEMPLATE).toContain('deleteRequested.emit()');
    expect(PANEL_TEMPLATE).toContain('images().toggleImageGallery()');
  });
});
