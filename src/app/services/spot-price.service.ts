import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { SpotPriceResult } from '../types/coin.model';
import { ApiService } from './api.service';
import { LoggingService } from './logging.service';
import { NotificationService } from './notification.service';

// Defined in coin.model (avoids a circular import with api.service.ts);
// re-exported for existing importers.
export type { SpotPriceResult };

/**
 * Fetches current spot prices through the backend proxy, which calls the
 * market-data API server-side.
 */
@Injectable({ providedIn: 'root' })
export class SpotPriceService {
  private apiService = inject(ApiService);
  private loggingService = inject(LoggingService);
  private notificationService = inject(NotificationService);

  /**
   * Fetches spot prices, logging and notifying the user of the outcome.
   * On failure returns zero prices with the error message instead of throwing.
   */
  async fetchSpotPrices(): Promise<SpotPriceResult> {
    try {
      this.loggingService.info('Fetching spot prices via backend proxy...');

      const result = await firstValueFrom(this.apiService.fetchSpotPrices());

      if (result.error) {
        this.notificationService.showWarning(`Spot price fetch: ${result.error}`);
        this.loggingService.warn(`Spot price fetch returned error: ${result.error}`);
      } else {
        this.notificationService.showInfo('Spot prices updated successfully');
      }

      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';

      this.loggingService.error('Spot price fetch failed', msg);

      this.notificationService.showError(`COMEX price fetch failed: ${msg}`);

      return {
        prices: { gold: 0, silver: 0, platinum: 0, copper: 0 },
        source: 'COMEX/NYMEX futures',
        timestamp: new Date().toISOString(),
        error: msg
      };
    }
  }
}

