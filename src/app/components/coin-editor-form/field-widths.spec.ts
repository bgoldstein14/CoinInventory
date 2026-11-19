/**
 * Pins where the editor's field widths are declared: in coin-editor-form.scss, in character
 * units, with no inline percentage widths (a 125% inline width once made the Certification
 * Number overflow under the Catalogue select). Text scan, since the suite has no DOM.
 *
 * Comments are stripped before every assertion so explanatory prose cannot satisfy them.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Removes HTML comments. */
function stripHtmlComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

/** Both Sass comment styles. `//` to end of line, and `/* ... *\/` blocks. */
function stripScssComments(scss: string): string {
  return scss.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const TEMPLATE = stripHtmlComments(
  readFileSync(join(__dirname, 'coin-editor-form.html'), 'utf8')
);
const STYLES = stripScssComments(
  readFileSync(join(__dirname, 'coin-editor-form.scss'), 'utf8')
);

/**
 * The `<label>…</label>` carrying `className`. Labels do not nest, so the first `</label>`
 * ends it.
 */
function labelBlock(className: string): string {
  const open = TEMPLATE.indexOf(className);
  expect(open, `no element carries ${className}`).toBeGreaterThan(-1);
  const start = TEMPLATE.lastIndexOf('<label', open);
  const end = TEMPLATE.indexOf('</label>', open);
  expect(start, `${className} is not inside a <label>`).toBeGreaterThan(-1);
  expect(end, `the <label> holding ${className} is never closed`).toBeGreaterThan(start);
  return TEMPLATE.slice(start, end);
}

/** Body of the Sass rule whose selector mentions `selector`, including nested rules. */
function ruleBody(selector: string): string {
  const at = STYLES.indexOf(selector);
  expect(at, `no rule mentions ${selector}`).toBeGreaterThan(-1);
  const open = STYLES.indexOf('{', at);
  expect(open, `${selector} opens no block`).toBeGreaterThan(-1);

  let depth = 0;
  for (let i = open; i < STYLES.length; i++) {
    if (STYLES[i] === '{') depth++;
    else if (STYLES[i] === '}') {
      depth--;
      if (depth === 0) return STYLES.slice(open + 1, i);
    }
  }
  throw new Error(`the rule for ${selector} is never closed`);
}

describe('the Certification Number input is sized by the stylesheet, not inline', () => {
  it('carries no inline style attribute at all', () => {
    const block = labelBlock('detail-field--cert-number');
    /* No inline style at all: geometry could also arrive as flex-basis or inline-size. */
    expect(block).not.toMatch(/\bstyle\s*=/);
  });

  it('leaves no percentage width anywhere in the template', () => {
    /* No percentage widths anywhere; the hidden spacer's inline style sets no geometry. */
    const inlineStyles = TEMPLATE.match(/\bstyle\s*=\s*"[^"]*"/g) ?? [];
    const sizing = inlineStyles.filter((s) => /width|height|flex|size/i.test(s));
    expect(sizing).toEqual([]);
  });

  it('is as wide as the Weight (g) box above it', () => {
    // Same column, same cap, and no fixed input width, so both boxes fill the same space.
    const certMax = /\bmax-width:\s*(\d+)px/.exec(ruleBody('.detail-field--cert-number'));
    const weightMax = /\bmax-width:\s*(\d+)px/.exec(ruleBody('.detail-field--weight {'));
    expect(certMax?.[1]).toBe(weightMax?.[1]);
    expect(ruleBody('.detail-field--cert-number')).not.toMatch(/input\s*\{[^}]*\bwidth:/);
  });
});

describe('the certification number shares the Value / Melt row', () => {
  it('is the first field of the pricing row, before Value', () => {
    const row = TEMPLATE.indexOf('detail-editor__row--pricing');
    const cert = TEMPLATE.indexOf('detail-field--cert-number');
    const value = TEMPLATE.indexOf('<span>Value</span>');
    expect(row).toBeGreaterThan(-1);
    expect(cert).toBeGreaterThan(row);
    expect(cert).toBeLessThan(value);
    expect(TEMPLATE).toContain('<span>Cert. Number</span>');
    expect(TEMPLATE).not.toContain('detail-editor__row--certs');
  });

  it('sizes the row\'s three tracks with minmax(0, …) so they can shrink', () => {
    const at = STYLES.indexOf('.detail-editor__row--pricing');
    const open = STYLES.indexOf('{', at);
    expect(STYLES.slice(open, STYLES.indexOf('}', open)))
      .toMatch(/grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  });
});

describe('the Notes box adds no phantom height at the bottom of the panel', () => {
  it('renders the textarea as a block', () => {
    /* Block display avoids the descender gap under an inline textarea. */
    expect(ruleBody('.detail-notes textarea')).toMatch(/\bdisplay:\s*block\b/);
  });

  it('keeps the textarea resizable, so a long note is still readable', () => {
    /* Let the user resize rather than fixing a larger height. */
    expect(ruleBody('.detail-notes textarea')).toMatch(/\bresize:\s*vertical\b/);
  });
});
