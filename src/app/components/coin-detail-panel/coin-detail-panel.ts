import {
  AfterViewInit, Component, ElementRef, OnChanges, computed, inject, input, output
} from '@angular/core';
import { CoinImagesStore } from '../../features/inventory/coin-images.store';
import {
  DraftRowStatus, describeDraftRow
} from '../../services/inventory/draft-row-status';
import { InventoryService } from '../../services/inventory.service';
import { CoinRecord } from '../../types/coin.model';
import { CoinEditorForm } from '../coin-editor-form/coin-editor-form';
import { firstEditableField } from './first-editable-field';

/**
 * Sidebar showing one coin: the Show images / Close / Delete buttons, the
 * draft note, and first-field focus. Editing happens in CoinEditorForm. Close
 * and delete are emitted so the App shell can also tidy up the gallery.
 */
@Component({
  selector: 'app-coin-detail-panel',
  imports: [CoinEditorForm],
  templateUrl: './coin-detail-panel.html',
  styleUrl: './coin-detail-panel.scss'
})
export class CoinDetailPanel implements AfterViewInit, OnChanges {
  private readonly inventoryService = inject(InventoryService);
  protected get inv() { return this.inventoryService; }

  /**
   * Host element, used to focus the first field after Add Coin. Optional because
   * app.spec.ts creates this component from a bare injector.
   */
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef, { optional: true });

  /** The coin being shown. The App shell only renders the panel when one exists. */
  readonly coin = input.required<CoinRecord>();

  /** Shared photo state, so the "Show images" button can open the gallery. */
  readonly images = input.required<CoinImagesStore>();

  /** Settings > "Show transactions section in details"; passed through to CoinEditorForm. */
  readonly showTransactions = input.required<boolean>();

  /**
   * Bumped by the shell each time Add Coin creates a row; a counter so repeated
   * presses each move focus. Zero means never requested. Opening a row does not
   * set it, so focus stays in the grid for arrow-key navigation.
   */
  readonly focusFirstFieldRequest = input(0);

  readonly closeRequested = output<void>();
  readonly deleteRequested = output<void>();

  /** The highest `focusFirstFieldRequest` that has actually moved the caret. */
  private lastFocusedRequest = 0;

  /*
   * ngOnChanges handles a request while the panel is already open;
   * ngAfterViewInit handles a newly created panel, where the form does not yet
   * exist during ngOnChanges. A request is only marked handled once a field is
   * actually focused.
   */
  ngAfterViewInit(): void { this.applyPendingFocus(); }
  ngOnChanges(): void { this.applyPendingFocus(); }

  private applyPendingFocus(): void {
    const request = this.focusFirstFieldRequest();
    if (request <= 0 || request === this.lastFocusedRequest) return;

    const root = this.host?.nativeElement;
    if (!root || typeof root.querySelectorAll !== 'function') return;

    const field = firstEditableField(
      Array.from(root.querySelectorAll<HTMLElement>('input, select, textarea'))
    );
    if (!field) return;

    this.lastFocusedRequest = request;
    field.focus?.();
  }

  /**
   * What a draft (unsaved) coin still needs, shown inline rather than as an
   * error toast. Null for saved coins. The inventory methods are checked
   * defensively because some specs use a minimal stub.
   */
  protected readonly draftStatus = computed<DraftRowStatus | null>(() => {
    const coin = this.coin();
    const isDraft = this.inv.isDraftCoin;
    if (typeof isDraft !== 'function' || !isDraft.call(this.inv, coin.id)) return null;

    const hint = this.inv.draftHint;
    const lastAttempt = typeof hint === 'function' ? hint.call(this.inv, coin) : '';
    return describeDraftRow(coin, { lastAttempt });
  });

}
