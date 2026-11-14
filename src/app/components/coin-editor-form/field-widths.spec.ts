/**
 * field-widths.spec.ts — where the editor's field widths are allowed to live.
 *
 * WHY A TEXT SCAN
 * Vitest runs here under plain Node with no jsdom, so nothing in this suite
 * can measure a rendered box. What it CAN do is pin the decision that caused
 * the bug: the Certification Number input used to carry
 *
 *     style="width: 125%; min-width: 125%; max-width: 125%;"
 *
 * A percentage width resolves against the element's containing block — its
 * own grid cell — so 125% is by construction wider than the cell it is in.
 * The surplus spilled right, into the `.detail-field--catalog` cell on the
 * same `.detail-editor__row--certs` row, and because the Catalogue <select>
 * comes later in the document it painted on top of the overflow. That is the
 * "the Catalogue dropdown overlaps the Certification Number" report.
 *
 * The fix is not a smaller percentage. It is no percentage: the width is
 * declared in coin-editor-form.scss in character units, sized from real slab
 * numbers ("2599001", "481230-004" — 7 to 10 characters), beside every other
 * field width in this component.
 *
 * COMMENTS ARE STRIPPED BEFORE EVERY ASSERTION, and that is not decoration.
 * Tests in this repo have previously been kept green by the prose explaining
 * them: the paragraph above contains the literal string `width: 125%`, and
 * the stylesheet's own comment names the percentage it replaced. Asserting
 * against raw file text would make both of those count as markup.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Everything between `<!--` and `-->`, which is where the reasoning lives. */
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
 * The `<label>…</label>` that carries `className`, comments already gone.
 *
 * These labels do not nest, so scanning forward to the first `</label>` is
 * enough — except for the grade wrapper, which is a <div>, and which this
 * helper is not used for.
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

/**
 * The body of the Sass rule whose selector list mentions `selector`, with
 * nested rules left intact — `.detail-field--cert-number` holds an `input {}`
 * block, so a naive scan to the first `}` would stop inside it.
 */
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
    /* Not "no inline WIDTH": no inline style. The hack was three properties
     * (width, min-width, max-width) and a replacement could just as easily
     * arrive as `flex-basis` or `inline-size`. One field's geometry should be
     * readable from one file. */
    expect(block).not.toMatch(/\bstyle\s*=/);
  });

  it('leaves no percentage width anywhere in the template', () => {
    /* A percentage width on a grid child is the shape of this bug wherever
     * it appears, not just on this one input. `visibility: hidden` on the
     * spacer input in the purchase-date row is the only inline style this
     * template is expected to keep, and it sets no geometry. */
    const inlineStyles = TEMPLATE.match(/\bstyle\s*=\s*"[^"]*"/g) ?? [];
    const sizing = inlineStyles.filter((s) => /width|height|flex|size/i.test(s));
    expect(sizing).toEqual([]);
  });

  it('declares the width in the stylesheet, in character units', () => {
    const body = ruleBody('.detail-field--cert-number');
    /* `ch` because the content is a fixed-length code, exactly like the
     * 12ch on `.detail-field--cert-company` and the 11ch on
     * `.detail-field--catalog-number`. A px literal would be a third way of
     * saying the same thing. */
    expect(body).toMatch(/input\s*\{[^}]*\bwidth:\s*\d+(\.\d+)?ch\b/);
  });

  it('holds the longest real slab number, and is not sized for the column', () => {
    const body = ruleBody('.detail-field--cert-number');
    const declared = /\bwidth:\s*(\d+(?:\.\d+)?)ch\b/.exec(body);
    expect(declared, 'no ch width found').not.toBeNull();

    const ch = Number(declared![1]);
    /* "481230-004" is ten characters, the longest shape a real NGC or PCGS
     * number takes. The box is border-box, so the declared width also pays
     * for 7px of padding and 1px of border on each side — call that two
     * characters at this font size. Ten plus two is the floor. */
    expect(ch).toBeGreaterThanOrEqual(12);
    /* And the ceiling: the whole point is a box that looks like a reference
     * code. NVARCHAR(50) is the column, never the box. */
    expect(ch).toBeLessThanOrEqual(16);
  });

  it('no longer reserves 220px of a 121px cell', () => {
    const body = ruleBody('.detail-field--cert-number');
    const maxWidth = /\bmax-width:\s*(\d+)px/.exec(body);
    expect(maxWidth, 'no max-width on the cert number field').not.toBeNull();
    /* The certs row is three equal columns inside the 420px sidebar, which
     * works out at about 121px each. The old 220px could never apply, so it
     * documented nothing; the owner asked for a visibly smaller box. */
    expect(Number(maxWidth![1])).toBeLessThanOrEqual(180);
  });
});

describe('the certification row can actually shrink its cells', () => {
  it('sizes every track with minmax(0, …)', () => {
    /* `1fr` alone is `minmax(auto, 1fr)`: a track that refuses to go below
     * its content's min-content width. One long value in any of the three
     * cells would then widen the row and push it back out of the sidebar,
     * which is the same overlap by another route. The row shares this rule
     * with the pricing and metrics rows. */
    const at = STYLES.indexOf('.detail-editor__row--certs,');
    const inList = at > -1
      ? at
      : STYLES.indexOf('.detail-editor__row--certs');
    expect(inList).toBeGreaterThan(-1);

    const open = STYLES.indexOf('{', inList);
    const selectorList = STYLES.slice(
      STYLES.lastIndexOf('}', inList) + 1,
      open
    );
    expect(selectorList).toContain('.detail-editor__row--certs');
    expect(STYLES.slice(open, STYLES.indexOf('}', open)))
      .toMatch(/grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  });
});

describe('the Notes box adds no phantom height at the bottom of the panel', () => {
  it('renders the textarea as a block', () => {
    /* A textarea is `inline-block` by default, so it sits on its line box's
     * baseline and reserves descender space underneath that nothing draws
     * in. The Notes box is the LAST element in the detail sidebar's flex
     * column, so those pixels land exactly where the panel is already
     * clipping. This does not fix the clipping — see the note in
     * coin-editor-form.scss — it just stops contributing to it. */
    expect(ruleBody('.detail-notes textarea')).toMatch(/\bdisplay:\s*block\b/);
  });

  it('keeps the textarea resizable, so a long note is still readable', () => {
    /* The answer to "the box is too small" must never be a bigger fixed
     * height picked at one window size. `resize: vertical` hands that
     * decision to the person reading the note. */
    expect(ruleBody('.detail-notes textarea')).toMatch(/\bresize:\s*vertical\b/);
  });
});
