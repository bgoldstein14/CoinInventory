import { Component, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { InventoryService } from '../../services/inventory.service';
import { SpotPriceService } from '../../services/spot-price.service';
import { SpotPrices } from '../../types/coin.model';

/** Provenance label recorded against hand-typed prices. */
const MANUAL_SOURCE = 'Manual entry';

/**
 * The Spot Prices dialog.
 *
 * `POST /api/spot-prices` inserts a new history row on every call, and the
 * inputs fire on every keystroke. So edits only update memory
 * (inv.updateSpotPrices); one row is written (inv.commitSpotPrices) after a
 * successful COMEX fetch, or on close if prices were edited by hand.
 */
@Component({
  selector: 'app-spot-price-modal',
  standalone: true,
  imports: [FormsModule, DatePipe],
  templateUrl: './spot-price-modal.html',
  styleUrl: './spot-price-modal.scss',
})
export class SpotPriceModalComponent {
  private readonly inventoryService = inject(InventoryService);
  private readonly spotPriceService = inject(SpotPriceService);

  readonly closed = output<void>();

  protected readonly spotPriceFetching = signal(false);
  protected readonly spotPriceError = signal<string>('');

  /** True once a price has been hand-edited, so closing writes one history row. Cleared by a fetch. */
  protected readonly manualEditsPending = signal(false);

  /** Source and save time of the current prices, including those loaded at start-up. */
  protected readonly savedSource = computed(() => this.inv.spotPriceMeta().source);
  protected readonly savedAt = computed(() => this.inv.spotPriceMeta().fetchedAt);

  /** True when no price is set, to explain why every melt value reads "—". */
  protected readonly noPricesYet = computed(() => !this.inv.hasSpotPrices());

  protected readonly Number = Number;

  protected get inv() {
    return this.inventoryService;
  }

  /** A price box changed. In memory only; saved on close. */
  protected updateSpotPrice(metal: keyof SpotPrices, value: number): void {
    // Empty, NaN or zero all mean "no price" (0, shown as "—"). One blank metal
    // does not block saving the others.
    const price = Number.isFinite(value) && value > 0 ? value : 0;
    this.inv.updateSpotPrices({ ...this.inv.spotPrices(), [metal]: price });
    this.manualEditsPending.set(true);
  }

  /**
   * Fetch live COMEX prices and save them. commitSpotPrices() turns save errors
   * into a warning, so fetched prices stay usable for the session.
   */
  protected async fetchSpotPrices(): Promise<void> {
    this.spotPriceFetching.set(true);
    this.spotPriceError.set('');
    const result = await this.spotPriceService.fetchSpotPrices();
    this.spotPriceFetching.set(false);

    if (result.error) {
      this.spotPriceError.set(result.error);
      return;
    }

    this.inv.updateSpotPrices(result.prices);

    // The fetch replaced any typed prices and is saved below.
    this.manualEditsPending.set(false);
    await this.inv.commitSpotPrices(result.source);
  }

  /** Every exit (×, Done, backdrop) calls this, saving hand-typed prices once. */
  protected async close(): Promise<void> {
    if (this.manualEditsPending()) {
      this.manualEditsPending.set(false);
      await this.inv.commitSpotPrices(MANUAL_SOURCE);
    }
    this.closed.emit();
  }
}
