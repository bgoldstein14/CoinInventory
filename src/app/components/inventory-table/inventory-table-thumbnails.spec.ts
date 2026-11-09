/**
 * The Photo column. The grid must show a thumbnail per row without the list
 * endpoint carrying image bytes, and without turning N coins into N requests
 * on load. Each row renders `<img src="/api/coins/:id/thumbnail"
 * loading="lazy">`, and only for coins the list said have photographs.
 *
 * What this file can check, with no jsdom: the two decisions the component
 * makes per row — whether to render an image at all, and what URL to point
 * it at. The `loading="lazy"` attribute itself lives in the template and is
 * asserted against the template text below, because it is load-bearing
 * rather than cosmetic.
 */
import '@angular/compiler';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { ApiService } from '../../services/api.service';
import { InventoryService } from '../../services/inventory.service';
import { LoggingService } from '../../services/logging.service';
import { NotificationService } from '../../services/notification.service';
import { InventoryTable } from './inventory-table';
import { CoinRecord } from '../../types/coin.model';
import { createMockDependencies } from '../../testing/test-helpers';

/** A coin as `GET /api/coins` hands it over: an imageCount, no imagePaths. */
function listCoin(id: string, imageCount: number): CoinRecord {
  return { id, imageCount } as unknown as CoinRecord;
}

function createTable() {
  const deps = createMockDependencies();
  const injector = Injector.create({
    providers: [
      { provide: ApiService, useValue: deps.mockApiService },
      { provide: LoggingService, useValue: deps.mockLogger },
      { provide: NotificationService, useValue: deps.mockNotification },
      { provide: InventoryService, useValue: { inventory: () => [] } },
    ]
  });
  (deps.mockApiService as unknown as Record<string, unknown>)['coinThumbnailUrl'] =
    vi.fn((id: string) => `http://localhost:3000/api/coins/${encodeURIComponent(id)}/thumbnail`);

  return runInInjectionContext(injector, () => new InventoryTable()) as unknown as {
    hasPhoto(coin: CoinRecord): boolean;
    thumbnailUrl(coin: CoinRecord): string;
    photoCount(coin: CoinRecord): number;
  };
}

const TEMPLATE_RAW = readFileSync(join(__dirname, 'inventory-table.html'), 'utf8');

/**
 * The template with its HTML comments removed.
 *
 * THIS MATTERS. The first version of the `loading="lazy"` test below read
 * the raw file, and the comment ABOVE the <img> explaining why lazy loading
 * is essential contains the string `loading="lazy"`. Deleting the attribute
 * from the actual tag left the test green. A test that its own documentation
 * satisfies is not a test.
 */
const TEMPLATE = TEMPLATE_RAW.replace(/<!--[\s\S]*?-->/g, '');

describe('the Photo column decides from imageCount, not from image data', () => {
  it('renders a thumbnail for a coin the list says has photographs', () => {
    const table = createTable();
    expect(table.hasPhoto(listCoin('morgan', 2))).toBe(true);
  });

  it('renders NOTHING, and so requests nothing, for a coin with no photographs', () => {
    const table = createTable();
    expect(table.hasPhoto(listCoin('plain', 0))).toBe(false);
  });

  it('does not throw on a coin with neither imagePaths nor imageCount', () => {
    const table = createTable();
    expect(table.hasPhoto({ id: 'odd' } as unknown as CoinRecord)).toBe(false);
  });

  it('still works from the in-memory array once a coin has been opened', () => {
    const table = createTable();
    const hydrated = { id: 'c1', imagePaths: ['data:image/jpeg;base64,AAA'] } as CoinRecord;
    expect(table.hasPhoto(hydrated)).toBe(true);
    expect(table.photoCount(hydrated)).toBe(1);
  });

  it('points the image at the per-coin thumbnail endpoint', () => {
    const table = createTable();
    expect(table.thumbnailUrl(listCoin('morgan-1921', 1)))
      .toBe('http://localhost:3000/api/coins/morgan-1921/thumbnail');
  });

  it('escapes a coin id that would otherwise break the URL', () => {
    const table = createTable();
    expect(table.thumbnailUrl(listCoin('a/b?c', 1))).toContain('a%2Fb%3Fc');
  });
});

describe('the template', () => {
  it('marks the row thumbnail ITSELF lazy, so off-screen rows cost nothing', () => {
    // Asserted on the <img ...> TAG, with comments stripped; both halves are
    // deliberate — see the note on TEMPLATE above.
    const thumbnailTag = /<img[^>]*class="row-thumb"[^>]*>/.exec(TEMPLATE)?.[0];

    expect(thumbnailTag).toBeDefined();
    expect(thumbnailTag).toContain('loading="lazy"');
    expect(thumbnailTag).toContain('thumbnailUrl(coin)');
  });

  it('no longer binds a row thumbnail to inline image data', () => {
    // `imagePaths[0]` in the grid is the shape that made the list endpoint
    // have to carry every photograph in the collection.
    expect(TEMPLATE).not.toContain('imagePaths[0]');
    expect(TEMPLATE).not.toContain('primaryImage');
  });
});
