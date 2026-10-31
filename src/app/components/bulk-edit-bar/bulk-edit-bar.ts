import { Component, input } from '@angular/core';
import { InventorySelectionStore } from '../../features/inventory/inventory-selection.store';

/**
 * BulkEditBar — the bar that slides in along the bottom of the screen once you
 * tick one or more rows in the inventory table.
 *
 * WHY THIS FILE EXISTS
 * It is a small, visually distinct piece of UI that is physically nowhere near
 * the table it acts on. All of its behaviour already lives in
 * InventorySelectionStore, so this component is purely the markup.
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
