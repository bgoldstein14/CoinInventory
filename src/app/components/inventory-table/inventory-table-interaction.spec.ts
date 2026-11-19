/*
 * The inventory grid as the user operates it: keyboard on the rows, and drag
 * (or Alt+Arrow) on the group headings. No jsdom: decisions are tested as
 * component methods, bindings against the template text.
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
import { CoinGroup } from '../../features/inventory/grid-grouping';
import { createMockDependencies } from '../../testing/test-helpers';
import { InventoryTable } from './inventory-table';

interface KeyboardTable {
  rowTabIndex(coinId: string): number;
  activateRow(coinId: string): void;
  onRowFocused(coinId: string): void;
  onRowKeydown(event: unknown, coinId: string): void;
  draftStatus(coin: CoinRecord): { chip: string; summary: string; failed: boolean };
}

interface Opened { ids: string[] }

interface TableHarness {
  table: KeyboardTable;
  opened: Opened;
}

/**
 * Builds the component with a plain-function `filters` input (TestBed needs a
 * DOM, and `this.filters()` is all the component does with it).
 */
function createKeyboardTable(options: {
  coinIds?: string[];
  /** Rows on screen when some groups are collapsed; defaults to coinIds. */
  renderedCoinIds?: string[];
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
  const rendered = (options.renderedCoinIds ?? coinIds).map(id => ({ id } as CoinRecord));
  (table as unknown as Record<string, unknown>)['filters'] = () => ({
    filteredInventory: () => rows,
    renderedInventory: () => rendered
  });

  const opened: Opened = { ids: [] };
  table.detailRequested.subscribe(id => opened.ids.push(id));

  return { table: table as unknown as KeyboardTable, opened };
}

/** Which of the given rows is the one carrying tabindex="0". */
function tabbableRows(table: KeyboardTable, coinIds: string[]): string[] {
  return coinIds.filter(id => table.rowTabIndex(id) === 0);
}

/** Key event on a row; the second argument is the target's tagName. */
function rowKeyEvent(key: string, tagName = 'TR') {
  return { key, target: { tagName }, preventDefault: vi.fn() };
}

/* --- row behaviour --- */
describe('activating a row opens the Details panel', () => {
  it('reports the coin upwards when the row is clicked', () => {
    const { table, opened } = createKeyboardTable();
    table.activateRow('b');
    expect(opened.ids).toEqual(['b']);
  });

  it('does NOT toggle: activating the same row again keeps asking to open it', () => {
    // Not a toggle: the panel's Close button closes it.
    const { table, opened } = createKeyboardTable();
    table.activateRow('b');
    table.activateRow('b');
    expect(opened.ids).toEqual(['b', 'b']);
  });

  it('opens on Enter', () => {
    const { table, opened } = createKeyboardTable();
    const event = rowKeyEvent('Enter');
    table.onRowKeydown(event, 'c');
    expect(opened.ids).toEqual(['c']);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('opens on Space, and swallows it so the page does not scroll', () => {
    const { table, opened } = createKeyboardTable();
    const event = rowKeyEvent(' ');
    table.onRowKeydown(event, 'a');
    expect(opened.ids).toEqual(['a']);
    expect(event.preventDefault).toHaveBeenCalled();
  });
});

describe('keys inside a row control stay with the control', () => {
  it('leaves Space in the selection checkbox alone, so the box still toggles', () => {
    // Otherwise ticking a box would also open the panel.
    const { table, opened } = createKeyboardTable();
    const event = rowKeyEvent(' ', 'INPUT');
    table.onRowKeydown(event, 'a');
    expect(opened.ids).toEqual([]);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('leaves Enter on the Images button alone', () => {
    const { table, opened } = createKeyboardTable();
    const event = rowKeyEvent('Enter', 'BUTTON');
    table.onRowKeydown(event, 'a');
    expect(opened.ids).toEqual([]);
  });
});

describe('arrow keys move between rows without opening anything', () => {
  it('moves the tab stop down a row', () => {
    const { table } = createKeyboardTable({ coinIds: ['a', 'b', 'c'] });
    table.onRowFocused('a');
    expect(tabbableRows(table, ['a', 'b', 'c'])).toEqual(['a']);

    table.onRowKeydown(rowKeyEvent('ArrowDown'), 'a');
    expect(tabbableRows(table, ['a', 'b', 'c'])).toEqual(['b']);
  });

  it('moves it back up again', () => {
    const { table } = createKeyboardTable();
    table.onRowFocused('c');
    table.onRowKeydown(rowKeyEvent('ArrowUp'), 'c');
    expect(tabbableRows(table, ['a', 'b', 'c'])).toEqual(['b']);
  });

  it('stops at the ends instead of wrapping round the grid', () => {
    const { table } = createKeyboardTable();
    table.onRowFocused('a');
    table.onRowKeydown(rowKeyEvent('ArrowUp'), 'a');
    expect(tabbableRows(table, ['a', 'b', 'c'])).toEqual(['a']);

    table.onRowFocused('c');
    table.onRowKeydown(rowKeyEvent('ArrowDown'), 'c');
    expect(tabbableRows(table, ['a', 'b', 'c'])).toEqual(['c']);
  });

  it('swallows the arrow key, or the page scrolls as the selection moves', () => {
    const { table } = createKeyboardTable();
    const event = rowKeyEvent('ArrowDown');
    table.onRowKeydown(event, 'a');
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('opens nothing on the way past', () => {
    // Arrowing is looking, not choosing.
    const { table, opened } = createKeyboardTable();
    table.onRowKeydown(rowKeyEvent('ArrowDown'), 'a');
    table.onRowKeydown(rowKeyEvent('ArrowDown'), 'b');
    expect(opened.ids).toEqual([]);
  });

  it('does nothing at all for a key the grid does not bind', () => {
    const { table, opened } = createKeyboardTable();
    const event = rowKeyEvent('Escape');
    table.onRowKeydown(event, 'a');
    expect(opened.ids).toEqual([]);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

describe('the roving tabindex', () => {
  it('keeps exactly one row in the tab order, so Tab can leave the table', () => {
    const coinIds = Array.from({ length: 105 }, (_, i) => `coin-${i}`);
    const { table } = createKeyboardTable({ coinIds });
    expect(tabbableRows(table, coinIds)).toHaveLength(1);
  });

  it('starts on the selected coin, so Tab lands where the rest of the screen is', () => {
    const { table } = createKeyboardTable({ selectedCoinId: 'b' });
    expect(tabbableRows(table, ['a', 'b', 'c'])).toEqual(['b']);
  });

  it('starts on the first row when nothing is selected', () => {
    const { table } = createKeyboardTable({ selectedCoinId: null });
    expect(tabbableRows(table, ['a', 'b', 'c'])).toEqual(['a']);
  });

  it('follows focus that arrived some other way, such as a click', () => {
    const { table } = createKeyboardTable({ selectedCoinId: 'a' });
    table.onRowFocused('c');
    expect(tabbableRows(table, ['a', 'b', 'c'])).toEqual(['c']);
  });
});

describe('what an unsaved row says about itself', () => {
  it('asks for the denomination rather than reporting an error', () => {
    const { table } = createKeyboardTable({ draftIds: ['a'] });
    const status = table.draftStatus({ id: 'a', year: '1921' } as CoinRecord);
    expect(status.chip).toBe('Needs Denomination');
    expect(status.failed).toBe(false);
  });

  it('reports a refused save as a failure, which is a different event', () => {
    const refusal = 'Not saved yet — the last attempt failed: 500. Edit this row to retry.';
    const { table } = createKeyboardTable({ draftIds: ['a'], draftHint: refusal });
    const complete = { id: 'a', year: '1921', coinType: 'Morgan', denomination: 'Dollar' } as CoinRecord;
    expect(table.draftStatus(complete).failed).toBe(true);
  });

  it('survives an InventoryService stub with no draftHint at all', () => {
    // Some specs use a minimal InventoryService stub.
    const deps = createMockDependencies();
    const injector = Injector.create({
      providers: [
        { provide: ApiService, useValue: deps.mockApiService },
        { provide: LoggingService, useValue: deps.mockLogger },
        { provide: NotificationService, useValue: deps.mockNotification },
        { provide: InventoryService, useValue: { inventory: () => [] } }
      ]
    });
    const bare = runInInjectionContext(injector, () => new InventoryTable()) as unknown as KeyboardTable;
    expect(() => bare.draftStatus({ id: 'a' } as CoinRecord)).not.toThrow();
  });
});

describe('the arrow keys at a collapsed group boundary', () => {
  // The arrows walk only the rows on screen, skipping collapsed groups.

  it('steps over a collapsed group instead of into it', () => {
    // [France: a, b] open, [Germany: hidden-1, hidden-2] collapsed, [Mexico: c] open.
    const { table } = createKeyboardTable({
      coinIds: ['a', 'b', 'hidden-1', 'hidden-2', 'c'],
      renderedCoinIds: ['a', 'b', 'c']
    });

    table.onRowFocused('b');
    table.onRowKeydown(rowKeyEvent('ArrowDown'), 'b');

    expect(tabbableRows(table, ['a', 'b', 'c'])).toEqual(['c']);
    expect(table.rowTabIndex('hidden-1')).toBe(-1);
  });

  it('steps back over it going up', () => {
    const { table } = createKeyboardTable({
      coinIds: ['a', 'b', 'hidden-1', 'c'],
      renderedCoinIds: ['a', 'b', 'c']
    });

    table.onRowFocused('c');
    table.onRowKeydown(rowKeyEvent('ArrowUp'), 'c');

    expect(tabbableRows(table, ['a', 'b', 'c'])).toEqual(['b']);
  });

  it('clamps at the last VISIBLE row, not the last filtered one', () => {
    // Two more coins match inside a collapsed group below `c`.
    const { table } = createKeyboardTable({
      coinIds: ['a', 'b', 'c', 'hidden-1', 'hidden-2'],
      renderedCoinIds: ['a', 'b', 'c']
    });

    table.onRowFocused('c');
    table.onRowKeydown(rowKeyEvent('ArrowDown'), 'c');

    expect(tabbableRows(table, ['a', 'b', 'c'])).toEqual(['c']);
  });

  it('keeps exactly one tab stop when every group is collapsed', () => {
    const { table } = createKeyboardTable({
      coinIds: ['a', 'b', 'c'],
      renderedCoinIds: []
    });

    expect(tabbableRows(table, ['a', 'b', 'c'])).toEqual([]);
  });

  it('hands the tab stop to a visible row when the focused one is folded away', () => {
    // `b` was focused, then its group was collapsed.
    const { table } = createKeyboardTable({
      coinIds: ['a', 'b', 'c'],
      renderedCoinIds: ['a', 'c']
    });

    table.onRowFocused('b');

    expect(table.rowTabIndex('b')).toBe(-1);
    expect(tabbableRows(table, ['a', 'c'])).toEqual(['a']);
  });
});

/* The template with HTML comments stripped, so comment text cannot satisfy an assertion. */
const TEMPLATE = readFileSync(join(__dirname, 'inventory-table.html'), 'utf8')
  .replace(/<!--[\s\S]*?-->/g, '');

/** Enough of a CoinGroup for the heading to render and be dragged. */
function group(label: string, isEmptyBucket = false): CoinGroup {
  return { label, isEmptyBucket, coins: [], count: 0, heldValue: 0, summary: '0 coins · $0.00' };
}

interface DragTable {
  canDragGroup(group: CoinGroup): boolean;
  groupDraggable(group: CoinGroup): 'true' | null;
  isGroupDropTarget(group: CoinGroup): boolean;
  isGroupDropHighlight(group: CoinGroup): boolean;
  groupHeadingTitle(group: CoinGroup): string;
  onGroupDragStart(event: unknown, group: CoinGroup): void;
  onGroupDragOver(event: unknown, group: CoinGroup): void;
  onGroupDragLeave(group: CoinGroup): void;
  onGroupDrop(event: unknown, group: CoinGroup): void;
  endGroupDrag(): void;
  onGroupHeadingKeydown(event: unknown, group: CoinGroup): void;
}

/** The store calls the component makes, recorded. */
interface Recorded {
  drops: Array<[string, string]>;
  moves: Array<[string, number]>;
}

/** Builds the component with a recording `filters` stub for the drag handlers. */
function createDragTable(options: { canReorder?: boolean } = {}) {
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
          selectedCoinId: () => null,
          isDraftCoin: () => false,
          draftHint: () => ''
        }
      }
    ]
  });

  const table = runInInjectionContext(injector, () => new InventoryTable());
  const recorded: Recorded = { drops: [], moves: [] };

  (table as unknown as Record<string, unknown>)['filters'] = () => ({
    filteredInventory: () => [],
    renderedInventory: () => [],
    canReorderGroups: () => options.canReorder !== false,
    dropGroupOn: (dragged: string, target: string) => {
      recorded.drops.push([dragged, target]);
      return true;
    },
    moveGroup: (label: string, delta: number) => {
      recorded.moves.push([label, delta]);
      return true;
    }
  });

  return { table: table as unknown as DragTable, recorded };
}

/** A drag event with only the parts the handlers touch. */
function dragEvent() {
  return {
    preventDefault: vi.fn(),
    dataTransfer: { effectAllowed: '', dropEffect: '', setData: vi.fn() }
  };
}

/** Key event on a group heading; the second argument holds modifier flags. */
function groupKeyEvent(key: string, modifiers: Record<string, boolean> = {}) {
  return { key, preventDefault: vi.fn(), ...modifiers };
}

const MEXICO = group('Mexico');
const FRANCE = group('France');
const EMPTY_BUCKET = group('(No Country)', true);

/* --- group headings --- */
describe('the heading is a drag source — with the platform, not a library', () => {
  it('adds no drag-and-drop dependency to do it', () => {
    // Native HTML5 drag and drop keeps @angular/cdk out of the bundle.
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, '../../../../package.json'), 'utf8')
    ) as { dependencies?: Record<string, string> };
    const names = Object.keys(packageJson.dependencies ?? {}).join(' ');

    expect(names).not.toMatch(/drag|dnd|sortable/i);
    expect(names).not.toContain('@angular/cdk');
  });

  it('binds the native drag events on the heading button', () => {
    expect(TEMPLATE).toContain('(dragstart)="onGroupDragStart($event, group)"');
    expect(TEMPLATE).toContain('(dragover)="onGroupDragOver($event, group)"');
    expect(TEMPLATE).toContain('(dragleave)="onGroupDragLeave(group)"');
    expect(TEMPLATE).toContain('(drop)="onGroupDrop($event, group)"');
    expect(TEMPLATE).toContain('(dragend)="endGroupDrag()"');
    expect(TEMPLATE).toContain('[attr.draggable]="groupDraggable(group)"');
  });

  it('still opens and closes the group on a plain click', () => {
    expect(TEMPLATE).toContain('(click)="filters().toggleGroupExpansion(group.label)"');
  });

  it('marks the heading so the keyboard move can put focus back on it', () => {
    expect(TEMPLATE).toContain('[attr.data-group-heading]="group.label"');
  });

  it('remembers what is being dragged, and tells the browser it is a move', () => {
    const { table } = createDragTable();
    const event = dragEvent();

    table.onGroupDragStart(event, MEXICO);

    expect(event.dataTransfer.effectAllowed).toBe('move');
    expect(event.dataTransfer.setData).toHaveBeenCalledWith('text/plain', 'Mexico');
    expect(table.isGroupDropTarget(FRANCE)).toBe(true);
  });

  it('calls preventDefault on dragover, without which the browser refuses every drop', () => {
    const { table } = createDragTable();
    table.onGroupDragStart(dragEvent(), MEXICO);

    const over = dragEvent();
    table.onGroupDragOver(over, FRANCE);

    expect(over.preventDefault).toHaveBeenCalled();
    expect(over.dataTransfer.dropEffect).toBe('move');
    expect(table.isGroupDropHighlight(FRANCE)).toBe(true);
  });

  it('reports the drop to the store and forgets the drag', () => {
    const { table, recorded } = createDragTable();
    table.onGroupDragStart(dragEvent(), MEXICO);
    table.onGroupDragOver(dragEvent(), FRANCE);

    table.onGroupDrop(dragEvent(), FRANCE);

    expect(recorded.drops).toEqual([['Mexico', 'France']]);
    expect(table.isGroupDropTarget(FRANCE)).toBe(false);
    expect(table.isGroupDropHighlight(FRANCE)).toBe(false);
  });

  it('forgets an abandoned drag, so no heading is left highlighted', () => {
    const { table } = createDragTable();
    table.onGroupDragStart(dragEvent(), MEXICO);
    table.onGroupDragOver(dragEvent(), FRANCE);

    table.endGroupDrag();

    expect(table.isGroupDropHighlight(FRANCE)).toBe(false);
  });

  it('clears the highlight when the pointer leaves', () => {
    const { table } = createDragTable();
    table.onGroupDragStart(dragEvent(), MEXICO);
    table.onGroupDragOver(dragEvent(), FRANCE);

    table.onGroupDragLeave(FRANCE);

    expect(table.isGroupDropHighlight(FRANCE)).toBe(false);
  });

  it('never highlights the heading being dragged as its own drop target', () => {
    const { table } = createDragTable();
    table.onGroupDragStart(dragEvent(), MEXICO);
    expect(table.isGroupDropTarget(MEXICO)).toBe(false);
  });

  it('offers no grip, and no drag, when there is only one group to move', () => {
    const { table } = createDragTable({ canReorder: false });
    expect(table.canDragGroup(MEXICO)).toBe(false);
    expect(table.groupDraggable(MEXICO)).toBeNull();
    expect(TEMPLATE).toContain('@if (canDragGroup(group)) {');
  });
});

describe('the empty bucket cannot be dragged out of last place', () => {
  it('carries no draggable attribute at all', () => {
    const { table } = createDragTable();
    expect(table.canDragGroup(EMPTY_BUCKET)).toBe(false);
    expect(table.groupDraggable(EMPTY_BUCKET)).toBeNull();
  });

  it('refuses to start a drag, rather than starting one the drop must ignore', () => {
    const { table } = createDragTable();
    const event = dragEvent();

    table.onGroupDragStart(event, EMPTY_BUCKET);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.dataTransfer.setData).not.toHaveBeenCalled();
    expect(table.isGroupDropTarget(FRANCE)).toBe(false);
  });

  it('is not a drop target either — so nothing can be parked below it', () => {
    const { table } = createDragTable();
    table.onGroupDragStart(dragEvent(), MEXICO);

    const over = dragEvent();
    table.onGroupDragOver(over, EMPTY_BUCKET);

    expect(over.preventDefault).not.toHaveBeenCalled();
    expect(table.isGroupDropTarget(EMPTY_BUCKET)).toBe(false);
    expect(table.isGroupDropHighlight(EMPTY_BUCKET)).toBe(false);
  });

  it('cannot be moved with the keyboard either', () => {
    const { table, recorded } = createDragTable();
    const event = groupKeyEvent('ArrowUp', { altKey: true });

    table.onGroupHeadingKeydown(event, EMPTY_BUCKET);

    expect(recorded.moves).toEqual([]);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('says why, rather than looking broken', () => {
    const { table } = createDragTable();
    expect(table.groupHeadingTitle(EMPTY_BUCKET)).toContain('always stays last');
  });
});

describe('a keyboard user can reorder too — Alt+Arrow on a focused heading', () => {
  it('moves up on Alt+ArrowUp and down on Alt+ArrowDown', () => {
    const { table, recorded } = createDragTable();

    table.onGroupHeadingKeydown(groupKeyEvent('ArrowUp', { altKey: true }), MEXICO);
    table.onGroupHeadingKeydown(groupKeyEvent('ArrowDown', { altKey: true }), MEXICO);

    expect(recorded.moves).toEqual([['Mexico', -1], ['Mexico', 1]]);
  });

  it('swallows the key, so the page does not scroll out from under the heading', () => {
    const { table } = createDragTable();
    const event = groupKeyEvent('ArrowDown', { altKey: true });

    table.onGroupHeadingKeydown(event, MEXICO);

    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('leaves Enter and Space to open the group, as they always did', () => {
    const { table, recorded } = createDragTable();

    for (const key of ['Enter', ' ']) {
      const event = groupKeyEvent(key);
      table.onGroupHeadingKeydown(event, MEXICO);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }

    expect(recorded.moves).toEqual([]);
  });

  it('leaves the bare arrows alone', () => {
    const { table, recorded } = createDragTable();
    table.onGroupHeadingKeydown(groupKeyEvent('ArrowUp'), MEXICO);
    expect(recorded.moves).toEqual([]);
  });

  it('is bound in the template, on the heading button', () => {
    expect(TEMPLATE).toContain('(keydown)="onGroupHeadingKeydown($event, group)"');
  });

  it('is DISCOVERABLE: announced on the heading and printed next to the Group by menu', () => {
    expect(TEMPLATE).toContain('Alt+ArrowUp Alt+ArrowDown');
    expect(TEMPLATE).toContain('[title]="groupHeadingTitle(group)"');
    expect(TEMPLATE).toContain('to reorder');

    const { table } = createDragTable();
    expect(table.groupHeadingTitle(MEXICO)).toContain('Alt+Up / Alt+Down');
  });

  it('announces where the group landed, in a live region', () => {
    expect(TEMPLATE).toContain('aria-live="polite"');
    expect(TEMPLATE).toContain('filters().groupOrderAnnouncement()');
  });
});

describe('there is a way back to alphabetical', () => {
  it('offers a Reset control, and only while a custom order is in force', () => {
    expect(TEMPLATE).toContain('@if (filters().hasCustomGroupOrder()) {');
    expect(TEMPLATE).toContain('(click)="filters().resetGroupOrder()"');
    expect(TEMPLATE).toContain('Reset order');
  });

  it('names the column it is about to reset, because the order is per column', () => {
    expect(TEMPLATE).toContain("filters().groupColumnLabel()");
  });
});

/* --- template text --- */
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
    // `focus` does not bubble from the row's checkbox; `focusin` does.
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
    expect(TEMPLATE).not.toMatch(/>\s*Details\s*</);
    expect(TEMPLATE).not.toContain('detailRequested.emit(coin.id)');
  });

  it('took the row-click-only "coinSelected" output with it', () => {
    expect(TEMPLATE).not.toContain('coinSelected');
  });

  it('left the Images button behind, which does something different', () => {
    expect(TEMPLATE).toContain('imagesRequested.emit(coin.id)');
    expect(TEMPLATE).toContain("'Images' : 'Add images'");
  });
});

describe('controls that must not open the sidebar still stop the click', () => {
  it('the checkbox cell', () => {
    // Stops a checkbox click or the Images button from opening the panel.
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

describe('the grouped grid is still one @for over the same row markup', () => {
  // gridRows() keeps a single copy of the coin row markup.
  it('draws rows from gridRows(), not from the filtered list directly', () => {
    expect(TEMPLATE).toContain('@for (row of filters().gridRows(); track row.key)');
    expect(TEMPLATE).not.toContain('@for (coin of filters().filteredInventory()');
  });

  it('writes the coin row exactly once', () => {
    expect(TEMPLATE.match(/\(click\)="activateRow\(coin\.id\)"/g)).toHaveLength(1);
  });
});

describe('the group heading', () => {
  it('is a real button, so Tab reaches it and Enter opens it', () => {
    // A button is ignored by the row key handler.
    expect(TEMPLATE).toContain('class="group-toggle"');
    expect(TEMPLATE).toContain('(click)="filters().toggleGroupExpansion(group.label)"');
    expect(TEMPLATE).toContain('[attr.aria-expanded]="filters().isGroupOpen(group.label)"');
  });

  // Enter/Space on a heading must open the group, never a coin.
  it('carries nothing that could open a coin, so Enter there cannot show a detail', () => {
    const groupRow = /<tr class="group-row"[\s\S]*?<\/tr>/.exec(TEMPLATE)?.[0];
    expect(groupRow, 'group heading row not found').toBeTruthy();
    expect(groupRow).not.toContain('activateRow');
    expect(groupRow).not.toContain('detailRequested');
    expect(groupRow).not.toContain('tabindex');
    // Nothing on the <tr> itself.
    expect(groupRow).not.toMatch(/<tr[^>]*\(keydown\)/);
  });

  it('handles keys only on its button, and only to reorder', () => {
    // Exactly two key handlers: the row's and the heading's Alt+Arrow reorder.
    expect(TEMPLATE.match(/\(keydown\)/g) ?? []).toHaveLength(2);
    expect(TEMPLATE).toContain('(keydown)="onRowKeydown($event, coin.id)"');
    expect(TEMPLATE).toContain('(keydown)="onGroupHeadingKeydown($event, group)"');
  });

  it('carries the count and the money, so sixty groups can be read shut', () => {
    expect(TEMPLATE).toContain('{{ group.summary }}');
    expect(TEMPLATE).toContain('{{ group.label }}');
  });

  it('marks the no-value bucket so it cannot read as a real value', () => {
    expect(TEMPLATE).toContain('[class.group-row--empty-bucket]="group.isEmptyBucket"');
  });

  it('spans the whole grid, however many columns are switched on', () => {
    expect(TEMPLATE).toContain('[attr.colspan]="columns().visibleInventoryColumns().length + 3"');
  });

  it('adds no second tab stop of its own', () => {
    // Exactly one row in the tab order.
    expect(TEMPLATE).not.toContain('tabindex="0"');
  });
});

describe('the Group by control', () => {
  it('offers None plus the groupable columns, and nothing else', () => {
    expect(TEMPLATE).toContain('<option value="">None</option>');
    expect(TEMPLATE).toContain('@for (option of filters().groupingOptions; track option.column)');
  });

  it('shows one expand/collapse control, and only while grouped', () => {
    expect(TEMPLATE).toContain('@if (filters().isGrouped()) {');
    expect(TEMPLATE).toContain('(click)="filters().applyExpandAll()"');
    expect(TEMPLATE).toContain('{{ filters().expandAllControl().label }}');
    expect(TEMPLATE).not.toContain('>Collapse all<');
    expect(TEMPLATE).not.toContain('>Expand all<');
  });
});
