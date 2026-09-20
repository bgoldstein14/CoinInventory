import { WritableSignal } from '@angular/core';
import { CoinRecord } from '../../types/coin.model';
import { ApiService, describeHttpError } from '../api.service';
import { LoggingService } from '../logging.service';
import { NotificationService } from '../notification.service';
import { CoinChangeTracker } from './coin-change-tracker';
import { CoinDraftRegistry } from './coin-draft-registry';
import { LookupManager } from './lookup-manager';
import { TransactionManager } from './transaction-manager';
import { createBlankCoin, normalizeImportedCoins } from './coin-factory';
import { firstValueFrom } from 'rxjs';

/* ===========================================================================
 * CoinCollection
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   Whole-coin operations — the ones that add a coin to the list or take one
 *   away, and the selection that follows from them:
 *     addBlankCoin, addCoins, deleteCoin, importInventoryData,
 *     selectCoin, ensureSelectedCoin, replaceAll.
 *
 *   Field-level EDITS are not here; they live in CoinEditor, because they
 *   have completely different rules (optimistic paint, debounce, minimal
 *   diff) from "create this record" / "delete this record".
 *
 * WHY IT IS ITS OWN FILE
 *   Each of these operations has to keep four things in step — the on-screen
 *   list, the selected coin, the change tracker's baseline, and the database.
 *   Forgetting one of the four is the classic bug here, so they are grouped
 *   together where the pattern is visible.
 *
 * As with the other helpers, the signals belong to InventoryService; this
 * class is handed the same signal objects to read and write.
 * =========================================================================== */

export class CoinCollection {
  constructor(
    private readonly inventory: WritableSignal<CoinRecord[]>,
    private readonly selectedCoinId: WritableSignal<string | null>,
    private readonly transactions: TransactionManager,
    private readonly tracker: CoinChangeTracker,
    /** Which coins are still local-only drafts. See coin-draft-registry.ts. */
    private readonly drafts: CoinDraftRegistry,
    private readonly lookups: LookupManager,
    private readonly apiService: ApiService,
    private readonly logger: LoggingService,
    private readonly notificationService: NotificationService
  ) {}

  /* =========================================================================
   * Selection
   * ======================================================================= */

  selectCoin(coinId: string): void {
    this.selectedCoinId.set(coinId);
  }

  /**
   * Make sure something sensible is selected: nothing when the list is empty,
   * otherwise the first coin whenever the previous selection has gone away.
   */
  ensureSelectedCoin(): void {
    if (this.inventory().length === 0) { this.selectedCoinId.set(null); return; }
    const current = this.selectedCoinId();
    if (!current || !this.inventory().some(c => c.id === current)) {
      this.selectedCoinId.set(this.inventory()[0].id);
    }
  }

  /* =========================================================================
   * Loading a fresh list
   * ======================================================================= */

  /**
   * Replace the entire list with coins straight from the server and
   * re-baseline the change tracking against them (they are, by definition,
   * exactly what the server holds).
   */
  replaceAll(coins: CoinRecord[]): void {
    this.inventory.set(coins);
    this.tracker.reset(coins);
    // Everything on screen now came from the server, so nothing is a local
    // draft any more. (Any draft the user had not finished is discarded —
    // that is intentional; see coin-draft-registry.ts.)
    this.drafts.clearAll();
    this.ensureSelectedCoin();
  }

  /* =========================================================================
   * Creating coins
   * ======================================================================= */

  /**
   * Add an empty row for the user to fill in — and send NOTHING to the
   * server.
   *
   * THE BUG THIS FIXES
   * This used to POST the blank record immediately. The backend answered
   * `400 {"error":"denomination is required"}`, so clicking "Add coin"
   * produced a red error toast before the user had typed anything.
   *
   * A brand new coin is now a LOCAL DRAFT. It appears in the list and is
   * selected exactly as before, but it only reaches the database once it
   * carries enough detail to be a real coin (2 of Year / Coin Type /
   * Denomination). CoinEditor watches for that and POSTs it automatically —
   * see coin-draft-registry.ts for the whole state machine.
   *
   * Note what is deliberately absent: `tracker.seedConfirmed(coin)`. The
   * change tracker records what the SERVER has confirmed, and the server has
   * confirmed nothing here. Seeding it with a row of empty strings would
   * make the first real save diff against fiction.
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
   * Append a batch of coins (a Quicken/CSV/image import) and save them all.
   *
   * WHY IMPORTS BYPASS THE DRAFT MACHINERY
   * Drafts exist to protect a row the user is still typing into. An import
   * is the opposite: the records are complete when they arrive and the user
   * has already reviewed them on a preview screen. The QIF importer in
   * particular has ALREADY applied the identical 2-of-3 rule (both call
   * `coin-completeness.ts`) and diverted anything short of it to its own
   * "exceptions" list, so routing these through the draft path would just
   * re-ask a question that has been answered. Batch imports also want the
   * per-coin error reporting and single summary toast below, which the draft
   * path has no notion of.
   *
   * Every coin is POSTed independently so one bad record cannot stop the
   * rest, and the user gets a single summary toast at the end rather than one
   * per coin.
   */
  addCoins(coins: CoinRecord[]): void {
    this.inventory.set([...this.inventory(), ...coins]);
    // Each coin is POSTed in full, so the record we send is the baseline the
    // server will hold. Seed the confirmed snapshots from it.
    for (const coin of coins) this.tracker.seedConfirmed(coin);
    this.ensureSelectedCoin();

    const importedCategories = coins.map(c => c.category).filter(Boolean);
    this.lookups.mergeCategoryOptions(importedCategories);

    const createPromises = coins.map(coin =>
      firstValueFrom(this.apiService.createCoin(coin))
        .then(() => ({ ok: true as const, coin }))
        .catch((error) => {
          this.logger.error(`Failed to create coin "${coin.coinType} ${coin.year}" (${coin.id}) in database`, describeHttpError(error));
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
   * Replace the whole inventory with the contents of an exported JSON file.
   *
   * Anything unparseable is reported and ignored — we never leave the app
   * half-imported.
   *
   * WHY THIS ALSO BYPASSES THE DRAFT MACHINERY
   * This is a whole-collection restore from a file the app itself exported,
   * not a row being typed. It replaces everything and re-baselines the change
   * tracker in one shot, which is precisely the "nothing here is local any
   * more" situation drafts are the opposite of. Any unfinished draft the user
   * had on screen is discarded along with the rest of the old list.
   */
  importInventoryData(json: string): void {
    try {
      const parsed = JSON.parse(json) as CoinRecord[];
      if (!Array.isArray(parsed) || parsed.length === 0) return;

      const normalized = normalizeImportedCoins(parsed);

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

  /* =========================================================================
   * Deleting coins
   * ======================================================================= */

  /**
   * Remove a coin everywhere: from the list, from its transactions, from the
   * change tracker (so no queued write fires for a coin that no longer
   * exists), and finally from the database.
   */
  deleteCoin(coinId: string): void {
    // Ask BEFORE we forget anything: an unsaved draft has no row in the
    // database, so calling DELETE would 404 and pop a pointless error toast.
    const wasUnsaved = this.drafts.isUnsaved(coinId);

    this.inventory.set(this.inventory().filter(c => c.id !== coinId));
    this.transactions.removeForCoin(coinId);
    this.tracker.clear(coinId);
    this.drafts.clear(coinId);
    this.ensureSelectedCoin();

    if (wasUnsaved) {
      // Nothing to delete on the server. (If a create happened to be in
      // flight, CoinEditor notices the row has gone when the POST lands and
      // removes the orphan itself.)
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
