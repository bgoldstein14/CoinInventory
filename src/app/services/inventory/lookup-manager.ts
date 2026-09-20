import { WritableSignal } from '@angular/core';
import { Denomination, MintMarkOption } from '../../types/coin.model';
import { ApiService, describeHttpError } from '../api.service';
import { LoggingService } from '../logging.service';
import { NotificationService } from '../notification.service';
import { firstValueFrom } from 'rxjs';

/* ===========================================================================
 * LookupManager
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   The four "reference lists" the inventory picks values from:
 *     * categories   (database-backed: added/removed on the server)
 *     * coin sets    (local only — see the note on addCoinSet)
 *     * denominations (database-backed lookup table)
 *     * mint marks   (database-backed lookup table)
 *
 * WHY IT IS ITS OWN FILE
 *   These four follow the same shape over and over — read the list, add an
 *   entry, remove an entry, log it, tell the user if it failed — and that
 *   repetition was drowning out the interesting coin logic in
 *   InventoryService. None of it touches coins at all.
 *
 * The signals themselves still live on InventoryService (they are part of its
 * public API); this class is handed the same signal objects and writes
 * through them, so there is only ever one list.
 * =========================================================================== */

export class LookupManager {
  constructor(
    private readonly categoryOptions: WritableSignal<string[]>,
    private readonly coinSets: WritableSignal<string[]>,
    private readonly denominations: WritableSignal<Denomination[]>,
    private readonly mintMarks: WritableSignal<MintMarkOption[]>,
    private readonly apiService: ApiService,
    private readonly logger: LoggingService,
    private readonly notificationService: NotificationService
  ) {}

  /* =========================================================================
   * Categories
   * ======================================================================= */

  /**
   * Add any category names we have not seen before, and persist the new ones.
   *
   * Called after an import, where coins routinely arrive carrying categories
   * that do not exist in the lookup list yet. Names already present are
   * skipped, so this is safe to call with the full list every time.
   */
  mergeCategoryOptions(names: string[]): void {
    const current = new Set(this.categoryOptions());
    const missing: string[] = [];

    for (const name of names) {
      const trimmed = name.trim();
      if (trimmed && !current.has(trimmed)) {
        current.add(trimmed);
        missing.push(trimmed);
      }
    }

    if (missing.length === 0) return;

    this.categoryOptions.set([...current].sort());

    for (const name of missing) {
      firstValueFrom(this.apiService.createCategory(name))
        .then(() => this.logger.info(`Persisted category to database: ${name}`))
        .catch((error) => {
          this.logger.error(`Failed to persist category "${name}" to database`, describeHttpError(error));
          this.notificationService.showError(`Failed to save category "${name}" to database`);
        });
    }
  }

  removeCategoryOption(category: string): void {
    const trimmed = category.trim();
    if (!trimmed) return;

    this.categoryOptions.set(this.categoryOptions().filter(o => o !== trimmed));

    firstValueFrom(this.apiService.deleteCategory(trimmed))
      .then(() => this.logger.info(`Deleted category from database: ${trimmed}`))
      .catch((error) => {
        this.logger.error(`Failed to delete category "${trimmed}" from database`, describeHttpError(error));
        this.notificationService.showError(`Failed to delete category "${trimmed}" from database`);
      });
  }

  /* =========================================================================
   * Coin sets
   * -------------------------------------------------------------------------
   * These two are local-only on purpose: a coin set exists because some coin
   * references it, so it is saved as part of the coin, not as its own row.
   * ======================================================================= */

  addCoinSet(name: string): void {
    const current = this.coinSets();
    if (!current.includes(name)) {
      this.coinSets.set([...current, name].sort());
    }
  }

  removeCoinSet(name: string): void {
    this.coinSets.set(this.coinSets().filter(s => s !== name));
  }

  /* =========================================================================
   * Denomination Management
   * ======================================================================= */

  async loadDenominations(): Promise<void> {
    try {
      const denominations = await firstValueFrom(this.apiService.getDenominations());
      this.denominations.set(denominations);
      this.logger.info(`Loaded ${denominations.length} denominations from database`);
    } catch (error) {
      this.logger.error('Failed to load denominations', describeHttpError(error));
      this.notificationService.showError('Failed to load denominations');
    }
  }

  async addDenomination(d: Partial<Denomination>): Promise<void> {
    try {
      const created = await firstValueFrom(this.apiService.createDenomination(d));
      this.denominations.set([...this.denominations(), created]);
      this.logger.info(`Created denomination: ${created.label}`);
      this.notificationService.showInfo(`Added denomination: ${created.label}`);
    } catch (error) {
      this.logger.error('Failed to create denomination', describeHttpError(error));
      this.notificationService.showError('Failed to create denomination');
    }
  }

  async removeDenomination(id: number): Promise<void> {
    try {
      await firstValueFrom(this.apiService.deleteDenomination(id));
      this.denominations.set(this.denominations().filter(d => d.denominationId !== id));
      this.logger.info(`Deleted denomination: ${id}`);
      this.notificationService.showInfo('Denomination removed');
    } catch (error) {
      this.logger.error('Failed to delete denomination', describeHttpError(error));
      this.notificationService.showError('Failed to delete denomination');
    }
  }

  /* =========================================================================
   * Mint Mark Management
   * ======================================================================= */

  async loadMintMarks(): Promise<void> {
    try {
      const mintMarks = await firstValueFrom(this.apiService.getMintMarks());
      this.mintMarks.set(mintMarks);
      this.logger.info(`Loaded ${mintMarks.length} mint marks from database`);
    } catch (error) {
      this.logger.error('Failed to load mint marks', describeHttpError(error));
      this.notificationService.showError('Failed to load mint marks');
    }
  }

  async addMintMark(m: Partial<MintMarkOption>): Promise<void> {
    try {
      const created = await firstValueFrom(this.apiService.createMintMark(m));
      this.mintMarks.set([...this.mintMarks(), created]);
      this.logger.info(`Created mint mark: ${created.label}`);
      this.notificationService.showInfo(`Added mint mark: ${created.label}`);
    } catch (error) {
      this.logger.error('Failed to create mint mark', describeHttpError(error));
      this.notificationService.showError('Failed to create mint mark');
    }
  }

  async removeMintMark(id: number): Promise<void> {
    try {
      await firstValueFrom(this.apiService.deleteMintMark(id));
      this.mintMarks.set(this.mintMarks().filter(m => m.mintMarkId !== id));
      this.logger.info(`Deleted mint mark: ${id}`);
      this.notificationService.showInfo('Mint mark removed');
    } catch (error) {
      this.logger.error('Failed to delete mint mark', describeHttpError(error));
      this.notificationService.showError('Failed to delete mint mark');
    }
  }
}
