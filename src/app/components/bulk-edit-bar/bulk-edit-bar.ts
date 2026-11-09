import { Component, input } from '@angular/core';
import { InventorySelectionStore } from '../../features/inventory/inventory-selection.store';

/**
 * BulkEditBar — the bar that slides in along the bottom of the screen once you
 * tick one or more rows in the inventory table.
 *
 * All of its behaviour lives in InventorySelectionStore; this component is
 * purely the markup.
 */
@Component({
  selector: 'app-bulk-edit-bar',
  imports: [],
  templateUrl: './bulk-edit-bar.html',
  styleUrl: './bulk-edit-bar.scss'
})
export class BulkEditBar {
  /** Shared multi-select state, owned by the App shell. */
  readonly selection = input.required<InventorySelectionStore>();
}
