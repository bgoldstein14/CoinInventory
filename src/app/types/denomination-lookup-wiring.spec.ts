/*
 * denomination-lookup-wiring.spec.ts — the four places the lookup is handed
 * over, which no other test can reach.
 * WHY A GREP AND NOT A REAL TEST
 * `coinDenominationDisplay` takes the Denominations lookup as an argument and
 * answers the coin's plain text when it does not get one. That design is
 * deliberate — see its header: an absent lookup is the honest pre-migration
 * answer, not a degraded one, and it is what keeps the grid readable during
 * hydration and every two-line service stub in this suite working.
 *
 * It also means A CALLER THAT FORGETS TO PASS THE LIST COMPILES, RUNS, AND
 * SHOWS THE WRONG THING. No type error, no exception, no failing assertion —
 * just a screen that disagrees with the coin editor about what the coin is.
 *
 * That is not hypothetical. `formatInventoryCell` gained the Catalogs lookup
 * as its fourth argument; the grid passed it, `formatReportCell` did not, and
 * printed reports said "6819" where the grid said "Sear 6819" until somebody
 * read the code. One silent omission per lookup per call site.
 *
 * The four call sites below are all in Angular templates or in components
 * that reach into InventoryService, and this suite runs under Node with NO
 * jsdom, so none of them can be exercised by rendering. A source grep is the
 * only instrument available. It is a weak test of a strong requirement, and
 * a weak test here is worth considerably more than none: the mutation it
 * catches — deleting an argument — is exactly the one that has happened.
 *
 * `no-unguarded-image-paths.spec.ts` is the existing precedent for this
 * shape of check.
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
    // Without this the grid falls back to the raw column, and the coin
    // editor two panels away reads the same coin differently.
    const template = stripComments(read('app/components/inventory-table/inventory-table.html'));
    expect(template).toContain('formatInventoryCell(coin, column, undefined, undefined, inv.denominations())');
  });

  it('the statistics chart passes it to buildBreakdown', () => {
    const component = stripComments(read('app/components/statistics-modal/statistics-modal.ts'));
    // `[^;]*` rather than `[^)]*`: the earlier arguments are themselves
    // signal reads, so the argument list is full of parentheses.
    expect(component).toMatch(/buildBreakdown\([^;]*this\.inv\.denominations\(\)\)/);
  });

  it('both printed reports are given it, and the catalogues with it', () => {
    // Both documents, because an insurance schedule and an inventory listing
    // describing the same coin differently is the worst version of this bug:
    // one of them goes to an insurer.
    const component = stripComments(read('app/components/report-modal/report-modal.ts'));
    expect(component.match(/denominations: this\.inv\.denominations\(\)/g)).toHaveLength(2);
    expect(component.match(/catalogs: this\.inv\.catalogs\(\)/g)).toHaveLength(2);
  });

  it('the report screen’s own denomination summary reads the display string', () => {
    // The list on the Reports screen sits one click from the grid. It used
    // to group on `c.denomination` directly.
    const component = stripComments(read('app/components/report-modal/report-modal.ts'));
    expect(component).toContain('coinDenominationDisplay(c, denominations)');
  });

  it('the search box builds its haystack from the same function', () => {
    const store = stripComments(read('app/features/inventory/inventory-filter.store.ts'));
    expect(store).toContain('coinDenominationDisplay(coin, denominations)');
  });
});
