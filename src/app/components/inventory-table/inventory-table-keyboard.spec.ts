/*
 * The grid is operated by the row, and the row is operated by the keyboard.
 *
 * TWO CHANGES, ONE TEST FILE, BECAUSE THEY ARE ONE CHANGE. The per-row
 * "Details" button is gone — the row itself opens the panel now — and a
 * <tr> with a (click) handler is not reachable by keyboard at all. Removing
 * the button without the keyboard work would have been a straight
 * accessibility regression, so the two are tested together.
 *
 * NO JSDOM. The decisions are plain methods on the component and pure
 * functions in features/inventory/grid-keyboard.ts (tested exhaustively in
 * grid-keyboard.spec.ts). The BINDINGS — which only exist in the template —
 * are asserted against the template text, with its comments stripped first:
 * several tests in this project were historically satisfied by the comment
 * explaining the rule rather than by the code implementing it.
 */
import '@angular/compiler';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Injector, runInInjectionContext } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { ApiService } from '../../services/api.service';
import { InventoryService } from '../../services/inventory.service';
import { LoggingService } from '../../services/logging.service';
import { NotificationService } from '../../services/notification.service';
import { CoinRecord } from '../../types/coin.model';
import { createMockDependencies } from '../../testing/test-helpers';
import { InventoryTable } from './inventory-table';

interface TableUnderTest {
  rowTabIndex(coinId: string): number;
  activateRow(coinId: string): void;
  onRowFocused(coinId: string): void;
  onRowKeydown(event: unknown, coinId: string): void;
  draftStatus(coin: CoinRecord): { chip: string; summary: string; failed: boolean };
}

interface Opened { ids: string[] }

interface TableHarness {
  table: TableUnderTest;
  opened: Opened;
}

/**
 * Builds the component and hands it the one input its keyboard code reads.
 *
 * The input is replaced with a plain function rather than driven through
 * TestBed: TestBed needs a DOM and there is none here. A signal input is an
 * ordinary configurable class field, so overwriting it is a seam, not a
 * trick — `this.filters()` is all the component ever does with it.
 */
function createTable(options: {
  coinIds?: string[];
  selectedCoinId?: string | null;
  draftIds?: string[];
  draftHint?: string;
} = {}): TableHarness {
  const coinIds = options.coinIds ?? ['a', 'b', 'c'];
  const draftIds = options.draftIds ?? [];
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
          selectedCoinId: () => options.selectedCoinId ?? null,
          isDraftCoin: (id: string) => draftIds.includes(id),
          draftHint: () => options.draftHint ?? ''
        }
      }
    ]
  });

  const table = runInInjectionContext(injector, () => new InventoryTable());
  const rows = coinIds.map(id => ({ id } as CoinRecord));
  (table as unknown as Record<string, unknown>)['filters'] = () => ({
    filteredInventory: () => rows
  });

  const opened: Opened = { ids: [] };
  table.detailRequested.subscribe(id => opened.ids.push(id));

  return { table: table as unknown as TableUnderTest, opened };
}

/** Which of the given rows is the one carrying tabindex="0". */
function tabbableRows(table: TableUnderTest, coinIds: string[]): string[] {
  return coinIds.filter(id => table.rowTabIndex(id) === 0);
}

function keyEvent(key: string, tagName = 'TR') {
  return { key, target: { tagName }, preventDefault: vi.fn() };
}

describe('activating a row opens the Details panel', () => {
  it('reports the coin upwards when the row is clicked', () => {
    const { table, opened } = createTable();
    table.activateRow('b');
    expect(opened.ids).toEqual(['b']);
  });

  it('does NOT toggle: activating the same row again keeps asking to open it', () => {
    // The row is not a button. Clicking the row you are reading must not
    // make the panel vanish; the shell's openCoinDetail is unconditional and
    // app.spec.ts pins that down from the other end.
    const { table, opened } = createTable();
    table.activateRow('b');
    table.activateRow('b');
    expect(opened.ids).toEqual(['b', 'b']);
  });

  it('opens on Enter', () => {
    const { table, opened } = createTable();
    const event = keyEvent('Enter');
    table.onRowKeydown(event, 'c');
    expect(opened.ids).toEqual(['c']);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('opens on Space, and swallows it so the page does not scroll', () => {
    const { table, opened } = createTable();
    const event = keyEvent(' ');
    table.onRowKeydown(event, 'a');
    expect(opened.ids).toEqual(['a']);
    expect(event.preventDefault).toHaveBeenCalled();
  });
});

describe('keys inside a row control stay with the control', () => {
  it('leaves Space in the selection checkbox alone, so the box still toggles', () => {
    // Otherwise ticking a row for a bulk edit would throw the sidebar open
    // and the checkbox would never toggle.
    const { table, opened } = createTable();
    const event = keyEvent(' ', 'INPUT');
    table.onRowKeydown(event, 'a');
    expect(opened.ids).toEqual([]);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('leaves Enter on the Images button alone', () => {
    const { table, opened } = createTable();
    const event = keyEvent('Enter', 'BUTTON');
    table.onRowKeydown(event, 'a');
    expect(opened.ids).toEqual([]);
  });
});

describe('arrow keys move between rows without opening anything', () => {
  it('moves the tab stop down a row', () => {
    const { table } = createTable({ coinIds: ['a', 'b', 'c'] });
    table.onRowFocused('a');
    expect(tabbableRows(table, ['a', 'b', 'c'])).toEqual(['a']);

    table.onRowKeydown(keyEvent('ArrowDown'), 'a');
    expect(tabbableRows(table, ['a', 'b', 'c'])).toEqual(['b']);
  });

  it('moves it back up again', () => {
    const { table } = createTable();
    table.onRowFocused('c');
    table.onRowKeydown(keyEvent('ArrowUp'), 'c');
    expect(tabbableRows(table, ['a', 'b', 'c'])).toEqual(['b']);
  });

  it('stops at the ends instead of wrapping round the grid', () => {
    const { table } = createTable();
    table.onRowFocused('a');
    table.onRowKeydown(keyEvent('ArrowUp'), 'a');
    expect(tabbableRows(table, ['a', 'b', 'c'])).toEqual(['a']);

    table.onRowFocused('c');
    table.onRowKeydown(keyEvent('ArrowDown'), 'c');
    expect(tabbableRows(table, ['a', 'b', 'c'])).toEqual(['c']);
  });

  it('swallows the arrow key, or the page scrolls as the selection moves', () => {
    const { table } = createTable();
    const event = keyEvent('ArrowDown');
    table.onRowKeydown(event, 'a');
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('opens nothing on the way past', () => {
    // Arrowing down a list to look for something must not open a detail
    // panel on every row it crosses.
    const { table, opened } = createTable();
    table.onRowKeydown(keyEvent('ArrowDown'), 'a');
    table.onRowKeydown(keyEvent('ArrowDown'), 'b');
    expect(opened.ids).toEqual([]);
  });

  it('does nothing at all for a key the grid does not bind', () => {
    const { table, opened } = createTable();
    const event = keyEvent('Escape');
    table.onRowKeydown(event, 'a');
    expect(opened.ids).toEqual([]);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

describe('the roving tabindex', () => {
  it('keeps exactly one row in the tab order, so Tab can leave the table', () => {
    const coinIds = Array.from({ length: 105 }, (_, i) => `coin-${i}`);
    const { table } = createTable({ coinIds });
    expect(tabbableRows(table, coinIds)).toHaveLength(1);
  });

  it('starts on the selected coin, so Tab lands where the rest of the screen is', () => {
    const { table } = createTable({ selectedCoinId: 'b' });
    expect(tabbableRows(table, ['a', 'b', 'c'])).toEqual(['b']);
  });

  it('starts on the first row when nothing is selected', () => {
    const { table } = createTable({ selectedCoinId: null });
    expect(tabbableRows(table, ['a', 'b', 'c'])).toEqual(['a']);
  });

  it('follows focus that arrived some other way, such as a click', () => {
    const { table } = createTable({ selectedCoinId: 'a' });
    table.onRowFocused('c');
    expect(tabbableRows(table, ['a', 'b', 'c'])).toEqual(['c']);
  });
});

describe('what an unsaved row says about itself', () => {
  it('asks for the denomination rather than reporting an error', () => {
    const { table } = createTable({ draftIds: ['a'] });
    const status = table.draftStatus({ id: 'a', year: '1921' } as CoinRecord);
    expect(status.chip).toBe('Needs Denomination');
    expect(status.failed).toBe(false);
  });

  it('reports a refused save as a failure, which is a different event', () => {
    const refusal = 'Not saved yet — the last attempt failed: 500. Edit this row to retry.';
    const { table } = createTable({ draftIds: ['a'], draftHint: refusal });
    const complete = { id: 'a', year: '1921', coinType: 'Morgan', denomination: 'Dollar' } as CoinRecord;
    expect(table.draftStatus(complete).failed).toBe(true);
  });

  it('survives an InventoryService stub with no draftHint at all', () => {
    // Several specs build this component from a minimal stub; a missing
    // method must not turn a grid row into a crash.
    const deps = createMockDependencies();
    const injector = Injector.create({
      providers: [
        { provide: ApiService, useValue: deps.mockApiService },
        { provide: LoggingService, useValue: deps.mockLogger },
        { provide: NotificationService, useValue: deps.mockNotification },
        { provide: InventoryService, useValue: { inventory: () => [] } }
      ]
    });
    const bare = runInInjectionContext(injector, () => new InventoryTable()) as unknown as TableUnderTest;
    expect(() => bare.draftStatus({ id: 'a' } as CoinRecord)).not.toThrow();
  });
});

/* ---- The template, with its comments stripped ---- */

const TEMPLATE = readFileSync(join(__dirname, 'inventory-table.html'), 'utf8')
  .replace(/<!--[\s\S]*?-->/g, '');

describe('the row is wired up as the control', () => {
  it('opens the panel on click', () => {
    expect(TEMPLATE).toContain('(click)="activateRow(coin.id)"');
  });

  it('listens for keys on the row', () => {
    expect(TEMPLATE).toContain('(keydown)="onRowKeydown($event, coin.id)"');
  });

  it('carries a roving tabindex rather than a hard-coded one', () => {
    expect(TEMPLATE).toContain('[tabindex]="rowTabIndex(coin.id)"');
    expect(TEMPLATE).not.toContain('tabindex="0"');
  });

  it('tracks focus arriving from anywhere inside the row', () => {
    // `focusin`, not `focus`: `focus` does not bubble, so clicking the row's
    // checkbox would not count as being on that row.
    expect(TEMPLATE).toContain('(focusin)="onRowFocused(coin.id)"');
  });

  it('marks each row so the component can move focus onto it', () => {
    expect(TEMPLATE).toContain('[attr.data-coin-row]="coin.id"');
  });

  it('announces itself as a grid, which is what the key handling implies', () => {
    expect(TEMPLATE).toContain('role="grid"');
    expect(TEMPLATE).toContain('[attr.aria-selected]="inv.selectedCoinId() === coin.id"');
  });
});

describe('the per-row Details button is gone', () => {
  it('no longer exists in the grid', () => {
    // No element whose entire text is "Details" survives anywhere in the
    // grid, and the template no longer emits the output directly — the row
    // handler does.
    expect(TEMPLATE).not.toMatch(/>\s*Details\s*</);
    expect(TEMPLATE).not.toContain('detailRequested.emit(coin.id)');
  });

  it('took the row-click-only "coinSelected" output with it', () => {
    // Selection and "show me this coin" were two gestures where the user
    // only ever meant one.
    expect(TEMPLATE).not.toContain('coinSelected');
  });

  it('left the Images button behind, which does something different', () => {
    expect(TEMPLATE).toContain('imagesRequested.emit(coin.id)');
    expect(TEMPLATE).toContain("'Images' : 'Add images'");
  });
});

describe('controls that must not open the sidebar still stop the click', () => {
  it('the checkbox cell', () => {
    // Before this change these calls only suppressed a harmless highlight.
    // Now they are what stops ticking a box for a bulk edit throwing the
    // sidebar open.
    expect(TEMPLATE).toContain('(click)="$event.stopPropagation()"');
  });

  it('the Images button', () => {
    expect(TEMPLATE).toContain('(click)="$event.stopPropagation(); imagesRequested.emit(coin.id)"');
  });
});

describe('an unsaved row says what it needs where it can be seen', () => {
  it('shows the phrase, not only a tooltip', () => {
    expect(TEMPLATE).toContain('draftStatus(coin).chip');
    expect(TEMPLATE).toContain('class="draft-need"');
  });

  it('keeps the "Unsaved" chip, which the Photo cell placeholder echoes', () => {
    expect(TEMPLATE).toContain('>Unsaved<');
  });
});
