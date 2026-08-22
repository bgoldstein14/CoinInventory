import { Injectable } from '@angular/core';
import { SpotPrices } from '../types/coin.model';

export interface SpotPriceResult {
  prices: SpotPrices;
  source: string;
  timestamp: string;
  error?: string;
}

@Injectable({ providedIn: 'root' })
export class SpotPriceService {

  private readonly METALS_API = 'https://api.metals.live/v1/spot';

  async fetchSpotPrices(): Promise<SpotPriceResult> {
    try {
      const response = await fetch(this.METALS_API);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data: Array<Record<string, number>> = await response.json();

      const prices: SpotPrices = { gold: 0, silver: 0, platinum: 0, copper: 0 };

      for (const entry of data) {
        if (entry['gold'] !== undefined) prices.gold = entry['gold'];
        if (entry['silver'] !== undefined) prices.silver = entry['silver'];
        if (entry['platinum'] !== undefined) prices.platinum = entry['platinum'];
        if (entry['copper'] !== undefined) prices.copper = entry['copper'];
      }

      return {
        prices,
        source: 'COMEX via metals.live',
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      return {
        prices: { gold: 0, silver: 0, platinum: 0, copper: 0 },
        source: 'COMEX via metals.live',
        timestamp: new Date().toISOString(),
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }
}
