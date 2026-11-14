/**
 * The Photo column: what the grid decides per row, and what the template does
 * with those decisions.
 *
 * FOLDED IN FROM, and replacing, two files that are now deleted:
 *   - inventory-table-thumbnails.spec.ts       (the Photo column itself)
 *   - inventory-table-unsaved-thumbnail.spec.ts (revisions, and draft rows)
 *
 * Each of their headers is carried below verbatim, as a banner above the
 * helpers it came with. Nothing else about either file changed: every test
 * and every assertion is the original.
 *
 * TWO BUILDERS, DELIBERATELY. `createPhotoTable` monkey-patches the api mock
 * with a one-argument `coinThumbnailUrl` that IGNORES the revision and
 * returns an absolute URL; `createDraftTable` uses the real shared mock from
 * testing/test-helpers.ts, which HONOURS the revision. That is a real
 * behavioural difference two different tests depend on, not duplication.
 *
 * SHARED STATE. `coinThumbnailRevisions` is a module-level singleton. While
 * these were two files vitest's per-file isolation kept them apart; in one
 * file it does not, so the registry is cleared once, file-wide, in the
 * beforeEach below. The per-describe clear pairs the unsaved file carried are
 * now redundant and have been removed.
 */
import '@angular/compiler';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { ApiService } from '../../services/api.service';
import { InventoryService } from '../../services/inventory.service';
import { LoggingService } from '../../services/logging.service';
import { NotificationService } from '../../services/notification.service';
import { coinThumbnailRevisions } from '../../services/inventory/coin-thumbnail-revision';
import { InventoryTable } from './inventory-table';
import { CoinRecord } from '../../types/coin.model';
import { createMockDependencies } from '../../testing/test-helpers';

/**
 * The template with its HTML comments removed, shared by both halves of this
 * file. Carried over from both originals, which stripped comments the same
 * way and for the same reason:
 *
 * THIS MATTERS. The first version of the `loading="lazy"` test below read
 * the raw file, and the comment ABOVE the <img> explaining why lazy loading
 * is essential contains the string `loading="lazy"`. Deleting the attribute
 * from the actual tag left the test green. A test that its own documentation
 * satisfies is not a test.
 */
const TEMPLATE = readFileSync(join(__dirname, 'inventory-table.html'), 'utf8')
  .replace(/<!--[\s\S]*?-->/g, '');

/** A coin as `GET /api/coins` hands it over: an imageCount, no imagePaths. */
function listCoin(id: string, imageCount: number): CoinRecord {
  return { id, imageCount } as unknown as CoinRecord;
}

interface PhotoTable {
  hasPhoto(coin: CoinRecord): boolean;
  showsThumbnail(coin: CoinRecord): boolean;
  thumbnailPlaceholder(coin: CoinRecord): string;
  thumbnailUrl(coin: CoinRecord): string;
}

/* ===== header carried verbatim from inventory-table-thumbnails.spec.ts ===== */
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

/** Was `createTable` in inventory-table-thumbnails.spec.ts. Revision-blind. */
function createPhotoTable() {
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

/* ===== header carried verbatim from inventory-table-unsaved-thumbnail.spec.ts ===== */
/**
 * The Photo column, for the two bugs the owner hit.
 *
 *  1. The row's thumbnail URL now carries the coin's image revision, so a
 *     photograph the server has just accepted produces a URL the browser has
 *     not already failed on. Revision 0 — a coin whose photographs have not
 *     changed this session — must still produce the bare URL, or every scroll
 *     would re-download instead of revalidating with a 304.
 *
 *  2. A row the database does not have cannot have a thumbnail. Asking for
 *     one is a guaranteed 404 ("No thumbnail available for coin ..." in the
 *     owner's log), so the grid must not ask.
 *
 * No jsdom here: the component's decisions are plain methods, and the
 * template is asserted as text with its comments stripped — see the note on
 * TEMPLATE below.
 */

/** Was `createTable` in inventory-table-unsaved-thumbnail.spec.ts.
 *  Uses the real shared api mock, which honours the thumbnail revision. */
function createDraftTable(draftIds: string[] = []): PhotoTable {
  const deps = createMockDependencies();
  const injector = Injector.create({
    providers: [
      { provide: ApiService, useValue: deps.mockApiService },
      { provide: LoggingService, useValue: deps.mockLogger },
      { provide: NotificationService, useValue: deps.mockNotification },
      {
        provide: InventoryService,
        useValue: {
          inventory: () => [],
          isDraftCoin: (id: string) => draftIds.includes(id)
        }
      },
    ]
  });

  return runInInjectionContext(injector, () => new InventoryTable()) as unknown as PhotoTable;
}

/* The revision registry is a module-level singleton; one clear for the whole
 * file now that these two suites share a module graph. */
beforeEach(() => coinThumbnailRevisions.clear());

/* --- from inventory-table-thumbnails.spec.ts --- */
describe('the Photo column decides from imageCount, not from image data', () => {
  it('renders a thumbnail for a coin the list says has photographs', () => {
    const table = createPhotoTable();
    expect(table.hasPhoto(listCoin('morgan', 2))).toBe(true);
  });

  it('renders NOTHING, and so requests nothing, for a coin with no photographs', () => {
    const table = createPhotoTable();
    expect(table.hasPhoto(listCoin('plain', 0))).toBe(false);
  });

  it('does not throw on a coin with neither imagePaths nor imageCount', () => {
    const table = createPhotoTable();
    expect(table.hasPhoto({ id: 'odd' } as unknown as CoinRecord)).toBe(false);
  });

  it('still works from the in-memory array once a coin has been opened', () => {
    const table = createPhotoTable();
    const hydrated = { id: 'c1', imagePaths: ['data:image/jpeg;base64,AAA'] } as CoinRecord;
    expect(table.hasPhoto(hydrated)).toBe(true);
    expect(table.photoCount(hydrated)).toBe(1);
  });

  it('points the image at the per-coin thumbnail endpoint', () => {
    const table = createPhotoTable();
    expect(table.thumbnailUrl(listCoin('morgan-1921', 1)))
      .toBe('http://localhost:3000/api/coins/morgan-1921/thumbnail');
  });

  it('escapes a coin id that would otherwise break the URL', () => {
    const table = createPhotoTable();
    expect(table.thumbnailUrl(listCoin('a/b?c', 1))).toContain('a%2Fb%3Fc');
  });
});

/* --- from inventory-table-unsaved-thumbnail.spec.ts --- */
describe('the thumbnail URL moves when the saved photographs move', () => {
  it('is the bare endpoint URL for a coin whose photographs have not changed', () => {
    const table = createDraftTable();
    expect(table.thumbnailUrl(listCoin('morgan', 1))).not.toContain('?');
  });

  it('changes once a confirmed save has changed the coin images', () => {
    const table = createDraftTable();
    const before = table.thumbnailUrl(listCoin('morgan', 1));

    coinThumbnailRevisions.bump('morgan');

    expect(table.thumbnailUrl(listCoin('morgan', 1))).not.toBe(before);
  });

  it('leaves every OTHER coin on its cacheable URL', () => {
    const table = createDraftTable();
    const peaceBefore = table.thumbnailUrl(listCoin('peace', 1));

    coinThumbnailRevisions.bump('morgan');

    expect(table.thumbnailUrl(listCoin('peace', 1))).toBe(peaceBefore);
  });
});

describe('no thumbnail is requested for a row the database does not have', () => {
  it('renders no <img> for an unsaved draft, however many photos it holds locally', () => {
    const table = createDraftTable(['draft-1']);
    const draft = { id: 'draft-1', imagePaths: ['data:image/jpeg;base64,AAA'] } as CoinRecord;

    expect(table.hasPhoto(draft)).toBe(true);
    expect(table.showsThumbnail(draft)).toBe(false);
  });

  it('still renders one for an ordinary saved coin with photographs', () => {
    const table = createDraftTable(['draft-1']);
    expect(table.showsThumbnail(listCoin('morgan', 2))).toBe(true);
  });

  it('says the photo is unsaved rather than claiming there is none', () => {
    const table = createDraftTable(['draft-1']);
    const draft = { id: 'draft-1', imagePaths: ['data:image/jpeg;base64,AAA'] } as CoinRecord;

    expect(table.thumbnailPlaceholder(draft)).not.toBe('No photo');
    expect(table.thumbnailPlaceholder(listCoin('plain', 0))).toBe('No photo');
  });

  it('survives an InventoryService stub with no isDraftCoin at all', () => {
    const deps = createMockDependencies();
    const injector = Injector.create({
      providers: [
        { provide: ApiService, useValue: deps.mockApiService },
        { provide: LoggingService, useValue: deps.mockLogger },
        { provide: NotificationService, useValue: deps.mockNotification },
        { provide: InventoryService, useValue: { inventory: () => [] } },
      ]
    });
    const table = runInInjectionContext(
      injector, () => new InventoryTable()
    ) as unknown as PhotoTable;

    expect(() => table.showsThumbnail(listCoin('morgan', 1))).not.toThrow();
  });
});

describe('the revision registry is shared, not per component', () => {
  it('a bump made by the editor is visible to a table built afterwards', () => {
    coinThumbnailRevisions.bump('morgan');
    const table = createDraftTable();
    const other = createDraftTable();
    expect(table.thumbnailUrl(listCoin('morgan', 1)))
      .toBe(other.thumbnailUrl(listCoin('morgan', 1)));
    expect(table.thumbnailUrl(listCoin('morgan', 1))).toContain('?');
  });
});

/* --- template assertions from inventory-table-thumbnails.spec.ts --- */
describe('the template — the lazy thumbnail', () => {
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

/* --- template assertions from inventory-table-unsaved-thumbnail.spec.ts --- */
describe('the template — gating the <img>', () => {
  it('gates the <img> on the saved-thumbnail decision, not on hasPhoto alone', () => {
    expect(TEMPLATE).toContain('showsThumbnail(coin)');

    const thumbnailTag = /<img[^>]*class="row-thumb"[^>]*>/.exec(TEMPLATE)?.[0];
    expect(thumbnailTag).toBeDefined();
    expect(thumbnailTag).toContain('loading="lazy"');
    expect(thumbnailTag).toContain('thumbnailUrl(coin)');
  });

  it('still never binds a row thumbnail to inline image data', () => {
    expect(TEMPLATE).not.toContain('imagePaths[0]');
    expect(TEMPLATE).not.toContain('primaryImage');
  });
});
