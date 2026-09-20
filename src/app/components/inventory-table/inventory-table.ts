import { Component, inject, input, output } from '@angular/core';
import { cacGreenBeanIconPath } from '../../features/inventory/coin-icons';
import { InventoryColumnsStore } from '../../features/inventory/inventory-columns.store';
import { InventoryFilterStore } from '../../features/inventory/inventory-filter.store';
import { InventorySelectionStore } from '../../features/inventory/inventory-selection.store';
import { InventoryService } from '../../services/inventory.service';
import { CoinRecord } from '../../types/coin.model';
import {
  certBadgeLabel, formatInventoryCell, gradeBadgeClass
} from '../../types/inventory-columns';

/**
 * InventoryTable — the main grid of coins: its header (with the selection
 * badge and the Columns button), the column picker, and the table itself.
 *
 * WHY THIS FILE EXISTS
 * This is the heart of the screen and it is almost entirely presentation: read
 * the filtered/sorted list, read which columns are switched on, draw the rows.
 * Splitting it out lets the App shell stop knowing about `<td>`s.
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

  readonly filters = input.required<InventoryFilterStore>();
  readonly columns = input.required<InventoryColumnsStore>();
  readonly selection = input.required<InventorySelectionStore>();

  /** A row was clicked — make that coin the "current" one. */
  readonly coinSelected = output<string>();

  /** The row's "Details" button was clicked. */
  readonly detailRequested = output<string>();

  /** The row's "Images" button was clicked. */
  readonly imagesRequested = output<string>();

  // --- Constants and pure formatters the template calls ---
  protected readonly cacGreenBeanIconPath = cacGreenBeanIconPath;
  protected formatInventoryCell = formatInventoryCell;
  protected gradeBadgeClass = gradeBadgeClass;
  protected certBadgeLabel = certBadgeLabel;

  /** The thumbnail shown in the Photo column: a coin's first attached image. */
  protected primaryImage(coin: CoinRecord): string | null {
    return coin.imagePaths[0] ?? null;
  }
}
