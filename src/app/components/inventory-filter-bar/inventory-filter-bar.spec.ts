/*
 * inventory-filter-bar.spec.ts — the Status control in the advanced filters.
 *
 * WHY THE TEMPLATE IS READ AS TEXT. There is no jsdom in this project's
 * frontend suite, so the panel cannot be rendered and clicked. What it
 * OFFERS is nonetheless a real decision with a real wrong answer, and the
 * behaviour behind each control is tested directly against the store in
 * features/inventory/inventory-filter.store.spec.ts, in its 'the status
 * filter' block. This file holds the
 * markup half: that the control is tick boxes rather than a dropdown, that
 * there is no "All statuses" entry left, and that an empty selection
 * explains itself.
 *
 * *** COMMENTS ARE STRIPPED FIRST. *** The template explains the change at
 * length and the phrase "All statuses" appears in that prose. An assertion
 * against the raw file would match the explanation and pass with the old
 * dropdown still in place.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function template(): string {
  return readFileSync(join(__dirname, 'inventory-filter-bar.html'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '');
}

describe('the Status filter control', () => {
  it('is a set of tick boxes, one per status', () => {
    const markup = template();

    expect(markup).toContain('filters().collectionStatusOptions');
    expect(markup).toMatch(
      /\[checked\]="filters\(\)\.isCollectionStatusSelected\(option\.value\)"/
    );
    expect(markup).toMatch(
      /\(change\)="filters\(\)\.toggleCollectionStatus\(option\.value\)"/
    );
  });

  it('no longer offers an "All statuses" option', () => {
    /* It was the first entry of a single-select dropdown. With every box
     * ticked by default it says nothing the boxes are not already saying,
     * and two ways to express "everything" is the ambiguity this change
     * exists to remove. */
    const markup = template();

    expect(markup).not.toContain('All statuses');
    expect(markup, 'the status dropdown is gone')
      .not.toContain('collectionStatusFilter.set($event)');
  });

  it('offers All and None, so the extremes are one click each', () => {
    const markup = template();

    expect(markup).toContain('filters().selectAllCollectionStatuses()');
    expect(markup).toContain('filters().clearCollectionStatuses()');
  });

  it('says out loud that an empty selection means an empty grid', () => {
    /* No statuses ticked shows NO coins -- deliberately; see the signal's
     * comment in inventory-filter.store.ts. Without this line the screen is
     * simply blank and the user's first guess is that his coins have gone,
     * so the explanation has to sit next to the control that caused it. */
    const markup = template();

    expect(markup).toContain('filters().collectionStatusFilter().length === 0');
    expect(markup).toContain('no coins are shown');
  });

  it('leaves the other advanced filters alone', () => {
    // Country, Source and Set are untouched by this change. Source in
    // particular: it stopped being a COLUMN, it is still a FILTER.
    const markup = template();

    expect(markup).toContain('filters().countryFilter.set($event)');
    expect(markup).toContain('filters().sourceFilter.set($event)');
    expect(markup).toContain('filters().coinSetFilter.set($event)');
  });
});
