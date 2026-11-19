import { WritableSignal } from '@angular/core';
import {
  CoinRecord,
  Denomination,
  LatestSpotPrices,
  MintMarkOption,
  SpotPriceMeta,
  SpotPrices
} from '../../types/coin.model';
import { CatalogOption } from '../../types/catalog-reference';
import { ApiService, describeHttpError } from '../api.service';
import { LoggingService } from '../logging.service';
import { NotificationService } from '../notification.service';
import { CoinCollection } from './coin-collection';
import { hasAnySpotPrice } from './inventory-metrics';
import { describeLoadFailure, LoadFailure } from './load-failure';
import { firstValueFrom } from 'rxjs';

 /*
  * Start-up loading and the connection banner: `hydrate()`, `retryConnection()`
  * and the connecting / connected / connectionError signals. Sorts load failures
  * into fatal (no coins) and non-fatal (a lookup table missing; the app still works).
  */

/** Signals ConnectionManager writes: the same objects InventoryService exposes. */
export interface ConnectionTargets {
  connecting: WritableSignal<boolean>;
  connected: WritableSignal<boolean>;
  connectionError: WritableSignal<string | null>;
   /*
    * The same failure as `connectionError`, classified: stage ('connection' /
    * 'database' / 'delivery'), heading, short status label, whether the data is
    * known to be safe, and a technical line. `connectionError` stays as its message.
    * See load-failure.ts.
    */
  loadFailure: WritableSignal<LoadFailure | null>;
  categoryOptions: WritableSignal<string[]>;
  coinSets: WritableSignal<string[]>;
  denominations: WritableSignal<Denomination[]>;
  mintMarks: WritableSignal<MintMarkOption[]>;
  /** Reference catalogues (Sear, RIC, Hendin, Krause; migration 012). */
  catalogs: WritableSignal<CatalogOption[]>;
  metalContents: WritableSignal<string[]>;
  /**
   * Spot prices loaded from the database at start-up so melt values survive a
   * restart; left at zero defaults when none are saved or the lookup fails.
   */
  spotPrices: WritableSignal<SpotPrices>;
  /** Provenance of the saved prices. */
  spotPriceMeta: WritableSignal<SpotPriceMeta>;
  /** Installs the loaded coins and re-baselines change tracking. */
  coins: CoinCollection;
  apiService: ApiService;
  logger: LoggingService;
  notificationService: NotificationService;
}

export class ConnectionManager {
  constructor(private readonly target: ConnectionTargets) {}

  /**
   * Loads everything from the backend in two phases:
   *   1. Coins. Failure means no connection: mark disconnected and throw.
   *   2. The lookups (categories, coin sets, denominations, mint marks, metal
   *      contents, spot prices, catalogues), via `Promise.allSettled`, so each
   *      can fail on its own with only a warning.
   *
   * @throws Error only when the coin fetch fails
   */
  async hydrate(): Promise<void> {
    const t = this.target;
    t.logger.info('Starting inventory hydration');
    t.connecting.set(true);

    // Phase 1: coins (fatal on failure)
    let coins: CoinRecord[];
    try {
      coins = await firstValueFrom(t.apiService.getCoins());
    } catch (error) {
       /*
        * Not necessarily a connection failure: the database may have returned every
        * coin while the server failed to serialise the response. describeLoadFailure()
        * words the message by the stage the server reports (for a delivery failure:
        * the data is safe) and never upgrades "unknown" to "the database is down".
        */
      const failure = describeLoadFailure(error);
      const msg = describeHttpError(error);

       // The log line names the stage too.
      t.logger.error(`Coin list load failed (${failure.stage}): ${failure.title}`, failure.detail ?? msg);
      t.connecting.set(false);
      t.connected.set(false);
      t.loadFailure.set(failure);
      // Kept in step with `loadFailure` for readers of the older signal.
      t.connectionError.set(failure.message);
      t.notificationService.showError(failure.message);
      throw new Error(`Coin list load failed (${failure.stage}): ${msg}`);
    }

    // Coins arrived, so the connection is healthy; nothing below may reset `connected`.
    t.logger.info(`Successfully loaded ${coins.length} coins from database`);
    t.connected.set(true);
    t.connectionError.set(null);
    // Cleared together with the string so the two signals never disagree.
    t.loadFailure.set(null);
    t.coins.replaceAll(coins);

    // Phase 2: lookup tables (non-fatal, independent)
    const loaded = await this.loadLookupTables();

    t.categoryOptions.set(resolveWithFallback(loaded.categories, coins, (c) => c.category));
    t.coinSets.set(resolveWithFallback(loaded.coinSets, coins, (c) => c.coinSet ?? ''));
    t.denominations.set(Array.isArray(loaded.denominations) ? loaded.denominations : []);
    t.mintMarks.set(Array.isArray(loaded.mintMarks) ? loaded.mintMarks : []);
    // An empty list is workable: the picker offers only "(none)" and references
    // can still be typed.
    t.catalogs.set(Array.isArray(loaded.catalogs) ? loaded.catalogs : []);
    t.metalContents.set(
      Array.isArray(loaded.metalContents) ? [...new Set(loaded.metalContents)].sort() : []
    );
    this.applySpotPrices(loaded.spotPrices, loaded.failedLookups.includes('spot prices'));

    t.connecting.set(false);

    if (loaded.failedLookups.length > 0) {
      t.logger.warn(`Hydration completed with ${loaded.failedLookups.length} failed lookup(s): ${loaded.failedLookups.join(', ')}`);
      t.notificationService.showWarning(
        `Connected, but some reference data could not be loaded: ${loaded.failedLookups.join(', ')}.`
      );
    } else {
      t.notificationService.showInfo('Connected to database');
    }

    t.logger.info('Database hydration complete');
  }

  /**
   * Tries connecting again without reloading the page. Swallows hydrate()'s error
   * (a click handler must not leave an unhandled rejection); the error is still
   * shown via `connectionError` and a toast.
   *
   * @returns true if now connected
   */
  async retryConnection(): Promise<boolean> {
    // Ignore double-clicks while an attempt is in flight.
    if (this.target.connecting()) return this.target.connected();

    this.target.logger.info('Manual connection retry requested');
    // Clear the old message so the banner shows "connecting".
    this.target.connectionError.set(null);
    this.target.loadFailure.set(null);

    try {
      await this.hydrate();
      return true;
    } catch {
      // hydrate() has already set connectionError and shown a toast.
      return false;
    }
  }

  /**
   * Installs spot prices read back from the database, so melt values work at
   * start-up from the last retrieved prices. When `latest` is null (empty table
   * or failed call) the in-memory prices are left alone. Never throws.
   *
   * @param latest the newest saved row, or null
   * @param lookupFailed true if the HTTP call failed (already logged and warned);
   *                     only suppresses a misleading "nothing saved yet" log
   */
  private applySpotPrices(latest: LatestSpotPrices | null, lookupFailed: boolean): void {
    const t = this.target;

    // `fetchedAt` is the reliable "is there a row?" test: an empty table returns
    // 200 with zeros and nulls.
    if (!latest || latest.fetchedAt === null) {
      if (!lookupFailed) {
        t.logger.info('No saved spot prices yet — melt values stay blank until prices are fetched');
      }
      return;
    }

    const prices: SpotPrices = {
      gold: toPrice(latest.gold),
      silver: toPrice(latest.silver),
      platinum: toPrice(latest.platinum),
      copper: toPrice(latest.copper)
    };

    // An all-zero row is the absence of data, not prices (metals don't trade at
    // zero), so it is ignored; older data may contain one. This applies to the row
    // as a whole: a zero for one metal just means no price for that metal.
    if (!hasAnySpotPrice(prices)) {
      t.logger.warn('Saved spot prices are all zero — ignoring them, since no metal trades at zero');
      return;
    }

    t.spotPrices.set(prices);
    // Also record these as the saved set, so closing the spot price modal doesn't
    // write a duplicate row (see InventoryService.commitSpotPrices()).
    t.spotPriceMeta.set({
      source: latest.source ?? null,
      fetchedAt: latest.fetchedAt,
      prices
    });

    t.logger.info(
      `Loaded saved spot prices (Au=$${prices.gold} Ag=$${prices.silver} Pt=$${prices.platinum} Cu=$${prices.copper})`
    );
  }

  /** Phase 2: fetches all lookups at once and unwraps each separately. Never throws. */
  private async loadLookupTables(): Promise<LoadedLookups> {
    const { apiService, logger } = this.target;

    // `allSettled` never rejects; each result is fulfilled or rejected on its own.
    const settled = await Promise.allSettled([
      firstValueFrom(apiService.getCategories()),
      firstValueFrom(apiService.getCoinSets()),
      firstValueFrom(apiService.getDenominations()),
      firstValueFrom(apiService.getMintMarks()),
      firstValueFrom(apiService.getMetalContents()),
      // Spot prices are non-fatal: without them melt cells just read "—".
      firstValueFrom(apiService.getLatestSpotPrices()),
      // Appended last: results are unwrapped by position, so inserting in the middle
      // would shift the other indexes.
      firstValueFrom(apiService.getCatalogs())
    ]);

    const failedLookups: string[] = [];

    /** Unwraps one settled result, logging and recording a failure. */
    const unwrap = <T>(result: PromiseSettledResult<T>, label: string, fallback: T): T => {
      if (result.status === 'fulfilled') return result.value;
      logger.warn(`Failed to load ${label}`, describeHttpError(result.reason));
      failedLookups.push(label);
      return fallback;
    };

    return {
      categories: unwrap(settled[0], 'categories', [] as string[]),
      coinSets: unwrap(settled[1], 'coin sets', [] as string[]),
      // Unwrapped by position: keep these indexes in step with the array above.
      denominations: unwrap(settled[2], 'denominations', [] as Denomination[]),
      mintMarks: unwrap(settled[3], 'mint marks', [] as MintMarkOption[]),
      metalContents: unwrap(settled[4], 'metal contents', [] as string[]),
      // null (not zeroed prices) means "told nothing"; applySpotPrices() keeps the defaults.
      spotPrices: unwrap(settled[5], 'spot prices', null as LatestSpotPrices | null),
      catalogs: unwrap(settled[6], 'catalogues', [] as CatalogOption[]),
      failedLookups
    };
  }
}

/**
 * Coerces a database price to a number (SQL DECIMALs may arrive as strings).
 * Non-finite values become 0, which computeMeltValue() treats as "no price".
 */
function toPrice(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Everything phase 2 loads, plus what didn't arrive. */
interface LoadedLookups {
  categories: string[];
  coinSets: string[];
  denominations: Denomination[];
  mintMarks: MintMarkOption[];
  metalContents: string[];
  /** Reference catalogues; an empty list is usable, not a failure. */
  catalogs: CatalogOption[];
  /** Newest saved prices, or null when the table is empty or the call failed. */
  spotPrices: LatestSpotPrices | null;
  /** Names of the lookups that failed, for the warning toast. */
  failedLookups: string[];
}

/**
 * Picks the list to show for a lookup the coins can also supply: the server's
 * list, or (if empty or missing) the values the coins use, so dropdowns aren't
 * empty when the table was never populated. De-duplicated and sorted.
 *
 * @param loaded what the server returned (may be empty or not an array)
 * @param coins the coins just loaded (fallback source)
 * @param readValue reads the relevant field from a coin
 */
function resolveWithFallback(
  loaded: string[],
  coins: CoinRecord[],
  readValue: (coin: CoinRecord) => string
): string[] {
  const fromInventory = [...new Set(coins.map(readValue).filter(Boolean))];
  const resolved = Array.isArray(loaded) && loaded.length > 0 ? loaded : fromInventory;
  return [...new Set(resolved)].sort();
}
