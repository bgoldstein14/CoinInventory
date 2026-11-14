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
 * InventoryTable — the main grid of coins: its header (with the selection
 * badge and the Columns button), the column picker, and the table itself.
 *
 * It is almost entirely presentation: read the filtered/sorted list, read
 * which columns are switched on, draw the rows.
 *
 * The three stores it receives are all owned by the App shell:
 *  - `filters`   — which coins to show and in what order
 *  - `columns`   — which columns are visible
 *  - `selection` — which rows are ticked for a bulk edit
 *
 * Anything that changes *application* state (opening the detail panel, opening
 * the image gallery) is reported upwards as an output rather than done here.
 */
@Component({
  selector: 'app-inventory-table',
  // FormsModule for the "Group by" <select> alone. `[ngModel]` rather than a
  // plain `[value]` binding because a bound `value` on a <select> is applied
  // before the @for has created its <option>s, so the browser finds nothing
  // to match and silently resets the control to blank — the saved grouping
  // would be in force with the menu claiming "None".
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
   * The component's own element, used for ONE thing: putting real browser
   * focus on the row an arrow key just moved to.
   *
   * `optional: true` because several specs build this component from a bare
   * `Injector.create` that provides only the services it names, and a grid
   * that cannot be constructed in a test is a grid with no tests.
   */
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef, { optional: true });

  readonly filters = input.required<InventoryFilterStore>();
  readonly columns = input.required<InventoryColumnsStore>();
  readonly selection = input.required<InventorySelectionStore>();

  /**
   * A row was ACTIVATED — clicked, or Enter/Space pressed on it. The shell
   * selects that coin and opens the Details panel.
   *
   * There used to be a second output for the plain click (`coinSelected`,
   * highlight only) and a per-row "Details" button for this one. Clicking a
   * row then did nothing a user could see, which is the complaint this
   * change answers: selection and "show me this coin" were two gestures
   * where the user only ever meant one.
   */
  readonly detailRequested = output<string>();

  /** The row's "Images" button was clicked. */
  readonly imagesRequested = output<string>();

  /**
   * THE EMPTY ROW — three situations, not one.
   *
   * An empty grid can mean "you own no coins", "nothing matches the filters",
   * or "we have not fetched them yet". `inv.inventory().length === 0` cannot
   * tell the first from the third, and getting that wrong invites a user with
   * a full collection to import it a second time.
   *
   * Two signals make the difference knowable:
   *
   *   connected()       set by ConnectionManager.hydrate() in phase 1, AFTER
   *                     the coin fetch comes back and before anything else.
   *                     It means exactly "the list has arrived".
   *   connectionError() non-null when that fetch failed outright.
   *
   * The CHOICE itself is in features/inventory/collection-zero-state.ts, a
   * pure module, because this suite runs under Node with no jsdom and a
   * decision taken inside a template cannot be tested at all. All this
   * computed does is read signals and hand them over.
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

  /* =====================================================================
   * KEYBOARD OPERATION OF THE GRID
   *
   * The per-row "Details" button used to be the only keyboard-operable way
   * into the detail panel: a <tr> with a (click) handler is not reachable by
   * keyboard at all. Deleting that button without this section would have
   * been a straight accessibility regression, so the two changes are one
   * change.
   *
   * The RULES live in features/inventory/grid-keyboard.ts, which is pure and
   * therefore testable under Node with no jsdom. What is left here is the
   * two things that genuinely need a browser: remembering which row holds
   * focus, and moving real focus onto another one.
   * ===================================================================== */

  /**
   * The row the keyboard is "on". Distinct from the SELECTED coin: arrowing
   * down a list to look for something must not open five detail panels on
   * the way, so moving focus and activating a row are separate steps.
   *
   * Null until the grid has been touched; `tabbableRowId` falls back to the
   * selected coin, and then to the first row, so there is always exactly one
   * row in the tab order.
   */
  private readonly focusedCoinId = signal<string | null>(null);

  /**
   * The ids currently on screen, in the order the user sees them.
   *
   * `renderedInventory()`, NOT `filteredInventory()`, and the difference is
   * the whole of what grouping does to the keyboard. A coin inside a
   * collapsed group passes every filter and is not on screen; arrowing onto
   * it would move the tab stop to an element that was never rendered and
   * leave the user with no visible focus and no way back.
   *
   * So Down from the last row of an open group lands on the first row of
   * the next OPEN group, stepping over every collapsed group in between,
   * and with no grouping at all this is byte-for-byte the old list. Group
   * headings are not in this sequence: they are buttons, reached with Tab.
   */
  private readonly visibleCoinIds = computed(() =>
    this.filters().renderedInventory().map(coin => coin.id)
  );

  /** The single row carrying `tabindex="0"`. See grid-keyboard.tabbableRowId. */
  private readonly tabbableCoinId = computed(() =>
    tabbableRowId(this.visibleCoinIds(), this.focusedCoinId(), this.inv.selectedCoinId())
  );

  /** 0 for the one tabbable row, -1 for the other 104. */
  protected rowTabIndex(coinId: string): number {
    return rowTabIndex(this.tabbableCoinId() === coinId);
  }

  /**
   * Focus arrived somewhere inside this row — by Tab, by a click, or by an
   * arrow key. The roving tabindex follows it, so Tab always leaves and
   * re-enters the grid at the row the user last used.
   *
   * Bound to `focusin` rather than `focus` because `focus` does not bubble:
   * clicking the row's checkbox has to count as being on that row.
   */
  protected onRowFocused(coinId: string): void {
    this.focusedCoinId.set(coinId);
  }

  /**
   * A row was activated — clicked, or Enter/Space pressed on it.
   *
   * NOT A TOGGLE. The per-row button it replaces closed the panel when it
   * was already showing that coin, which is right for a button and wrong for
   * a row: clicking the row you are reading should not make the information
   * vanish. The panel's own Close button is the way out, and clicking
   * another row moves the panel to it.
   */
  protected activateRow(coinId: string): void {
    this.focusedCoinId.set(coinId);
    this.detailRequested.emit(coinId);
  }

  /**
   * A key was pressed on a row. The model decides what it means — including
   * deciding that a key pressed inside the row's checkbox or Images button
   * means nothing to us at all, which is what keeps Space toggling the box.
   */
  protected onRowKeydown(event: KeyboardEvent, coinId: string): void {
    handleGridRowKey(event, {
      activate: () => this.activateRow(coinId),
      move: (delta) => this.moveRowFocus(coinId, delta)
    });
  }

  /**
   * Move focus `delta` rows from `fromCoinId`, clamping at the ends.
   *
   * Only focus moves. The selection, the detail panel and the gallery are
   * left exactly as they were: arrowing through a list is looking, not
   * choosing.
   */
  private moveRowFocus(fromCoinId: string, delta: number): void {
    const ids = this.visibleCoinIds();
    const index = nextFocusedIndex(ids.indexOf(fromCoinId), delta, ids.length);
    if (index < 0) return;

    const targetId = ids[index];
    this.focusedCoinId.set(targetId);
    this.focusRowElement(targetId);
  }

  /**
   * Put real browser focus on a row.
   *
   * The rows are matched on a `data-coin-row` attribute rather than built
   * into a selector string, because a coin id is only a UUID by convention —
   * an imported record can carry anything, and `CSS.escape` is not something
   * this file should have to depend on.
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

  /* =====================================================================
   * DRAGGING A GROUP HEADING INTO PLACE
   *
   * "The grid groupings should be movable, so I could drag a grouping to the
   * top, or wherever I like."
   *
   * THE PLATFORM'S OWN DRAG AND DROP, NOT A LIBRARY. The four handlers below
   * are the whole of it: `draggable` on the heading, `dragstart` to remember
   * what is moving, `dragover` with a `preventDefault()` (without which the
   * browser refuses every drop), and `drop`. @angular/cdk's drag-drop entry
   * point would be a new dependency pulled in for one gesture on one list,
   * days after the @defer work cut this bundle from 938 kB to 563 kB, and it
   * would hand a slice of that straight back. The browser also draws the drag
   * image for free, which is most of what a library is bought for.
   *
   * ITS ONE REAL COST IS TOUCH: HTML5 drag events do not fire for a finger.
   * This is a desktop application shipped as a setup.exe in a webview shell,
   * and the Alt+Arrow gesture below covers anyone the mouse does not.
   *
   * WHAT IS *NOT* HERE: which heading ends up where. That is
   * features/inventory/group-order.ts, through the store — a drag handler is
   * the one place in this app a test cannot reach, so it holds no rules.
   * ===================================================================== */

  /** The heading currently being dragged, or null. Drives the drop targets
   *  and the dimmed source row. */
  protected readonly draggedGroupLabel = signal<string | null>(null);

  /** The heading the pointer is over, so it can show where the drop lands. */
  protected readonly dropTargetGroupLabel = signal<string | null>(null);

  /**
   * May this heading be picked up?
   *
   * No for the empty bucket — it is pinned last deliberately, because on an
   * imported collection it is routinely the biggest group there is and at the
   * top it buries every real heading. And no when there is only one movable
   * group, because a grip handle on a heading with nowhere to go is a control
   * that lies. Both rules are the pure model's; this reads them.
   */
  protected canDragGroup(group: CoinGroup): boolean {
    return isMovableGroup(group) && this.filters().canReorderGroups();
  }

  /** `draggable="true"`, or no attribute at all. A literal `draggable="false"`
   *  on the empty bucket would be the same behaviour with an extra claim in
   *  the markup for a test to mistake for the real one. */
  protected groupDraggable(group: CoinGroup): 'true' | null {
    return this.canDragGroup(group) ? 'true' : null;
  }

  /** Would a drop on this heading mean anything? Not onto itself, not onto
   *  the pinned empty bucket. */
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
      // Refuse the drag outright rather than letting the browser start one
      // that `drop` will then have to ignore.
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
    // THE LOAD-BEARING preventDefault: without it the element is not a drop
    // target and the browser refuses the drop with no error anywhere.
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
    // A drop on the empty bucket is refused by the model, which leaves the
    // dragged group exactly where it was. Silently, and on purpose: the
    // bucket showed no drop highlight, so nothing was promised.
    this.filters().dropGroupOn(dragged, group.label);
  }

  /** Fires whether the drag was dropped or abandoned — the only reliable
   *  place to clear the highlight. */
  protected endGroupDrag(): void {
    this.draggedGroupLabel.set(null);
    this.dropTargetGroupLabel.set(null);
  }

  /**
   * ALT + ARROW UP / DOWN ON A FOCUSED HEADING — the keyboard's way to do
   * exactly what the mouse does.
   *
   * The grid is fully keyboard-operable (grid-keyboard.ts), and a reordering
   * only a mouse could reach would be the single thing in it a keyboard user
   * could not do. The heading is already a real <button>, so Tab arrives here
   * with no extra work; the gesture itself and why it is Alt+Arrow rather than
   * the bare arrows is argued in features/inventory/group-order.ts.
   */
  protected onGroupHeadingKeydown(event: KeyboardEvent, group: CoinGroup): void {
    if (!this.canDragGroup(group)) return;

    handleGroupHeadingKey(event, {
      move: (delta) => {
        if (this.filters().moveGroup(group.label, delta)) this.refocusGroupHeading(group.label);
      }
    });
  }

  /** What the heading says it can do, as a tooltip. The same sentence the
   *  `aria-keyshortcuts` attribute states formally, in words a mouse user
   *  also gets — this gesture is useless if nobody finds it. */
  protected groupHeadingTitle(group: CoinGroup): string {
    if (!this.canDragGroup(group)) {
      return group.isEmptyBucket
        ? 'Coins with no value for this column. This group always stays last.'
        : 'Click to open or close this group.';
    }
    return 'Click to open or close. Drag, or press Alt+Up / Alt+Down, to move this group.';
  }

  /**
   * Put focus back on the heading that just moved.
   *
   * Re-ordering the list makes Angular move the row's DOM nodes, and a moved
   * element loses focus in Chromium — which for a keyboard user means one
   * Alt+Down and the focus is gone from the grid entirely. The re-focus is
   * deferred because the DOM has not been updated yet at the moment the key
   * handler returns, and it is skipped entirely when there is no host element
   * (the specs build this component from a bare injector).
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

  /* =====================================================================
   * AN IN-PROGRESS COIN IS NOT AN ERROR
   *
   * A row still being typed is an expected state. Its whole message used to
   * live in a `title` tooltip on the "Unsaved" chip, which is a footnote:
   * it needs a mouse, a pause, and the guess that hovering would say
   * anything. The chip now carries a visible phrase as well, and the detail
   * panel says the same thing in prose.
   *
   * The wording comes from services/inventory/draft-row-status.ts, which is
   * pure and explains why the existing (shared) sentences were not changed.
   * ===================================================================== */

  /**
   * What this unsaved row should say about itself.
   *
   * `draftHint` is read defensively for the same reason `isDraftCoin` is —
   * several specs build this component against a minimal InventoryService
   * stub, and a missing method must not turn a grid row into a crash. It is
   * passed through as `lastAttempt`, and is only ever read for a row that
   * already satisfies every save rule; see DraftRowStatusOptions.
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

  /* THE PHOTO COLUMN
   *
   * Two hard constraints: `GET /api/coins` must not inline photographs (past
   * ~100 coins the response cannot be serialised at all — see
   * server/routes/coins/list-query.ts), and a grid of N coins must not become
   * N requests on load. Three things together satisfy both, and all three
   * matter:
   *
   *   - `hasPhoto()` answers from `imageCount`, which the list sends for free
   *     from a SQL COUNT(*). A coin with no photographs renders nothing and
   *     requests nothing.
   *   - the `<img>` is marked `loading="lazy"`, so the browser fetches only
   *     the rows near the viewport. The cost on load is one screenful.
   *   - each thumbnail is its own cached HTTP response, so scrolling back up
   *     costs a 304 with an empty body.
   *
   * A batched endpoint returning one image per coin is deliberately refused:
   * it rebuilds the oversized string this design exists to avoid. See
   * server/routes/coins/thumbnail.ts.
   */

  /**
   * Does this coin have any photographs? Answered with no request at all.
   *
   * Reads the loaded array when there is one — the user may have attached or
   * deleted photos since the page loaded — and `imageCount` otherwise. Never
   * `coin.imagePaths.length`, which throws on a coin straight from the list.
   */
  protected hasPhoto(coin: CoinRecord): boolean {
    return coinHasPhotos(coin);
  }

  /** How many photographs, by the same rule. */
  protected photoCount(coin: CoinRecord): number {
    return coinPhotoCount(coin);
  }

  /**
   * Should this row show a thumbnail SERVED BY THE SERVER?
   *
   * Two conditions, and the second one is a bug fix. `hasPhoto` answers "are
   * there photographs"; this answers "is there a database row they could be
   * fetched from". An unsaved coin's pictures exist only in this browser, so
   * `GET /api/coins/:id/thumbnail` for one can only ever 404 — which is
   * exactly the `No thumbnail available for coin 423f9821-...` the owner's
   * log recorded a minute after that coin's create was refused.
   *
   * `isDraftCoin` is read defensively: several existing specs build this
   * component against a minimal InventoryService stub, and a missing method
   * must not turn a thumbnail into a crash.
   */
  protected showsThumbnail(coin: CoinRecord): boolean {
    if (!this.hasPhoto(coin)) return false;
    const isDraft = this.inv.isDraftCoin;
    return typeof isDraft === 'function' ? !isDraft.call(this.inv, coin.id) : true;
  }

  /**
   * What the Photo cell says when there is no image to show.
   *
   * "No photo" would be a lie for an unsaved row the user has just attached a
   * picture to: the picture is real, it simply has nowhere to live yet.
   *
   * ONE WORD, deliberately. The cell is a fixed 32x32 box with 8px type
   * (`.row-thumb--placeholder`), so a phrase would spill out of it; and
   * "Unsaved" is the word the row's own chip already uses, so the two read
   * as the same fact rather than as two problems.
   */
  protected thumbnailPlaceholder(coin: CoinRecord): string {
    return this.hasPhoto(coin) ? 'Unsaved' : 'No photo';
  }

  /**
   * Where the row's thumbnail comes from.
   *
   * The server serves the coin's FIRST image (lowest SortOrder) as binary
   * bytes. There is deliberately no separate "primary image" flag: array
   * position 0 IS SortOrder 0, which is what makes the gallery's "Set as
   * main" button work by simply re-ordering the array.
   *
   * No down-scaling happens anywhere: the stored copy is already downscaled
   * and CSS (`.row-thumb`) sizes it to the row.
   *
   * THE REVISION IS NOT DECORATION. The URL used to depend on nothing but the
   * coin id, so a photograph added after the grid had already asked for (and
   * been refused) that URL never appeared: nothing changed the binding and
   * the browser does not retry a failed image on its own. Reading the
   * revision here makes this binding depend on the registry's signal, so the
   * row re-renders with a new URL the moment a save carrying images is
   * acknowledged. See services/inventory/coin-thumbnail-revision.ts.
   */
  protected thumbnailUrl(coin: CoinRecord): string {
    return this.api.coinThumbnailUrl(coin.id, coinThumbnailRevisions.revisionOf(coin.id));
  }
}
