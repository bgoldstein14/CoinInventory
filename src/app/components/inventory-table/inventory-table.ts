import { Component, ElementRef, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { cacGreenBeanIconPath } from '../../features/inventory/coin-icons';
import { collectionZeroState } from '../../features/inventory/collection-zero-state';
import { CoinGroup } from '../../features/inventory/grid-grouping';
import {
  handleGridRowKey, nextFocusedIndex, rowTabIndex, tabbableRowId
} from '../../features/inventory/grid-keyboard';
import { handleGroupHeadingKey, isMovableGroup } from '../../features/inventory/group-order';
import { InventoryColumnsStore } from '../../features/inventory/inventory-columns.store';
import { InventoryFilterStore } from '../../features/inventory/inventory-filter.store';
import { InventorySelectionStore } from '../../features/inventory/inventory-selection.store';
import { ApiService } from '../../services/api.service';
import { coinHasPhotos, coinPhotoCount } from '../../services/coin-photos';
import { coinThumbnailRevisions } from '../../services/inventory/coin-thumbnail-revision';
import { DraftRowStatus, describeDraftRow } from '../../services/inventory/draft-row-status';
import { InventoryService } from '../../services/inventory.service';
import { CoinRecord } from '../../types/coin.model';
import {
  certBadgeLabel, formatInventoryCell, gradeBadgeClass
} from '../../types/inventory-columns';

/**
 * The main coin grid: header, column picker and table. Mostly presentation;
 * the filter, column and selection stores are owned by the App shell, and
 * application-level actions are emitted as outputs.
 */
@Component({
  selector: 'app-inventory-table',
  // FormsModule for the "Group by" <select>: a plain [value] binding is applied
  // before the @for creates the <option>s, so the control would reset to blank.
  imports: [FormsModule],
  templateUrl: './inventory-table.html',
  styleUrl: './inventory-table.scss'
})
export class InventoryTable {
  private readonly inventoryService = inject(InventoryService);
  protected get inv() { return this.inventoryService; }

  /** Only for `coinThumbnailUrl()` — this component makes no HTTP calls. */
  private readonly api = inject(ApiService);

  /**
   * Used to move real browser focus between rows and headings. Optional
   * because specs build this component from a bare injector.
   */
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef, { optional: true });

  readonly filters = input.required<InventoryFilterStore>();
  readonly columns = input.required<InventoryColumnsStore>();
  readonly selection = input.required<InventorySelectionStore>();

  /** A row was activated (click, Enter or Space); the shell opens its details. */
  readonly detailRequested = output<string>();

  /** The row's "Images" button was clicked. */
  readonly imagesRequested = output<string>();

  /**
   * Which empty-grid message to show: not loaded yet, load failed, no coins,
   * or nothing matches the filters. The decision lives in
   * collection-zero-state.ts so it can be unit-tested.
   */
  protected readonly zeroState = computed(() =>
    collectionZeroState(
      {
        loaded: this.inv.connected(),
        failed: this.inv.connectionError() !== null,
      },
      this.inv.inventory().length,
      this.filters().filteredInventory().length
    )
  );

  // --- Keyboard operation (rules live in features/inventory/grid-keyboard.ts) ---

  /**
   * The row the keyboard is on, separate from the selected coin so arrowing
   * through rows does not open each one. Null until the grid is touched.
   */
  private readonly focusedCoinId = signal<string | null>(null);

  /**
   * Ids of the rows actually on screen. Uses `renderedInventory()` so coins
   * inside collapsed groups are skipped by the arrow keys.
   */
  private readonly visibleCoinIds = computed(() =>
    this.filters().renderedInventory().map(coin => coin.id)
  );

  /** The single row carrying `tabindex="0"`. See grid-keyboard.tabbableRowId. */
  private readonly tabbableCoinId = computed(() =>
    tabbableRowId(this.visibleCoinIds(), this.focusedCoinId(), this.inv.selectedCoinId())
  );

  /** 0 for the tabbable row, -1 for the rest. */
  protected rowTabIndex(coinId: string): number {
    return rowTabIndex(this.tabbableCoinId() === coinId);
  }

  /**
   * Focus entered this row; the roving tabindex follows it. Bound to `focusin`
   * because `focus` does not bubble from the row's checkbox.
   */
  protected onRowFocused(coinId: string): void {
    this.focusedCoinId.set(coinId);
  }

  /** Open the row's details. Not a toggle: the panel's Close button closes it. */
  protected activateRow(coinId: string): void {
    this.focusedCoinId.set(coinId);
    this.detailRequested.emit(coinId);
  }

  /** Delegates the key to grid-keyboard, which ignores keys from inner controls. */
  protected onRowKeydown(event: KeyboardEvent, coinId: string): void {
    handleGridRowKey(event, {
      activate: () => this.activateRow(coinId),
      move: (delta) => this.moveRowFocus(coinId, delta)
    });
  }

  /** Move focus `delta` rows, clamped at the ends. Selection is unchanged. */
  private moveRowFocus(fromCoinId: string, delta: number): void {
    const ids = this.visibleCoinIds();
    const index = nextFocusedIndex(ids.indexOf(fromCoinId), delta, ids.length);
    if (index < 0) return;

    const targetId = ids[index];
    this.focusedCoinId.set(targetId);
    this.focusRowElement(targetId);
  }

  /**
   * Focus a row element. Matches the `data-coin-row` attribute rather than
   * building a selector, since imported ids may contain any characters.
   */
  private focusRowElement(coinId: string): void {
    const root = this.host?.nativeElement;
    if (!root || typeof root.querySelectorAll !== 'function') return;

    for (const element of Array.from(root.querySelectorAll('[data-coin-row]'))) {
      if (element.getAttribute('data-coin-row') !== coinId) continue;
      (element as HTMLElement).focus?.();
      return;
    }
  }

  // --- Group heading reordering (native HTML5 drag and drop; ordering rules
  //     live in features/inventory/group-order.ts) ---

  /** The heading being dragged, or null. */
  protected readonly draggedGroupLabel = signal<string | null>(null);

  /** The heading the pointer is over, so it can show where the drop lands. */
  protected readonly dropTargetGroupLabel = signal<string | null>(null);

  /**
   * Whether this heading can be moved. The empty bucket is pinned last, and a
   * lone movable group has nowhere to go.
   */
  protected canDragGroup(group: CoinGroup): boolean {
    return isMovableGroup(group) && this.filters().canReorderGroups();
  }

  /** `'true'`, or null to omit the attribute. */
  protected groupDraggable(group: CoinGroup): 'true' | null {
    return this.canDragGroup(group) ? 'true' : null;
  }

  /** Whether a drop here would do anything (not itself, not the empty bucket). */
  protected isGroupDropTarget(group: CoinGroup): boolean {
    const dragged = this.draggedGroupLabel();
    return dragged !== null && dragged !== group.label && isMovableGroup(group);
  }

  /** Highlight the heading the drop would land on. */
  protected isGroupDropHighlight(group: CoinGroup): boolean {
    return this.dropTargetGroupLabel() === group.label && this.isGroupDropTarget(group);
  }

  protected onGroupDragStart(event: DragEvent, group: CoinGroup): void {
    if (!this.canDragGroup(group)) {
      event.preventDefault?.();
      return;
    }

    this.draggedGroupLabel.set(group.label);
    const transfer = event.dataTransfer;
    if (!transfer) return;
    transfer.effectAllowed = 'move';
    // Firefox will not begin a drag at all unless some payload is set.
    transfer.setData?.('text/plain', group.label);
  }

  protected onGroupDragOver(event: DragEvent, group: CoinGroup): void {
    if (!this.isGroupDropTarget(group)) return;
    // Without preventDefault the browser refuses the drop.
    event.preventDefault?.();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this.dropTargetGroupLabel.set(group.label);
  }

  protected onGroupDragLeave(group: CoinGroup): void {
    if (this.dropTargetGroupLabel() === group.label) this.dropTargetGroupLabel.set(null);
  }

  protected onGroupDrop(event: DragEvent, group: CoinGroup): void {
    event.preventDefault?.();
    const dragged = this.draggedGroupLabel();
    this.endGroupDrag();
    if (dragged === null) return;
    // The model ignores drops on the empty bucket.
    this.filters().dropGroupOn(dragged, group.label);
  }

  /** Runs whether the drag was dropped or abandoned, so it clears the highlight. */
  protected endGroupDrag(): void {
    this.draggedGroupLabel.set(null);
    this.dropTargetGroupLabel.set(null);
  }

  /** Alt+Up / Alt+Down on a focused heading moves the group (keyboard equivalent of dragging). */
  protected onGroupHeadingKeydown(event: KeyboardEvent, group: CoinGroup): void {
    if (!this.canDragGroup(group)) return;

    handleGroupHeadingKey(event, {
      move: (delta) => {
        if (this.filters().moveGroup(group.label, delta)) this.refocusGroupHeading(group.label);
      }
    });
  }

  /** Heading tooltip describing what the heading can do. */
  protected groupHeadingTitle(group: CoinGroup): string {
    if (!this.canDragGroup(group)) {
      return group.isEmptyBucket
        ? 'Coins with no value for this column. This group always stays last.'
        : 'Click to open or close this group.';
    }
    return 'Click to open or close. Drag, or press Alt+Up / Alt+Down, to move this group.';
  }

  /**
   * Re-focus a heading after it moves. Angular moves the DOM node, which loses
   * focus in Chromium; deferred because the DOM is not updated yet.
   */
  private refocusGroupHeading(label: string): void {
    const root = this.host?.nativeElement;
    if (!root || typeof root.querySelectorAll !== 'function') return;

    setTimeout(() => {
      for (const element of Array.from(root.querySelectorAll('[data-group-heading]'))) {
        if (element.getAttribute('data-group-heading') !== label) continue;
        (element as HTMLElement).focus?.();
        return;
      }
    });
  }

  /**
   * Status text for an unsaved row (see draft-row-status.ts). `draftHint` is
   * read defensively because some specs use a minimal InventoryService stub.
   */
  protected draftStatus(coin: CoinRecord): DraftRowStatus {
    const hint = this.inv.draftHint;
    const lastAttempt = typeof hint === 'function' ? hint.call(this.inv, coin) : '';
    return describeDraftRow(coin, { lastAttempt });
  }

  // --- Constants and pure formatters the template calls ---
  protected readonly cacGreenBeanIconPath = cacGreenBeanIconPath;
  protected formatInventoryCell = formatInventoryCell;
  protected gradeBadgeClass = gradeBadgeClass;
  protected certBadgeLabel = certBadgeLabel;

  /* Photo column: the coin list carries only `imageCount`, and each thumbnail
   * is a separate lazily loaded, cacheable request (see
   * server/routes/coins/thumbnail.ts). */

  /**
   * Whether the coin has photos, without a request. Never reads
   * `coin.imagePaths.length` directly; list records have no imagePaths.
   */
  protected hasPhoto(coin: CoinRecord): boolean {
    return coinHasPhotos(coin);
  }

  /** How many photographs, by the same rule. */
  protected photoCount(coin: CoinRecord): number {
    return coinPhotoCount(coin);
  }

  /**
   * Whether to request a server thumbnail. Unsaved coins have no server copy,
   * so their thumbnail URL would only 404. `isDraftCoin` is read defensively
   * for minimal test stubs.
   */
  protected showsThumbnail(coin: CoinRecord): boolean {
    if (!this.hasPhoto(coin)) return false;
    const isDraft = this.inv.isDraftCoin;
    return typeof isDraft === 'function' ? !isDraft.call(this.inv, coin.id) : true;
  }

  /** Placeholder text for the 32x32 photo cell; one word so it fits. */
  protected thumbnailPlaceholder(coin: CoinRecord): string {
    return this.hasPhoto(coin) ? 'Unsaved' : 'No photo';
  }

  /**
   * Thumbnail URL (the server returns the first image). The revision changes
   * when images are saved, so the browser re-fetches instead of keeping a
   * failed or stale image.
   */
  protected thumbnailUrl(coin: CoinRecord): string {
    return this.api.coinThumbnailUrl(coin.id, coinThumbnailRevisions.revisionOf(coin.id));
  }
}
