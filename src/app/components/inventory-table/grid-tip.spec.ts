/* A small tip above the grid says that clicking a coin opens it in the editor. Text scan. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const TEMPLATE = readFileSync(join(__dirname, 'inventory-table.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const STYLES = readFileSync(join(__dirname, 'inventory-table.scss'), 'utf8');

describe('the grid tip', () => {
  it('sits above the grid and only when there are rows to click', () => {
    const tipAt = TEMPLATE.indexOf('class="grid-tip"');
    expect(tipAt).toBeGreaterThan(-1);
    expect(tipAt).toBeLessThan(TEMPLATE.indexOf('class="inventory-table-wrap"'));
    expect(TEMPLATE.slice(TEMPLATE.lastIndexOf('@if', tipAt), tipAt)).toContain('filters().gridRows().length > 0');
  });

  it('says what a click does', () => {
    expect(TEMPLATE).toContain('Click a coin to open it in the editor.');
  });

  it('is set in very small type', () => {
    expect(STYLES).toMatch(/\.grid-tip \{[^}]*font-size:\s*0\.6\d?rem/);
  });
});
