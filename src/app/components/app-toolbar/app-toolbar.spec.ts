/*
 * app-toolbar.spec.ts — the Import and Export split buttons, and the help
 * icon's accessible name.
 *
 * WHY THE TEMPLATE IS READ AS TEXT. There is no jsdom in this project's
 * frontend suite, so the menu cannot be rendered and clicked. What the menu
 * OFFERS and in what ORDER is nonetheless a real decision with a real wrong
 * answer — the main Import button spent a long time defaulting to the
 * importer fewest people want — and a decision that only exists in markup is
 * a decision nothing is holding. This file holds it, the same way
 * inventory-table-thumbnails.spec.ts holds `loading="lazy"`.
 *
 * *** COMMENTS ARE STRIPPED FIRST. *** The template explains the ordering at
 * length and names 'qif', 'csv' and the word "default" in that prose. An
 * assertion against the raw text would match the explanation and pass with
 * the buttons in any order at all.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function template(): string {
  return readFileSync(join(__dirname, 'app-toolbar.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * The stylesheet with both comment styles removed.
 *
 * Same reason as the template: the comment above `.help-icon` spends a
 * paragraph on the hex it chose and why, and an assertion run against the
 * raw file would match the explanation of the colour instead of the colour.
 */
function styles(): string {
  return readFileSync(join(__dirname, 'app-toolbar.scss'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** The body of one top-level rule, e.g. ruleBody('.help-icon'). */
function ruleBody(selector: string): string {
  const pattern = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`);
  const match = styles().match(pattern);
  expect(match, `${selector} is missing from app-toolbar.scss`).toBeTruthy();
  return match![1];
}

/**
 * Every `handleImportSelection('x')` button, in document order, as
 * [what it imports, what it says on it].
 *
 * One list for both questions: the FIRST entry is the split button's own
 * face (the default action), and the rest are the menu top to bottom. That
 * is deliberate — the default and the first menu entry have to agree, and
 * reading them out of one sequence is what makes disagreement visible.
 */
function importButtons(): [string, string][] {
  const pattern = /handleImportSelection\('([a-z]+)'\)"[^>]*>\s*([^<]+?)\s*</g;
  const found: [string, string][] = [];
  for (const match of template().matchAll(pattern)) {
    found.push([match[1], match[2]]);
  }
  return found;
}

describe('AppToolbar — the Import menu', () => {
  it('offers the importers commonest-first, with QIF third', () => {
    /* The owner's ordering, in their words: "QIF should be 3rd in the list
     * for the Import as that would be the least common for a user to use".
     * Photos stay last and separated — they are a folder of images rather
     * than a file of coin records, so they are not in the commonest-first
     * ranking at all. */
    const [, ...menu] = importButtons();

    expect(menu).toEqual([
      ['excel', 'Excel'],
      ['csv', 'CSV'],
      ['qif', 'QIF'],
      ['images', 'Images from folder'],
    ]);
  });

  it('offers Excel and CSV as two separate entries', () => {
    /* They were one entry reading "Excel or CSV", on the reasoning that the
     * modal behind it reads either. That is still true of the MODAL — both
     * doors open the same dialog and share every mapping rule — but a user
     * holding a spreadsheet should find the word "Excel" in the list
     * rather than decode a compound label. */
    const labels = importButtons().map(([, label]) => label);

    expect(labels).toContain('Excel');
    expect(labels).toContain('CSV');
    expect(labels.join(' '), 'the compound entry is gone').not.toContain('Excel or CSV');
  });

  it('does not offer JSON', () => {
    /* Removed deliberately: it was the only entry that read a file this
     * application had written. EXPORT to JSON is untouched, which is what
     * the second assertion is for — removing the importer must not take the
     * backup with it. */
    const kinds = importButtons().map(([kind]) => kind);
    expect(kinds, 'JSON import was removed from the menu').not.toContain('json');

    expect(template(), 'Export -> JSON stays')
      .toMatch(/handleExportSelection\('json'\)/);
  });

  it('defaults the split button to the first menu entry, not to QIF', () => {
    /* THE BUG THIS PINS. Clicking "Import" without opening the menu used to
     * run the Quicken importer, because the main button carried
     * handleImportSelection('qif'). A split button whose face does
     * something other than its first entry is a trap, and this one pointed
     * at the least-wanted of the four. */
    const [defaultAction, ...menu] = importButtons();

    expect(defaultAction).toEqual(['excel', 'Import']);
    expect(defaultAction[0]).toBe(menu[0][0]);
  });

  it('keeps the photo import separated from the three file importers', () => {
    const markup = template();

    // The modifier class is what draws the rule above it, and it belongs to
    // exactly one entry.
    expect(markup.split('menu-item--separated').length - 1).toBe(1);
    expect(markup).toMatch(/menu-item--separated"[^>]*handleImportSelection\('images'\)/);
  });

  it('still reaches every importer, so the reorder dropped none of them', () => {
    const kinds = importButtons()
      .slice(1)
      .map(([kind]) => kind);
    expect(new Set(kinds)).toEqual(new Set(['excel', 'csv', 'qif', 'images']));
  });
});

/**
 * The help control's markup, opening tag through closing tag.
 *
 * It is the only button in the row with no words in it, which is exactly why
 * it is worth a test: everything that tells a user what it does now lives in
 * attributes, and attributes are the part a refactor drops silently.
 */
function helpButton(): string {
  const match = template().match(
    /<button\b[^>]*class="[^"]*\bhelp-button\b[^"]*"[^>]*>[\s\S]*?<\/button>/
  );
  expect(match, 'no .help-button in app-toolbar.html').toBeTruthy();
  return match![0];
}

describe('AppToolbar — the help icon', () => {
  it('is an icon, not the words "? Help"', () => {
    const markup = template();

    expect(helpButton()).toMatch(/<svg\b/);
    expect(markup, 'the old text label is gone').not.toContain('? Help');
  });

  it('carries an accessible name, because the glyph is not one', () => {
    /* THE FAILURE THIS PINS. A button whose only child is an <svg> announces
     * as nothing at all to a screen reader, and shows nothing on hover to a
     * sighted user who does not recognise the glyph. Both routes to the name
     * are required, and the SVG is hidden from the tree so it cannot
     * contribute a second, worse one. */
    const button = helpButton();

    expect(button, 'screen reader name').toMatch(/aria-label="Help"/);
    expect(button, 'hover tooltip').toMatch(/title="Help"/);
    expect(button, 'the glyph itself is decoration').toMatch(/aria-hidden="true"/);
    expect(button, 'and must not take tab focus of its own')
      .toMatch(/focusable="false"/);
  });

  it('is drawn big enough to find, and gives a bigger target than the glyph', () => {
    /* THE FEEDBACK THIS PINS. The first version was a 16px glyph in a 32px
     * box and the owner read it as too small. The fix is not only a bigger
     * drawing: the SQUARE is the hit area — padding is zero and there is no
     * inner wrapper taking the press — so the button's own size is what a
     * mouse or a thumb actually gets, and both numbers have to move. */
    const svg = helpButton().match(/<svg\b[\s\S]*?>/)![0];
    const width = Number(svg.match(/width="(\d+)"/)![1]);
    const height = Number(svg.match(/height="(\d+)"/)![1]);

    expect(width, 'the glyph was 16px and read as too small').toBeGreaterThanOrEqual(24);
    expect(height, 'and it is a circle, so it stays square').toBe(width);

    const button = ruleBody('.help-button');
    expect(Number(button.match(/width:\s*(\d+)px/)![1]), 'the target, which was 32px')
      .toBeGreaterThanOrEqual(36);
    expect(Number(button.match(/min-height:\s*(\d+)px/)![1])).toBeGreaterThanOrEqual(36);
    expect(button, 'the whole square is the target').toMatch(/padding:\s*0/);
  });

  it('carries colour, and a blue rather than one of the app\'s browns', () => {
    /* "Something with some color (standard)". The glyph used to be drawn in
     * `currentColor`, which meant it inherited the beige button's #513d2c
     * text and read as drab. Standard, for a help affordance, means the
     * blue — and specifically NOT the warm browns this application draws
     * everything you can press in, because a second brown control the size
     * of a coin next to the Settings button is a second primary action. */
    const colour = ruleBody('.help-icon').match(/color:\s*#([0-9a-f]{6})/i);

    expect(colour, 'the icon declares no colour, so it inherits and is drab').toBeTruthy();

    const hex = colour![1].toLowerCase();
    expect(['7a5b35', '8e5b2d', 'b98748', '513d2c'], 'not a warm brown').not.toContain(hex);

    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    expect(b, 'blue dominates, so this is a blue and not a tinted grey')
      .toBeGreaterThan(Math.max(r, g) + 40);
  });

  it('is a filled disc with a white question mark, not a thin ring', () => {
    /* "A standard Help icon" is the solid circle with the mark knocked out
     * of it, which is what makes it recognisable at a glance. An outlined
     * ring at the same size is the thing that was called drab.
     *
     * And it is three elements of hand-written SVG. NO ICON LIBRARY: the
     * @defer work reclaimed 375 kB and this button is in `main`, which is
     * precisely the chunk a dependency pulled in for one glyph would land
     * in. An <svg> here, with no component tag and no font class, is what
     * that promise looks like in the markup. */
    const button = helpButton();

    expect(button, 'the disc is filled, and takes its colour from the stylesheet')
      .toMatch(/<circle\b[^>]*fill="currentColor"/);
    expect(button, 'the ring-only version had fill="none" on the outer circle')
      .not.toMatch(/<circle\b[^>]*r="9\.25"[^>]*fill="none"/);
    expect(button, 'the question mark reads out of the disc in white')
      .toMatch(/stroke="#ffffff"/);
    expect(button, 'inline SVG, not an icon component or a glyph font')
      .not.toMatch(/<(i|mat-icon|fa-icon|ng-icon)\b/);
  });

  it('stays keyboard reachable', () => {
    /* A real <button type="button"> is tab-reachable and fires on Enter and
     * Space for free. The grid gained full keyboard operation; the toolbar
     * is not allowed to become the weak point by having this swapped for a
     * clickable div or span. */
    expect(helpButton()).toMatch(/^<button\b[\s\S]*type="button"/);
  });
});

describe('AppToolbar — the Export menu', () => {
  it('defaults to its own first entry too', () => {
    // The same rule as Import, asserted here so that "the default is the
    // first entry" is a property of this toolbar rather than a one-off fix
    // to one button.
    const pattern = /handleExportSelection\('([a-z]+)'\)"[^>]*>\s*([^<]+?)\s*</g;
    const found = [...template().matchAll(pattern)].map(
      (match) => [match[1], match[2]] as [string, string]
    );
    const [defaultAction, ...menu] = found;

    expect(defaultAction).toEqual(['csv', 'Export']);
    expect(menu[0][0]).toBe(defaultAction[0]);
  });
});
