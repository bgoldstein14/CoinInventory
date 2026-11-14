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
import '@angular/compiler';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { ApiService } from '../../services/api.service';
import { InventoryService } from '../../services/inventory.service';
import { LoggingService } from '../../services/logging.service';
import { NotificationService } from '../../services/notification.service';
import { coinThumbnailRevisions } from '../../services/inventory/coin-thumbnail-revision';
import { InventoryTable } from './inventory-table';
import { CoinRecord } from '../../types/coin.model';
import { createMockDependencies } from '../../testing/test-helpers';

function listCoin(id: string, imageCount: number): CoinRecord {
  return { id, imageCount } as unknown as CoinRecord;
}

interface TableUnderTest {
  hasPhoto(coin: CoinRecord): boolean;
  showsThumbnail(coin: CoinRecord): boolean;
  thumbnailPlaceholder(coin: CoinRecord): string;
  thumbnailUrl(coin: CoinRecord): string;
}

function createTable(draftIds: string[] = []): TableUnderTest {
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

  return runInInjectionContext(injector, () => new InventoryTable()) as unknown as TableUnderTest;
}

const TEMPLATE_RAW = readFileSync(join(__dirname, 'inventory-table.html'), 'utf8');

/**
 * The template with its HTML comments stripped. Several tests in this project
 * were historically satisfied by the comment that explains the rule rather
 * than by the code that implements it; a test its own documentation passes is
 * not a test.
 */
const TEMPLATE = TEMPLATE_RAW.replace(/<!--[\s\S]*?-->/g, '');

describe('the thumbnail URL moves when the saved photographs move', () => {
  beforeEach(() => coinThumbnailRevisions.clear());
  afterEach(() => coinThumbnailRevisions.clear());

  it('is the bare endpoint URL for a coin whose photographs have not changed', () => {
    const table = createTable();
    expect(table.thumbnailUrl(listCoin('morgan', 1))).not.toContain('?');
  });

  it('changes once a confirmed save has changed the coin images', () => {
    const table = createTable();
    const before = table.thumbnailUrl(listCoin('morgan', 1));

    coinThumbnailRevisions.bump('morgan');

    expect(table.thumbnailUrl(listCoin('morgan', 1))).not.toBe(before);
  });

  it('leaves every OTHER coin on its cacheable URL', () => {
    const table = createTable();
    const peaceBefore = table.thumbnailUrl(listCoin('peace', 1));

    coinThumbnailRevisions.bump('morgan');

    expect(table.thumbnailUrl(listCoin('peace', 1))).toBe(peaceBefore);
  });
});

describe('no thumbnail is requested for a row the database does not have', () => {
  beforeEach(() => coinThumbnailRevisions.clear());
  afterEach(() => coinThumbnailRevisions.clear());

  it('renders no <img> for an unsaved draft, however many photos it holds locally', () => {
    const table = createTable(['draft-1']);
    const draft = { id: 'draft-1', imagePaths: ['data:image/jpeg;base64,AAA'] } as CoinRecord;

    expect(table.hasPhoto(draft)).toBe(true);
    expect(table.showsThumbnail(draft)).toBe(false);
  });

  it('still renders one for an ordinary saved coin with photographs', () => {
    const table = createTable(['draft-1']);
    expect(table.showsThumbnail(listCoin('morgan', 2))).toBe(true);
  });

  it('says the photo is unsaved rather than claiming there is none', () => {
    const table = createTable(['draft-1']);
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
    ) as unknown as TableUnderTest;

    expect(() => table.showsThumbnail(listCoin('morgan', 1))).not.toThrow();
  });
});

describe('the template', () => {
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

describe('the revision registry is shared, not per component', () => {
  beforeEach(() => coinThumbnailRevisions.clear());
  afterEach(() => coinThumbnailRevisions.clear());

  it('a bump made by the editor is visible to a table built afterwards', () => {
    coinThumbnailRevisions.bump('morgan');
    const table = createTable();
    const other = createTable();
    expect(table.thumbnailUrl(listCoin('morgan', 1)))
      .toBe(other.thumbnailUrl(listCoin('morgan', 1)));
    expect(table.thumbnailUrl(listCoin('morgan', 1))).toContain('?');
  });
});
