/**
 * The Photo column: per-row decisions and the template that uses them.
 *
 * Two builders: `createPhotoTable` patches the api mock with a URL builder
 * that ignores the revision; `createDraftTable` uses the shared mock, which
 * honours it.
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

/** The template with HTML comments removed, so comment text cannot satisfy an assertion. */
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

/** Table whose thumbnail URL ignores the revision. */
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

/** Table using the shared api mock (honours the revision); `draftIds` are unsaved coins. */
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

/* The revision registry is a module-level singleton. */
beforeEach(() => coinThumbnailRevisions.clear());

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

/* --- template assertions --- */
describe('the template — the lazy thumbnail', () => {
  it('marks the row thumbnail ITSELF lazy, so off-screen rows cost nothing', () => {
    const thumbnailTag = /<img[^>]*class="row-thumb"[^>]*>/.exec(TEMPLATE)?.[0];

    expect(thumbnailTag).toBeDefined();
    expect(thumbnailTag).toContain('loading="lazy"');
    expect(thumbnailTag).toContain('thumbnailUrl(coin)');
  });

  it('no longer binds a row thumbnail to inline image data', () => {
    // The list endpoint does not carry image data.
    expect(TEMPLATE).not.toContain('imagePaths[0]');
    expect(TEMPLATE).not.toContain('primaryImage');
  });
});

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
