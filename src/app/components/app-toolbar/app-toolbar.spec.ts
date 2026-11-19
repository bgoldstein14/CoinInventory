/*
 * Import/Export split buttons and the help icon. Template and stylesheet are
 * read with comments stripped so assertions match markup, not explanations.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function template(): string {
  return readFileSync(join(__dirname, 'app-toolbar.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
}

/** The stylesheet with both comment styles removed. */
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

/** Every `handleImportSelection('x')` button, in document order, as [kind, label]. */
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
    /* Commonest first; QIF is least common. */
    const [, ...menu] = importButtons();

    expect(menu).toEqual([
      ['excel', 'Excel'],
      ['csv', 'CSV'],
      ['qif', 'QIF'],
      ['images', 'Images from folder'],
    ]);
  });

  it('offers Excel and CSV as two separate entries', () => {
    const labels = importButtons().map(([, label]) => label);

    expect(labels).toContain('Excel');
    expect(labels).toContain('CSV');
    expect(labels.join(' '), 'the compound entry is gone').not.toContain('Excel or CSV');
  });

  it('does not offer JSON', () => {
    /* JSON import was removed; JSON export remains. */
    const kinds = importButtons().map(([kind]) => kind);
    expect(kinds, 'JSON import was removed from the menu').not.toContain('json');

    expect(template(), 'Export -> JSON stays')
      .toMatch(/handleExportSelection\('json'\)/);
  });

  it('defaults the split button to the first menu entry, not to QIF', () => {
    /* The main Import button must run the first menu entry. */
    const [defaultAction, ...menu] = importButtons();

    expect(defaultAction).toEqual(['excel', 'Import']);
    expect(defaultAction[0]).toBe(menu[0][0]);
  });

  it('keeps the photo import separated from the three file importers', () => {
    const markup = template();

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

/** The help button's markup, opening tag through closing tag. */
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
    /* An SVG-only button needs aria-label to have an accessible name. */
    const button = helpButton();

    expect(button, 'screen reader name').toMatch(/aria-label="Help"/);
    expect(button, 'hover tooltip').toMatch(/title="Help"/);
    expect(button, 'the glyph itself is decoration').toMatch(/aria-hidden="true"/);
    expect(button, 'and must not take tab focus of its own')
      .toMatch(/focusable="false"/);
  });

  it('is drawn big enough to find, and gives a bigger target than the glyph', () => {
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
    const colour = ruleBody('.help-icon').match(/color:\s*#([0-9a-f]{6})/i);

    expect(colour, 'the icon declares no colour, so it inherits and is drab').toBeTruthy();

    const hex = colour![1].toLowerCase();
    expect(['7a5b35', '8e5b2d', 'b98748', '513d2c'], 'not a warm brown').not.toContain(hex);

    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    expect(b, 'blue dominates, so this is a blue and not a tinted grey')
      .toBeGreaterThan(Math.max(r, g) + 40);
  });

  it('is a filled disc with a white question mark, not a thin ring', () => {
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
    expect(helpButton()).toMatch(/^<button\b[\s\S]*type="button"/);
  });
});

describe('AppToolbar — the Export menu', () => {
  it('defaults to its own first entry too', () => {
    const pattern = /handleExportSelection\('([a-z]+)'\)"[^>]*>\s*([^<]+?)\s*</g;
    const found = [...template().matchAll(pattern)].map(
      (match) => [match[1], match[2]] as [string, string]
    );
    const [defaultAction, ...menu] = found;

    expect(defaultAction).toEqual(['csv', 'Export']);
    expect(menu[0][0]).toBe(defaultAction[0]);
  });
});
