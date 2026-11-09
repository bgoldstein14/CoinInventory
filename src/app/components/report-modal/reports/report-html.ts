/*
 * report-html.ts — a ReportDocument as one self-contained printable page.
 *
 * WHY A STRING, AND NOT AN ANGULAR TEMPLATE
 *
 * 1. IT IS TESTABLE. The frontend suite runs under Node with NO jsdom, so an
 *    Angular template's output cannot be inspected at all. A pure
 *    `ReportDocument -> string` function can be, and the things worth
 *    checking — that a coin's text is escaped, that the pagination rules are
 *    present, that the "NOT included in this total" caveat reaches the page —
 *    are all assertable without a browser.
 *
 * 2. IT IS ISOLATED. The page is written into a brand-new window that has
 *    none of this app's stylesheets. Everything it needs is inline, so what
 *    prints cannot be changed by an unrelated edit to styles.scss, and the
 *    report cannot inherit the dark-on-cream palette that is right on screen
 *    and wasteful on paper.
 *
 * 3. IT SURVIVES THE SHELL. The app is packaged into a webview; a separate
 *    print window goes through the same Chromium print path either way, and
 *    a self-contained document renders identically in both.
 *
 * ESCAPING IS NOT OPTIONAL HERE. Every cell on this page came out of a
 * database filled by CSV import, `.xlsx` import, Quicken QIF import and a
 * free-text editor. A coin type of `<img onerror=...>` is not a likely attack
 * in a single-user local app, but it IS a likely accident — an apostrophe or
 * an ampersand in a variety name is enough to mangle or truncate the
 * document. Every piece of record data below goes through escapeHtml().
 */

import { ReportDocument } from './report-types';

/**
 * HTML-escape a string.
 *
 * The ampersand is replaced FIRST and that order is load-bearing: doing `<`
 * first would turn `<` into `&lt;` and then the ampersand pass would turn
 * that into `&amp;lt;`, printing the literal text "&lt;" on the page.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The print stylesheet. The three rules that do the actual work:
 *
 * `thead { display: table-header-group }` repeats the column headings at the
 *   top of every printed page. Without it a forty-page schedule has headings
 *   on page one and anonymous columns of numbers on pages two to forty.
 *
 * `tr { break-inside: avoid }` stops a coin being split across a page break,
 *   which with photographs in the row is the difference between a readable
 *   document and one where half the pictures are sliced in two.
 *
 * `@page { margin }` gives the printer something to hold. Browsers default to
 *   a margin that varies by platform, and a table set to 100% width will
 *   happily run into the unprintable edge.
 *
 * Everything else is making it look like a document rather than a web page:
 * a serif face, black on white (a cream background would be printed, wasting
 * ink on every page), and hairline rules instead of the app's chrome.
 */
const PRINT_STYLES = `
  @page { size: letter; margin: 0.6in 0.5in; }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 10pt;
    line-height: 1.35;
    color: #000;
    background: #fff;
  }

  header { border-bottom: 2px solid #000; padding-bottom: 8px; margin-bottom: 14px; }
  h1 { font-size: 17pt; margin: 0 0 4px; }
  .purpose { margin: 0 0 6px; font-size: 9.5pt; font-style: italic; }
  .meta { margin: 0; font-size: 9pt; }
  .meta strong { font-weight: bold; }

  table { width: 100%; border-collapse: collapse; }

  /* Repeat the headings on every printed page -- see the note above. */
  thead { display: table-header-group; }
  tfoot { display: table-footer-group; }

  /* Never split a coin across a page break. */
  tr { break-inside: avoid; page-break-inside: avoid; }

  th, td { padding: 4px 6px; border-bottom: 1px solid #bbb; text-align: left; vertical-align: top; }
  thead th { border-bottom: 1.5px solid #000; font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.04em; }

  /* Decimal points queue up only if the column is right-aligned. */
  .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }

  .photos { white-space: nowrap; }
  .photos img {
    height: 1.05in;
    width: auto;
    max-width: 1.2in;
    object-fit: contain;
    margin-right: 4px;
    border: 1px solid #999;
  }

  .totals { margin-top: 18px; border-top: 2px solid #000; padding-top: 10px; break-inside: avoid; }
  .total-line { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; }
  .total-line .label { font-weight: bold; }
  .total-line .amount { font-size: 13pt; font-weight: bold; font-variant-numeric: tabular-nums; }
  .total-basis { font-size: 8.5pt; }

  /* The honesty block. Boxed so it cannot be skimmed past: it is the part
     that says the grand total above is not the whole story. */
  .caveat {
    margin: 6px 0 12px;
    padding: 6px 8px;
    border-left: 3px solid #000;
    background: #f2f2f2;
    font-size: 9pt;
  }

  .notes { margin-top: 14px; font-size: 9pt; break-inside: avoid; }
  .notes h2 { font-size: 10pt; margin: 0 0 4px; }
  .notes ul { margin: 0; padding-left: 18px; }

  .empty { margin: 24px 0; font-style: italic; }

  footer { margin-top: 20px; padding-top: 6px; border-top: 1px solid #999; font-size: 8pt; }

  /* Nothing here is interactive; hide any chrome that slipped through. */
  @media print { button, nav { display: none !important; } }
`;

function renderHead(doc: ReportDocument): string {
  const scope = doc.scopeNote
    ? `<p class="meta"><strong>Covers:</strong> ${escapeHtml(doc.scopeNote)}</p>`
    : '';

  return `<header>
      <h1>${escapeHtml(doc.title)}</h1>
      <p class="purpose">${escapeHtml(doc.purpose)}</p>
      <p class="meta"><strong>Prepared:</strong> ${escapeHtml(doc.generatedAt)} &nbsp;·&nbsp; <strong>Coins listed:</strong> ${doc.rows.length}</p>
      ${scope}
    </header>`;
}

function renderTable(doc: ReportDocument): string {
  if (doc.rows.length === 0) {
    // Not an empty table with a header row: an empty table looks like a
    // rendering failure, whereas a sentence is an answer.
    return '<p class="empty">No coins to report. Nothing matched the current filters.</p>';
  }

  // The photo column only exists when there is at least one photograph.
  // An always-present column of blanks wastes an inch of every page.
  const photoHeader = doc.hasImages ? '<th>Photographs</th>' : '';

  const headCells = doc.columns
    .map(column => `<th${column.numeric ? ' class="num"' : ''}>${escapeHtml(column.label)}</th>`)
    .join('');

  const bodyRows = doc.rows.map(row => {
    const cells = row.cells
      .map((cell, index) => {
        const numeric = doc.columns[index]?.numeric ? ' class="num"' : '';
        return `<td${numeric}>${escapeHtml(cell)}</td>`;
      })
      .join('');

    // `data:` URLs only -- thumbnails this app produced itself, so the
    // value is never user-typed text.
    const photos = doc.hasImages
      ? `<td class="photos">${row.images.map(image => `<img src="${escapeHtml(image)}" alt="">`).join('')}</td>`
      : '';

    return `<tr class="coin-row">${cells}${photos}</tr>`;
  }).join('');

  return `<table>
      <thead><tr>${headCells}${photoHeader}</tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>`;
}

function renderTotals(doc: ReportDocument): string {
  if (doc.totals.length === 0) return '';

  const lines = doc.totals.map(total => {
    const caveat = total.caveat ? `<p class="caveat">${escapeHtml(total.caveat)}</p>` : '';
    return `<div class="total-line">
        <span class="label">${escapeHtml(total.label)}</span>
        <span class="amount">${escapeHtml(total.amountText)}</span>
      </div>
      <p class="total-basis">Based on ${escapeHtml(total.basis)}.</p>
      ${caveat}`;
  }).join('');

  return `<section class="totals">${lines}</section>`;
}

function renderNotes(doc: ReportDocument): string {
  const items: string[] = [];

  for (const exclusion of doc.exclusions) {
    items.push(`${exclusion.count} × ${escapeHtml(exclusion.reason)}`);
  }
  if (doc.imageNote) items.push(escapeHtml(doc.imageNote));

  if (items.length === 0) return '';

  return `<section class="notes">
      <h2>Notes on what this document contains</h2>
      <ul>${items.map(item => `<li>${item}</li>`).join('')}</ul>
    </section>`;
}

/**
 * The whole page, ready to be written into a print window.
 *
 * `<!DOCTYPE html>` matters: without it the window renders in quirks mode,
 * where `border-collapse` and the `@page` rules behave differently, so the
 * printed output would not match what was designed.
 */
export function renderReportHtml(doc: ReportDocument): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(doc.title)}</title>
<style>${PRINT_STYLES}</style>
</head>
<body>
${renderHead(doc)}
${renderTable(doc)}
${renderTotals(doc)}
${renderNotes(doc)}
<footer>Produced by Coin Inventory on ${escapeHtml(doc.generatedAt)}. Values are the owner’s own records unless stated otherwise.</footer>
</body>
</html>`;
}
