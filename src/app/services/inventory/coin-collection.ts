import { WritableSignal } from '@angular/core';
import { CoinRecord } from '../../types/coin.model';
import { ApiService, describeHttpError } from '../api.service';
import { LoggingService } from '../logging.service';
import { NotificationService } from '../notification.service';
import { CoinChangeTracker } from './coin-change-tracker';
import { CoinDraftRegistry } from './coin-draft-registry';
import { LookupManager } from './lookup-manager';
import { createBlankCoin, normalizeImportedCoins } from './coin-factory';
import { firstValueFrom } from 'rxjs';

 /*
  * Whole-coin operations and selection: addBlankCoin, addCoins, deleteCoin,
  * importInventoryData, selectCoin, ensureSelectedCoin, replaceAll. (Field edits
  * are in CoinEditor.) Each must keep four things in step: the on-screen list,
  * the selection, the change tracker's baseline and the database. The signals
  * belong to InventoryService.
  */

export class CoinCollection {
  constructor(
    private readonly inventory: WritableSignal<CoinRecord[]>,
    private readonly selectedCoinId: WritableSignal<string | null>,
    private readonly tracker: CoinChangeTracker,
    /** Which coins are still local-only drafts (see coin-draft-registry.ts). */
    private readonly drafts: CoinDraftRegistry,
    private readonly lookups: LookupManager,
    private readonly apiService: ApiService,
    private readonly logger: LoggingService,
    private readonly notificationService: NotificationService
  ) {}

  /* Selection */

  selectCoin(coinId: string): void {
    this.selectedCoinId.set(coinId);
  }

  /**
   * Keeps a sensible selection: none for an empty list, otherwise the first coin
   * when the previous selection is gone.
   */
  ensureSelectedCoin(): void {
    if (this.inventory().length === 0) { this.selectedCoinId.set(null); return; }
    const current = this.selectedCoinId();
    if (!current || !this.inventory().some(c => c.id === current)) {
      this.selectedCoinId.set(this.inventory()[0].id);
    }
  }

  /* Loading a fresh list */

  /** Replaces the list with coins from the server and re-baselines change tracking. */
  replaceAll(coins: CoinRecord[]): void {
    this.inventory.set(coins);
    this.tracker.reset(coins);
    // Everything now came from the server, so unfinished drafts are discarded.
    this.drafts.clearAll();
    this.ensureSelectedCoin();
  }

  /* Creating coins */

  /**
   * Adds an empty row and sends nothing to the server (a blank POST gets
   * `400 denomination is required`). The new coin is a local draft until it has
   * enough detail, then CoinEditor POSTs it (see coin-draft-registry.ts). The
   * change tracker isn't seeded: the server has confirmed nothing.
   */
  addBlankCoin(): CoinRecord {
    const coin = createBlankCoin();

    this.inventory.set([...this.inventory(), coin]);
    this.selectedCoinId.set(coin.id);
    this.drafts.markDraft(coin.id);

    this.logger.info(`Added draft coin ${coin.id} (not saved until it has 2 of year / type / denomination)`);

    return coin;
  }

  /**
   * Appends a batch of imported coins (Quicken/CSV/image) and saves them all.
   * Imports skip the draft path: the records are complete, already reviewed, and
   * (for QIF) already filtered by the same 2-of-3 rule. Each coin is POSTed
   * independently so one bad record doesn't stop the rest; one summary toast.
   */
  addCoins(coins: CoinRecord[]): void {
    this.inventory.set([...this.inventory(), ...coins]);
    // Each coin is POSTed in full, so what is sent becomes the confirmed baseline.
    for (const coin of coins) this.tracker.seedConfirmed(coin);
    this.ensureSelectedCoin();

    const importedCategories = coins.map(c => c.category).filter(Boolean);
    this.lookups.mergeCategoryOptions(importedCategories);

    const createPromises = coins.map(coin =>
      firstValueFrom(this.apiService.createCoin(coin))
        .then(() => ({ ok: true as const, coin }))
        .catch((error) => {
          this.logger.error(`Failed to create coin "${coin.coinType} ${coin.year}" (${coin.id}) in database`, describeHttpError(error));
          this.markFailedCreateUnsaved(coin.id, error);
          return { ok: false as const, coin, error };
        })
    );

    Promise.allSettled(createPromises).then((results) => {
      const outcomes = results.map(r => r.status === 'fulfilled' ? r.value : { ok: false as const, coin: null, error: r.reason });
      const succeeded = outcomes.filter(o => o.ok).length;
      const failed = outcomes.filter(o => !o.ok);

      if (failed.length === 0) {
        this.logger.info(`Successfully added ${succeeded} coins to database`);
        this.notificationService.showInfo(`Added ${succeeded} coins to database`);
      } else {
        const failedNames = failed.map(f => f.coin ? `${f.coin.coinType || '?'} ${f.coin.year || ''}`.trim() : 'unknown').join(', ');
        this.logger.error(`Failed to insert ${failed.length} of ${coins.length} coins: ${failedNames}`);
        if (succeeded > 0) {
          this.notificationService.showWarning(`Added ${succeeded} coins, but ${failed.length} failed to save to database`);
        } else {
          this.notificationService.showError(`Failed to save all ${failed.length} coins to database`);
        }
      }
    });
  }

  /**
   * Replaces the whole inventory from an exported JSON file. Unparseable input is
   * reported and ignored, never half-imported. Also skips the draft path: it
   * replaces everything (discarding unfinished drafts) and re-baselines tracking.
   */
  importInventoryData(json: string): void {
    try {
      const parsed = JSON.parse(json) as CoinRecord[];
      if (!Array.isArray(parsed) || parsed.length === 0) return;

      /* Like other imports, coins are linked to the denominations lookup (design
       * §4.1, §6); an id already in the backup is kept. If the lookup hasn't loaded,
       * nothing links but every coin still restores. */
      const normalized = normalizeImportedCoins(parsed, this.lookups.denominationList());

      this.inventory.set(normalized);
      this.tracker.reset(normalized);
      this.drafts.clearAll();
      this.ensureSelectedCoin();

      const importedCategories = normalized.map(c => c.category).filter(Boolean);
      this.lookups.mergeCategoryOptions(importedCategories);

      const createPromises = normalized.map(coin =>
        firstValueFrom(this.apiService.createCoin(coin))
          .catch((error) => {
            this.logger.error(`Failed to import coin ${coin.id} to database`, describeHttpError(error));
            this.markFailedCreateUnsaved(coin.id, error);
          })
      );
      Promise.all(createPromises)
        .then(() => {
          this.logger.info(`Imported ${normalized.length} coins to database`);
          this.notificationService.showInfo(`Imported ${normalized.length} coins to database`);
        })
        .catch((error) => {
          this.logger.error('Failed to import some coins to database', describeHttpError(error));
          this.notificationService.showError('Failed to import some coins to database');
        });
    } catch (e) {
      this.logger.error('Failed to parse import data', String(e));
      this.notificationService.showError('Failed to parse import data');
    }
  }

  /**
   * A bulk create was refused: stop the row looking saved. The bulk paths seed
   * the tracker with the record before POSTing; on failure that baseline is
   * dropped and the coin marked a draft. Otherwise every later edit would PUT to
   * a CoinId the database doesn't have (a PUT never creates) and its thumbnail
   * would 404. As a draft, the next qualifying edit POSTs it again. Rows the user
   * has already removed are ignored.
   */
  private markFailedCreateUnsaved(coinId: string, error: unknown): void {
    if (!this.inventory().some(c => c.id === coinId)) return;

    this.tracker.clear(coinId);
    this.drafts.recordCreateFailure(coinId, describeHttpError(error));
    this.drafts.markDraft(coinId);
  }

  /* Deleting coins */

  /**
   * Removes a coin from the list, the change tracker (so no queued write fires)
   * and the database.
   */
  deleteCoin(coinId: string): void {
    // Check first: an unsaved draft has no database row, so DELETE would 404.
    const wasUnsaved = this.drafts.isUnsaved(coinId);

    this.inventory.set(this.inventory().filter(c => c.id !== coinId));
    this.tracker.clear(coinId);
    this.drafts.clear(coinId);
    this.ensureSelectedCoin();

    if (wasUnsaved) {
      // Nothing to delete on the server. If a create is in flight, CoinEditor removes
      // the orphan when the POST lands.
      this.logger.info(`Discarded unsaved draft coin ${coinId}`);
      return;
    }

    firstValueFrom(this.apiService.deleteCoin(coinId))
      .then(() => this.logger.info(`Deleted coin ${coinId} from database`))
      .catch((error) => {
        this.logger.error(`Failed to delete coin ${coinId} from database`, describeHttpError(error));
        this.notificationService.showError(`Failed to delete coin from database — ${describeHttpError(error)}`);
      });
  }
}
