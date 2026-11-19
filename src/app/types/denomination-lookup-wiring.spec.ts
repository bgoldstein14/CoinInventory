/*
 * Source-text checks that every screen showing a denomination passes the
 * Denominations lookup. `coinDenominationDisplay` falls back to the coin's
 * plain text when the lookup is omitted, so a forgotten argument compiles and
 * runs but shows the wrong name. These call sites are in templates/components
 * that cannot be rendered under Node, so the source is grepped instead.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(HERE, '..', '..');

function read(relative: string): string {
  return readFileSync(resolve(SRC_ROOT, relative), 'utf8');
}

/** Comments out, so a file that merely MENTIONS a call does not pass. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('every screen that shows a denomination is given the lookup', () => {
  it('the inventory grid passes it to formatInventoryCell', () => {
    const template = stripComments(read('app/components/inventory-table/inventory-table.html'));
    expect(template).toContain('formatInventoryCell(coin, column, undefined, undefined, inv.denominations())');
  });

  it('the statistics chart passes it to buildBreakdown', () => {
    const component = stripComments(read('app/components/statistics-modal/statistics-modal.ts'));
    // `[^;]*`, not `[^)]*`: the earlier arguments are signal reads with parentheses.
    expect(component).toMatch(/buildBreakdown\([^;]*this\.inv\.denominations\(\)\)/);
  });

  it('both printed reports are given it, and the catalogues with it', () => {
    // Both the insurance schedule and the inventory listing.
    const component = stripComments(read('app/components/report-modal/report-modal.ts'));
    expect(component.match(/denominations: this\.inv\.denominations\(\)/g)).toHaveLength(2);
    expect(component.match(/catalogs: this\.inv\.catalogs\(\)/g)).toHaveLength(2);
  });

  it('the report screen’s own denomination summary reads the display string', () => {
    const component = stripComments(read('app/components/report-modal/report-modal.ts'));
    expect(component).toContain('coinDenominationDisplay(c, denominations)');
  });

  it('the search box builds its haystack from the same function', () => {
    const store = stripComments(read('app/features/inventory/inventory-filter.store.ts'));
    expect(store).toContain('coinDenominationDisplay(coin, denominations)');
  });
});
