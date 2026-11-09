import { Component, computed, inject, input, output } from '@angular/core';
import { cacGreenBeanIconPath } from '../../features/inventory/coin-icons';
import { collectionZeroState } from '../../features/inventory/collection-zero-state';
import { InventoryColumnsStore } from '../../features/inventory/inventory-columns.store';
import { InventoryFilterStore } from '../../features/inventory/inventory-filter.store';
import { InventorySelectionStore } from '../../features/inventory/inventory-selection.store';
import { ApiService } from '../../services/api.service';
import { coinHasPhotos, coinPhotoCount } from '../../services/coin-photos';
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
  imports: [],
  templateUrl: './inventory-table.html',
  styleUrl: './inventory-table.scss'
})
export class InventoryTable {
  private readonly inventoryService = inject(InventoryService);
  protected get inv() { return this.inventoryService; }

  /** Only for `coinThumbnailUrl()` — this component makes no HTTP calls. */
  private readonly api = inject(ApiService);

  readonly filters = input.required<InventoryFilterStore>();
  readonly columns = input.required<InventoryColumnsStore>();
  readonly selection = input.required<InventorySelectionStore>();

  /** A row was clicked — make that coin the "current" one. */
  readonly coinSelected = output<string>();

  /** The row's "Details" button was clicked. */
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
   * Where the row's thumbnail comes from.
   *
   * The server serves the coin's FIRST image (lowest SortOrder) as binary
   * bytes. There is deliberately no separate "primary image" flag: array
   * position 0 IS SortOrder 0, which is what makes the gallery's "Set as
   * main" button work by simply re-ordering the array.
   *
   * No down-scaling happens anywhere: the stored copy is already downscaled
   * and CSS (`.row-thumb`) sizes it to the row.
   */
  protected thumbnailUrl(coin: CoinRecord): string {
    return this.api.coinThumbnailUrl(coin.id);
  }
}
