import { Component, inject, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InventoryFilterStore } from '../../features/inventory/inventory-filter.store';
import { InventoryService } from '../../services/inventory.service';

/**
 * InventoryFilterBar — the search box, the category dropdown, the "Filters"
 * toggle and the collapsible advanced-filter panel underneath it.
 *
 * Filtering is a self-contained job: read the user's criteria, write them into
 * the shared filter store, and let the inventory table react.
 *
 * Most controls write straight into the shared `filters` store. The search box
 * and the category dropdown are the two exceptions: they also emit, because the
 * App shell wants to re-pick a sensible "selected coin" whenever the visible
 * list changes underneath it. The advanced filters deliberately do *not*.
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
  /**
   * The Statistics dialog — charts and totals over the WHOLE collection.
   *
   * Sits beside Reports rather than inside it because the two answer
   * different questions: Reports is a printable list of what is in the
   * collection, Statistics is what the collection adds up to.
   */
  readonly statisticsRequested = output<void>();
  readonly spotPricesRequested = output<void>();
}
