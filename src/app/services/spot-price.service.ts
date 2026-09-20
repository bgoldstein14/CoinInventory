import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { SpotPriceResult } from '../types/coin.model';
import { ApiService } from './api.service';
import { LoggingService } from './logging.service';
import { NotificationService } from './notification.service';

// SpotPriceResult now lives in ../types/coin.model so that api.service.ts can
// use it without importing this file (which would create a circular import).
// Re-exported here so existing `import { SpotPriceResult } from
// './spot-price.service'` statements keep working.
export type { SpotPriceResult };

/**
 * SpotPriceService manages fetching current spot prices via the backend proxy.
 *
 * Instead of calling metals.live directly, this service delegates to the backend
 * API via ApiService, which handles the external API call and provides error handling.
 * This approach keeps sensitive API logic server-side and improves security.
 */
@Injectable({ providedIn: 'root' })
export class SpotPriceService {
  // Inject services using Angular's inject() function
  private apiService = inject(ApiService);
  private loggingService = inject(LoggingService);
  private notificationService = inject(NotificationService);

  /**
   * Fetch current spot prices via the backend proxy.
   *
   * This method:
   * - Calls the backend API to fetch spot prices (ApiService delegates to metals.live)
   * - Logs the request and response
   * - Shows user notifications for success, warnings, and errors
   * - Returns spot prices with error state if the call fails
   *
   * @returns Promise resolving to SpotPriceResult with prices and optional error
   */
  async fetchSpotPrices(): Promise<SpotPriceResult> {
    try {
      // Log the start of the fetch operation
      this.loggingService.info('Fetching spot prices via backend proxy...');

      // Call the backend API and convert Observable to Promise
      const result = await firstValueFrom(this.apiService.fetchSpotPrices());

      // Check if the backend returned an error result
      if (result.error) {
        this.notificationService.showWarning(`Spot price fetch: ${result.error}`);
        this.loggingService.warn(`Spot price fetch returned error: ${result.error}`);
      } else {
        // Success - show confirmation notification
        this.notificationService.showInfo('Spot prices updated successfully');
      }

      return result;
    } catch (err) {
      // Extract error message for logging and user display
      const msg = err instanceof Error ? err.message : 'Unknown error';

      // Log the error
      this.loggingService.error('Spot price fetch failed', msg);

      // Show error notification to user
      this.notificationService.showError(`COMEX price fetch failed: ${msg}`);

      // Return a result with zero prices and the error message
      return {
        prices: { gold: 0, silver: 0, platinum: 0, copper: 0 },
        source: 'COMEX via metals.live',
        timestamp: new Date().toISOString(),
        error: msg
      };
    }
  }
}
