/*
 * Markup checks for the Status control in the advanced filters. There is no
 * jsdom here, so the template is read as text; the behaviour is tested in
 * inventory-filter.store.spec.ts. Comments are stripped so prose in the
 * template cannot satisfy an assertion.
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
    const markup = template();

    expect(markup).toContain('filters().collectionStatusFilter().length === 0');
    expect(markup).toContain('no coins are shown');
  });

  it('leaves the other advanced filters alone', () => {
    const markup = template();

    expect(markup).toContain('filters().countryFilter.set($event)');
    expect(markup).toContain('filters().sourceFilter.set($event)');
    expect(markup).toContain('filters().coinSetFilter.set($event)');
  });
});
