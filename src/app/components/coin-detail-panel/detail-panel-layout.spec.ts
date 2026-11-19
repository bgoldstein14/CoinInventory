/*
 * The Details panel closes with an × in its top-right corner, and Delete sits
 * at the bottom left, away from where a user reaches to close. Text scan.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const TEMPLATE = readFileSync(join(__dirname, 'coin-detail-panel.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const STYLES = readFileSync(join(__dirname, 'coin-detail-panel.scss'), 'utf8');

const headerAt = TEMPLATE.indexOf('class="detail-header"');
const header = TEMPLATE.slice(headerAt, TEMPLATE.indexOf('</div>', headerAt));
const formAt = TEMPLATE.indexOf('<app-coin-editor-form');

describe('the Details panel buttons', () => {
  it('closes with an × button labelled Close in the header', () => {
    expect(header).toMatch(/<button[^>]*class="detail-close"[^>]*aria-label="Close"[^>]*\(click\)="closeRequested\.emit\(\)"[^>]*>&times;<\/button>/);
    expect(TEMPLATE).not.toContain('>Close</button>');
  });

  it('puts Delete in a footer after the whole form, not in the header', () => {
    const deleteAt = TEMPLATE.indexOf('(click)="deleteRequested.emit()"');
    expect(header).not.toContain('deleteRequested');
    expect(deleteAt).toBeGreaterThan(formAt);
    expect(TEMPLATE.lastIndexOf('class="detail-footer"', deleteAt)).toBeGreaterThan(formAt);
  });

  it('pins the footer to the bottom left of the panel', () => {
    expect(STYLES).toMatch(/\.detail-footer \{[^}]*margin-top:\s*auto/);
    expect(STYLES).toMatch(/\.detail-footer \{[^}]*justify-content:\s*flex-start/);
  });
});
