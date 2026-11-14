/*
 * app-toolbar.spec.ts — the Import and Export split buttons.
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
      ['csv', 'Excel or CSV'],
      ['json', 'JSON'],
      ['qif', 'QIF'],
      ['images', 'Images from folder'],
    ]);
  });

  it('defaults the split button to the first menu entry, not to QIF', () => {
    /* THE BUG THIS PINS. Clicking "Import" without opening the menu used to
     * run the Quicken importer, because the main button carried
     * handleImportSelection('qif'). A split button whose face does
     * something other than its first entry is a trap, and this one pointed
     * at the least-wanted of the four. */
    const [defaultAction, ...menu] = importButtons();

    expect(defaultAction).toEqual(['csv', 'Import']);
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
    expect(new Set(kinds)).toEqual(new Set(['csv', 'json', 'qif', 'images']));
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
