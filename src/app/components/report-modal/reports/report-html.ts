/*
 * report-html.ts — a ReportDocument as one self-contained printable page.
 * A plain string (not an Angular template) so it is testable without a DOM
 * and carries its own inline styles. All record data goes through
 * escapeHtml(), since imported text can contain <, & or quotes.
 */

import { ReportDocument } from './report-types';

/** HTML-escape a string. `&` must be replaced first to avoid double-escaping. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The print stylesheet: headings repeat on every page, rows never split
 * across a page break, and a fixed @page margin keeps the table printable.
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
    return '<p class="empty">No coins to report. Nothing matched the current filters.</p>';
  }

  // The photo column only exists when there is at least one photograph.
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

    // App-generated `data:` URLs, never user-typed text.
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
 * The whole page, ready to be written into a print window. The doctype keeps
 * the window out of quirks mode, where table and @page rules behave differently.
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
