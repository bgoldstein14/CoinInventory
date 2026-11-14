/*
 * The inventory grid as the user operates it: the keyboard on the rows, and
 * the drag (and Alt+Arrow) on the group headings.
 *
 * FOLDED IN FROM, and replacing, two files that are now deleted:
 *   - inventory-table-keyboard.spec.ts     (rows, roving tabindex, markup)
 *   - inventory-table-group-order.spec.ts  (dragging a group heading)
 *
 * Each of their headers is carried below verbatim, as a banner above the
 * block it came from. Every test and every assertion is the original.
 *
 * TWO BUILDERS AND TWO EVENT FACTORIES, DELIBERATELY. The two files each had
 * a `createTable` and a `keyEvent` with different signatures and different
 * behaviour, so they are kept apart as `createKeyboardTable`/`createDragTable`
 * and `rowKeyEvent(key, tagName)`/`groupKeyEvent(key, modifiers)`.
 *
 * LAYOUT. Row behaviour first, then the one TEMPLATE constant, then the group
 * heading suites, then the keyboard file's template-text suites.
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

/* ===== header carried verbatim from inventory-table-keyboard.spec.ts ===== */
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
 * Builds the component and hands it the one input its keyboard code reads.
 *
 * The input is replaced with a plain function rather than driven through
 * TestBed: TestBed needs a DOM and there is none here. A signal input is an
 * ordinary configurable class field, so overwriting it is a seam, not a
 * trick — `this.filters()` is all the component ever does with it.
 */
function createKeyboardTable(options: {
  coinIds?: string[];
  /**
   * The rows actually ON SCREEN, when that differs from the filtered list —
   * i.e. when a grouping is active and some groups are collapsed. The
   * arrow keys walk this list and not the filtered one; see
   * `renderedInventory` in features/inventory/inventory-filter.store.ts.
   */
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

/** Was `keyEvent` in inventory-table-keyboard.spec.ts: second arg is a tagName. */
function rowKeyEvent(key: string, tagName = 'TR') {
  return { key, target: { tagName }, preventDefault: vi.fn() };
}

/* --- row behaviour, from inventory-table-keyboard.spec.ts --- */
describe('activating a row opens the Details panel', () => {
  it('reports the coin upwards when the row is clicked', () => {
    const { table, opened } = createKeyboardTable();
    table.activateRow('b');
    expect(opened.ids).toEqual(['b']);
  });

  it('does NOT toggle: activating the same row again keeps asking to open it', () => {
    // The row is not a button. Clicking the row you are reading must not
    // make the panel vanish; the shell's openCoinDetail is unconditional and
    // app.spec.ts pins that down from the other end.
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
    // Otherwise ticking a row for a bulk edit would throw the sidebar open
    // and the checkbox would never toggle.
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
    // Arrowing down a list to look for something must not open a detail
    // panel on every row it crosses.
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
    const bare = runInInjectionContext(injector, () => new InventoryTable()) as unknown as KeyboardTable;
    expect(() => bare.draftStatus({ id: 'a' } as CoinRecord)).not.toThrow();
  });
});

describe('the arrow keys at a collapsed group boundary', () => {
  // GROUPING INTERACTS WITH ARROW-KEY NAVIGATION, and this is the decision:
  // the arrows walk the rows ON SCREEN. A coin inside a collapsed group
  // passes every filter and is not rendered, so arrowing onto it would put
  // the tab stop on an element that does not exist — invisible focus, and
  // nothing to press to get out of it.

  it('steps over a collapsed group instead of into it', () => {
    // Grouped by Country: [France: a, b] open, [Germany: hidden-1, hidden-2]
    // collapsed, [Mexico: c] open. Down from `b` must land on `c`.
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
    // `c` is the bottom of the screen even though two more coins match the
    // filters inside a collapsed group below it.
    const { table } = createKeyboardTable({
      coinIds: ['a', 'b', 'c', 'hidden-1', 'hidden-2'],
      renderedCoinIds: ['a', 'b', 'c']
    });

    table.onRowFocused('c');
    table.onRowKeydown(rowKeyEvent('ArrowDown'), 'c');

    expect(tabbableRows(table, ['a', 'b', 'c'])).toEqual(['c']);
  });

  it('keeps exactly one tab stop when every group is collapsed', () => {
    // Nothing is rendered but headings. There is no row to tab to, and the
    // grid must not claim there is.
    const { table } = createKeyboardTable({
      coinIds: ['a', 'b', 'c'],
      renderedCoinIds: []
    });

    expect(tabbableRows(table, ['a', 'b', 'c'])).toEqual([]);
  });

  it('hands the tab stop to a visible row when the focused one is folded away', () => {
    // The user had `b` focused, then pressed Collapse all with `b` in a
    // group that shut. tabbableRowId falls through rather than leaving the
    // tab stop on a row nobody can see.
    const { table } = createKeyboardTable({
      coinIds: ['a', 'b', 'c'],
      renderedCoinIds: ['a', 'c']
    });

    table.onRowFocused('b');

    expect(table.rowTabIndex('b')).toBe(-1);
    expect(tabbableRows(table, ['a', 'c'])).toEqual(['a']);
  });
});

/* ==========================================================================
 * THE TEMPLATE, read once for the whole file, with its HTML comments
 * stripped. Both originals did this, for the same reason: several tests in
 * this project were historically satisfied by the comment explaining a rule
 * rather than by the markup implementing it. Everything below this point
 * that asserts on markup asserts on TEMPLATE.
 * ========================================================================== */
const TEMPLATE = readFileSync(join(__dirname, 'inventory-table.html'), 'utf8')
  .replace(/<!--[\s\S]*?-->/g, '');

/* ===== header carried verbatim from inventory-table-group-order.spec.ts ===== */
/*
 * Dragging a group heading into place, and doing it from the keyboard.
 *
 * "The grid groupings should be movable, so I could drag a grouping to the
 * top, or wherever I like."
 *
 * WHAT IS TESTED WHERE. Which heading ends up in which slot is a pure rule
 * and belongs to features/inventory/group-order.spec.ts; whether the saved
 * order survives the night belongs to inventory-ui-persistence.spec.ts. This
 * file covers the part in between that neither of them can see: the
 * component's handlers, and the BINDINGS, which exist only in the template.
 *
 * NO JSDOM, so the drag events are plain objects — which is exactly why the
 * handlers below hold no rules of their own. The template is asserted as
 * text, with its comments stripped first: several tests in this project have
 * historically been satisfied by the comment explaining a rule rather than by
 * the markup implementing it.
 */

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

/** Was `createTable` in inventory-table-group-order.spec.ts. */
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

/** Was `keyEvent` in inventory-table-group-order.spec.ts: second arg is a modifier bag. */
function groupKeyEvent(key: string, modifiers: Record<string, boolean> = {}) {
  return { key, preventDefault: vi.fn(), ...modifiers };
}

const MEXICO = group('Mexico');
const FRANCE = group('France');
const EMPTY_BUCKET = group('(No Country)', true);

/* --- group headings, from inventory-table-group-order.spec.ts --- */
describe('the heading is a drag source — with the platform, not a library', () => {
  it('adds no drag-and-drop dependency to do it', () => {
    /* THE BUNDLE IS THE REASON. The @defer work cut this app from 938 kB to
     * 563 kB days ago, and @angular/cdk's drag-drop entry point would hand a
     * slice of that back for one gesture on one list. The platform's own
     * drag events cost nothing and draw the drag image for free. */
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
    // The drag must not have cost the heading what it was for.
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
    // Firefox refuses to start a drag with no payload at all.
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
  /* It is pinned deliberately: "no value recorded" is not a value, and on an
   * imported collection it is routinely the biggest group there is, so one
   * careless drag to the top would bury every real heading under a screenful
   * of unattributed coins. */

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

    // No preventDefault means the browser never fires `drop` here at all.
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
    /* A gesture nobody can find is a gesture nobody has. The formal
     * statement is `aria-keyshortcuts`, which a screen reader reads out; the
     * tooltip and the toolbar hint are the same fact for everyone else. */
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

/* --- template text, from inventory-table-keyboard.spec.ts --- */
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

describe('the grouped grid is still one @for over the same row markup', () => {
  // The whole reason gridRows() exists. A second @for inside an @if would
  // mean two copies of the hundred-line coin row, and the day they stop
  // matching is the day grouping quietly loses a column.
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
    // Not a <tr> with a click handler: that needs a tabindex of its own,
    // and grid-keyboard.ts would then have to learn about headings. A
    // BUTTON is already excluded from the row key handler.
    expect(TEMPLATE).toContain('class="group-toggle"');
    expect(TEMPLATE).toContain('(click)="filters().toggleGroupExpansion(group.label)"');
    expect(TEMPLATE).toContain('[attr.aria-expanded]="filters().isGroupOpen(group.label)"');
  });

  /*
   * The owner asked for this explicitly: "Hitting space/enter on a grouping
   * row should just open it, not show a coin detail."
   *
   * It is already true, but only by construction — the keydown handler is
   * bound inside the coin-row block, so a heading never reaches it, and
   * grid-keyboard.ts separately declines anything whose target is a BUTTON.
   * Neither of those facts is visible from the heading markup, so a later
   * edit that moved the handler up to the <tr> (the obvious way to make a
   * whole row clickable) would break it with nothing going red.
   *
   * These assert the negative.
   */
  it('carries nothing that could open a coin, so Enter there cannot show a detail', () => {
    const groupRow = /<tr class="group-row"[\s\S]*?<\/tr>/.exec(TEMPLATE)?.[0];
    expect(groupRow, 'group heading row not found').toBeTruthy();
    expect(groupRow).not.toContain('activateRow');
    expect(groupRow).not.toContain('detailRequested');
    expect(groupRow).not.toContain('tabindex');
    // NOTHING ON THE <tr> ITSELF. Moving a key handler up to the row is the
    // obvious way to make a whole row operable and is exactly what would
    // break the owner's rule, so it is the thing asserted.
    expect(groupRow).not.toMatch(/<tr[^>]*\(keydown\)/);
  });

  it('handles keys only on its button, and only to reorder', () => {
    /* The heading gained ONE key handler when the groups became
     * re-orderable: Alt+Up / Alt+Down moves the group. It sits on the
     * <button>, it acts on nothing but Alt+Arrow, and it cannot open a coin
     * — Enter and Space fall straight through it to the click handler, which
     * is asserted in group-order.spec.ts and again in
     * inventory-table-group-order.spec.ts. A keyboard user has to be able to
     * reorder; what he must not be able to do is open a coin from a heading.
     *
     * The count still stands as the tripwire it always was: two handlers in
     * this grid, both named here, and a third means something new started
     * eating keys. */
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
    // The roving tabindex is still exactly one ROW. A hard-coded tabindex
    // anywhere in this template would break it.
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
    // Two buttons would mean one of them is always a no-op.
    expect(TEMPLATE).not.toContain('>Collapse all<');
    expect(TEMPLATE).not.toContain('>Expand all<');
  });
});
