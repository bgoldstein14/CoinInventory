import { Component, inject, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InventoryFilterStore } from '../../features/inventory/inventory-filter.store';
import { InventoryService } from '../../services/inventory.service';

/**
 * Search box, category dropdown, toolbar buttons and the collapsible
 * advanced-filter panel. Controls write into the shared filter store; search
 * and category also emit so the shell can re-pick the selected coin.
 */
@Component({
  selector: 'app-inventory-filter-bar',
  imports: [FormsModule],
  templateUrl: './inventory-filter-bar.html',
  styleUrl: './inventory-filter-bar.scss'
})
export class InventoryFilterBar {
  private readonly inventoryService = inject(InventoryService);
  protected get inv() { return this.inventoryService; }

  /** Shared filter/sort state, owned by the App shell. */
  readonly filters = input.required<InventoryFilterStore>();

  readonly searchQueryChange = output<string>();
  readonly categoryFilterChange = output<string>();
  readonly manageCategoriesRequested = output<void>();
  readonly reportsRequested = output<void>();
  /** Opens the Statistics dialog (charts and totals over the whole collection). */
  readonly statisticsRequested = output<void>();
  readonly spotPricesRequested = output<void>();
}
