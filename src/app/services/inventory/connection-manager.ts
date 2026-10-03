import { WritableSignal } from '@angular/core';
import {
  CoinRecord,
  Denomination,
  LatestSpotPrices,
  MintMarkOption,
  SpotPriceMeta,
  SpotPrices,
  TransactionRecord
} from '../../types/coin.model';
import { ApiService, describeHttpError } from '../api.service';
import { LoggingService } from '../logging.service';
import { NotificationService } from '../notification.service';
import { CoinCollection } from './coin-collection';
import { hasAnySpotPrice } from './inventory-metrics';
import { firstValueFrom } from 'rxjs';

/* ===========================================================================
 * ConnectionManager
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   Start-up and the connection banner: `hydrate()` (load everything from the
 *   backend), `retryConnection()` (try again after a failure), and the three
 *   signals that tell the UI how that is going — connecting / connected /
 *   connectionError.
 *
 * WHY IT IS ITS OWN FILE
 *   Loading is the one place where "this failed" has to be sorted into FATAL
 *   (no coins — the app has no data) versus MERELY ANNOYING (a lookup table
 *   is missing — everything still works). That distinction was easy to break
 *   by accident when this code sat in the middle of the service, so it now
 *   lives on its own, told as one story from top to bottom.
 * =========================================================================== */

/**
 * Everything ConnectionManager writes into. These are the very same signal
 * objects InventoryService exposes publicly — they are passed in rather than
 * created here so there is only ever one copy of the state.
 */
export interface ConnectionTargets {
  connecting: WritableSignal<boolean>;
  connected: WritableSignal<boolean>;
  connectionError: WritableSignal<string | null>;
  categoryOptions: WritableSignal<string[]>;
  coinSets: WritableSignal<string[]>;
  transactions: WritableSignal<TransactionRecord[]>;
  denominations: WritableSignal<Denomination[]>;
  mintMarks: WritableSignal<MintMarkOption[]>;
  metalContents: WritableSignal<string[]>;
  /**
   * Spot prices, loaded back from the database at start-up so melt values
   * survive a restart. Left at their { 0, 0, 0, 0 } defaults when there is
   * nothing saved or the lookup fails — see applySpotPrices().
   */
  spotPrices: WritableSignal<SpotPrices>;
  /** Provenance of the saved prices, so the UI can show when they are from. */
  spotPriceMeta: WritableSignal<SpotPriceMeta>;
  /** Used to install the freshly loaded coins and re-baseline change tracking. */
  coins: CoinCollection;
  apiService: ApiService;
  logger: LoggingService;
  notificationService: NotificationService;
}

export class ConnectionManager {
  constructor(private readonly target: ConnectionTargets) {}

  /**
   * Load everything from the backend.
   *
   * Two-phase on purpose:
   *   Phase 1 — the coins. If this fails we genuinely have no connection, so
   *             we mark the app disconnected and throw.
   *   Phase 2 — the seven lookups (categories, coin sets, transactions,
   *             denominations, mint marks, metal contents, spot prices).
   *             These are "nice to have". Previously a single failing lookup made the
   *             whole hydration report failure and flipped `connected` back to
   *             false even though the coins had loaded perfectly. Now we use
   *             `Promise.allSettled` so each lookup succeeds or fails on its
   *             own, and a failure only produces a warning.
   *
   * @throws Error only when the coin fetch itself fails
   */
  async hydrate(): Promise<void> {
    const t = this.target;
    t.logger.info('Starting inventory hydration');
    t.connecting.set(true);

    // ---- Phase 1: coins (fatal if this fails) ----
    let coins: CoinRecord[];
    try {
      coins = await firstValueFrom(t.apiService.getCoins());
    } catch (error) {
      const msg = describeHttpError(error);
      t.logger.error('Failed to connect to database', msg);
      t.connecting.set(false);
      t.connected.set(false);
      t.connectionError.set(`Cannot connect to database: ${msg}`);
      t.notificationService.showError('Cannot connect to database — please check that the backend server is running. Use "Retry connection" once it is back up.');
      throw new Error(`Database connection failed: ${msg}`);
    }

    // Coins arrived, so the connection is healthy. Nothing below this line is
    // allowed to flip `connected` back to false.
    t.logger.info(`Successfully loaded ${coins.length} coins from database`);
    t.connected.set(true);
    t.connectionError.set(null);
    t.coins.replaceAll(coins);

    // ---- Phase 2: lookup tables (non-fatal, independent) ----
    const loaded = await this.loadLookupTables();

    t.categoryOptions.set(resolveWithFallback(loaded.categories, coins, (c) => c.category));
    t.coinSets.set(resolveWithFallback(loaded.coinSets, coins, (c) => c.coinSet ?? ''));
    if (Array.isArray(loaded.transactions)) t.transactions.set(loaded.transactions);
    t.denominations.set(Array.isArray(loaded.denominations) ? loaded.denominations : []);
    t.mintMarks.set(Array.isArray(loaded.mintMarks) ? loaded.mintMarks : []);
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
   * Try connecting again after a failure, without reloading the page.
   *
   * `hydrate()` throws on failure (so the App constructor can tell), but a
   * button click handler must never produce an unhandled promise rejection —
   * so this wrapper swallows the error and reports success as a boolean.
   * The error is still visible via the `connectionError` signal and a toast.
   *
   * @returns true if the app is now connected, false otherwise
   */
  async retryConnection(): Promise<boolean> {
    // Ignore double-clicks while a connection attempt is already in flight.
    if (this.target.connecting()) return this.target.connected();

    this.target.logger.info('Manual connection retry requested');
    // Clear the old message so the banner shows "connecting" rather than a
    // stale error while we try again.
    this.target.connectionError.set(null);

    try {
      await this.hydrate();
      return true;
    } catch {
      // hydrate() has already set connectionError and shown a toast.
      return false;
    }
  }

  /**
   * Install spot prices read back from the database.
   *
   * WHY THIS IS HERE AT ALL
   * Without it the app started every session with
   * { gold: 0, silver: 0, platinum: 0, copper: 0 }, so every melt value in the
   * grid read "—" until the user remembered to open Spot Prices and press
   * Fetch. The owner's requirement is that melt auto-calculates from whatever
   * the LAST RETRIEVED prices were — they do not have to be live, they just
   * have to still be there. That is exactly what this does.
   *
   * WHAT IT WILL NOT DO
   * It will not overwrite the defaults with nothing. `latest` is null when the
   * SpotPrices table is empty OR when the lookup failed, and in both cases the
   * existing in-memory prices are left completely alone. Nothing here can
   * throw, and nothing here can stop the app starting.
   *
   * @param latest - the newest saved row, or null (empty table / failed call)
   * @param lookupFailed - true if the HTTP call itself failed, in which case
   *                       loadLookupTables() has already logged and recorded
   *                       it and the user gets the usual warning toast; we
   *                       only avoid logging a misleading "nothing saved yet".
   */
  private applySpotPrices(latest: LatestSpotPrices | null, lookupFailed: boolean): void {
    const t = this.target;

    // `fetchedAt` is the reliable "is there a row?" test, not the numbers:
    // the route answers 200 with four zeros and two nulls for an empty table.
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

    // A ZERO IS NOT A PRICE. Gold, silver, platinum and copper do not trade at
    // zero, so an all-zero row is not data — it is the absence of data, and it
    // must be treated exactly as an empty table is. The save path refuses to
    // write such a row now, but one may already exist from before that guard
    // was added (a failed fetch used to be able to persist its zeroed result).
    // Adopting it would read permanently broken melt values back in on every
    // launch, so it is ignored and the defaults stand. Note this is about the
    // row as a WHOLE: a row with a real gold price and a zero platinum price
    // is perfectly good, and platinum simply has no price in it.
    if (!hasAnySpotPrice(prices)) {
      t.logger.warn('Saved spot prices are all zero — ignoring them, since no metal trades at zero');
      return;
    }

    t.spotPrices.set(prices);
    // Record these as the already-saved set too. That stops the very first
    // close of the spot price modal from writing a duplicate history row of
    // numbers we only just read back out of the database — see
    // InventoryService.commitSpotPrices().
    t.spotPriceMeta.set({
      source: latest.source ?? null,
      fetchedAt: latest.fetchedAt,
      prices
    });

    t.logger.info(
      `Loaded saved spot prices (Au=$${prices.gold} Ag=$${prices.silver} Pt=$${prices.platinum} Cu=$${prices.copper})`
    );
  }

  /**
   * Phase 2 in detail: fetch all seven lookups at once and unwrap each
   * result on its own, so one bad table cannot sink the others.
   *
   * This never throws.
   */
  private async loadLookupTables(): Promise<LoadedLookups> {
    const { apiService, logger } = this.target;

    // `Promise.allSettled` waits for every promise and NEVER rejects. Each
    // result is `{status:'fulfilled', value}` or `{status:'rejected', reason}`.
    const settled = await Promise.allSettled([
      firstValueFrom(apiService.getCategories()),
      firstValueFrom(apiService.getCoinSets()),
      firstValueFrom(apiService.getTransactions()),
      firstValueFrom(apiService.getDenominations()),
      firstValueFrom(apiService.getMintMarks()),
      firstValueFrom(apiService.getMetalContents()),
      // Spot prices belong in THIS phase, not phase 1. A coin collection with
      // no spot prices is perfectly usable (every melt cell just reads "—"),
      // so a dead price lookup must never stop the app from starting.
      // `allSettled` guarantees that: this entry can reject on its own and the
      // other six still arrive.
      firstValueFrom(apiService.getLatestSpotPrices())
    ]);

    const failedLookups: string[] = [];

    /** Unwrap one settled result, logging + recording a per-lookup failure. */
    const unwrap = <T>(result: PromiseSettledResult<T>, label: string, fallback: T): T => {
      if (result.status === 'fulfilled') return result.value;
      logger.warn(`Failed to load ${label}`, describeHttpError(result.reason));
      failedLookups.push(label);
      return fallback;
    };

    return {
      categories: unwrap(settled[0], 'categories', [] as string[]),
      coinSets: unwrap(settled[1], 'coin sets', [] as string[]),
      transactions: unwrap(settled[2], 'transactions', [] as TransactionRecord[]),
      denominations: unwrap(settled[3], 'denominations', [] as Denomination[]),
      mintMarks: unwrap(settled[4], 'mint marks', [] as MintMarkOption[]),
      metalContents: unwrap(settled[5], 'metal contents', [] as string[]),
      // Fallback is null, not a zeroed price set: null means "we were told
      // nothing", and applySpotPrices() reads that as "leave the defaults".
      spotPrices: unwrap(settled[6], 'spot prices', null as LatestSpotPrices | null),
      failedLookups
    };
  }
}

/**
 * Coerce one price out of a database row into a usable number.
 *
 * SQL Server DECIMAL columns can arrive as a number or, depending on
 * precision and driver settings, as a string. Anything that is not a finite
 * number becomes 0, which computeMeltValue() already treats as "no price for
 * this metal" and renders as "—" — the honest answer.
 */
function toPrice(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Everything phase 2 tries to load, plus a note of what did not arrive. */
interface LoadedLookups {
  categories: string[];
  coinSets: string[];
  transactions: TransactionRecord[];
  denominations: Denomination[];
  mintMarks: MintMarkOption[];
  metalContents: string[];
  /** Newest saved prices, or null when the table is empty or the call failed. */
  spotPrices: LatestSpotPrices | null;
  /** Friendly names of the lookups that failed, for the warning toast. */
  failedLookups: string[];
}

/**
 * Choose which list to show for a lookup that the coins can also supply.
 *
 * Prefer the server's list, but if it is empty or missing fall back to the
 * values the coins themselves are using — otherwise a user whose lookup table
 * never got populated would see an empty dropdown even though their coins
 * clearly have categories (or coin sets). Either way the result is
 * de-duplicated and sorted.
 *
 * @param loaded - what the server returned (may be empty, or not even an array)
 * @param coins - the coins just loaded, used as the fallback source
 * @param readValue - how to read the relevant field off a coin
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
