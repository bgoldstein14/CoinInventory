import { Component, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DecimalPipe, DatePipe } from '@angular/common';
import { InventoryService } from '../../services/inventory.service';
import { SpotPriceService } from '../../services/spot-price.service';
import { SpotPrices } from '../../types/coin.model';

@Component({
  selector: 'app-spot-price-modal',
  standalone: true,
  imports: [FormsModule, DecimalPipe, DatePipe],
  templateUrl: './spot-price-modal.html',
  styleUrl: './spot-price-modal.scss',
})
export class SpotPriceModalComponent {
  private readonly inventoryService = inject(InventoryService);
  private readonly spotPriceService = inject(SpotPriceService);

  readonly closed = output<void>();

  protected readonly spotPriceSource = signal<string>('');
  protected readonly spotPriceTimestamp = signal<string>('');
  protected readonly spotPriceFetching = signal(false);
  protected readonly spotPriceError = signal<string>('');

  protected readonly Number = Number;

  protected get inv() {
    return this.inventoryService;
  }

  protected updateSpotPrice(metal: keyof SpotPrices, value: number): void {
    this.inv.updateSpotPrices({ ...this.inv.spotPrices(), [metal]: value });
  }

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
    this.spotPriceSource.set(result.source);
    this.spotPriceTimestamp.set(result.timestamp);
  }
}
