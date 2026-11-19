import { WritableSignal } from '@angular/core';
import { Denomination, MintMarkOption } from '../../types/coin.model';
import { CatalogOption } from '../../types/catalog-reference';
import { ApiService, describeHttpError } from '../api.service';
import { LoggingService } from '../logging.service';
import { NotificationService } from '../notification.service';
import { firstValueFrom } from 'rxjs';

 /*
  * The reference lists the inventory picks from: categories, coin sets,
  * denominations, mint marks (and catalogues), each read, added and removed both
  * locally and on the server. The signals belong to InventoryService; this
  * class writes through the same objects.
  */

export class LookupManager {
  constructor(
    private readonly categoryOptions: WritableSignal<string[]>,
    private readonly coinSets: WritableSignal<string[]>,
    private readonly denominations: WritableSignal<Denomination[]>,
    private readonly mintMarks: WritableSignal<MintMarkOption[]>,
    private readonly catalogs: WritableSignal<CatalogOption[]>,
    private readonly apiService: ApiService,
    private readonly logger: LoggingService,
    private readonly notificationService: NotificationService
  ) {}

  /* Categories */

  /**
   * Adds category names not seen before and persists the new ones. Called after
   * imports; existing names are skipped, so the full list can be passed.
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

  /*
   * Coin sets are stored in the CoinSets table (`/api/coin-sets`), and hydration
   * reads from it (falling back to the coins' values only if the call fails).
   * "Add set" can create an empty set, so both add and remove must persist, or a
   * new set would vanish on reload. Same pattern as categories: update the signal
   * immediately, persist in the background, report failures.
   */

  addCoinSet(name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;

    const current = this.coinSets();
    // Already present: also avoids a duplicate POST (a primary-key clash).
    if (current.includes(trimmed)) return;

    this.coinSets.set([...current, trimmed].sort());

    firstValueFrom(this.apiService.createCoinSet(trimmed))
      .then(() => this.logger.info(`Persisted coin set to database: ${trimmed}`))
      .catch((error) => {
        this.logger.error(`Failed to persist coin set "${trimmed}" to database`, describeHttpError(error));
        this.notificationService.showError(`Failed to save set "${trimmed}" to database`);
      });
  }

  removeCoinSet(name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;

    this.coinSets.set(this.coinSets().filter(s => s !== trimmed));

    firstValueFrom(this.apiService.deleteCoinSet(trimmed))
      .then(() => this.logger.info(`Deleted coin set from database: ${trimmed}`))
      .catch((error) => {
        this.logger.error(`Failed to delete coin set "${trimmed}" from database`, describeHttpError(error));
        this.notificationService.showError(`Failed to delete set "${trimmed}" from database`);
      });
  }

  /* Denominations */

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

  /**
   * The denominations lookup for readers (the signal is written only here); used
   * by `CoinCollection.importInventoryData` to resolve restored coins (design §4.1).
   * Returns the array itself, not a copy: the resolver index is cached by array
   * identity, and a copy would rebuild it per coin. It is never mutated; load, add
   * and remove all replace the array.
   */
  denominationList(): readonly Denomination[] {
    return this.denominations();
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

  /* Mint marks */

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

  /*
   * Catalogues (migration 012): same methods and error handling as denominations,
   * plus rename, so an abbreviation ("RIC") can be expanded without breaking the
   * coins that reference the row by id.
   */

  async loadCatalogs(): Promise<void> {
    try {
      const catalogs = await firstValueFrom(this.apiService.getCatalogs());
      this.catalogs.set(catalogs);
      this.logger.info(`Loaded ${catalogs.length} catalogues from database`);
    } catch (error) {
      this.logger.error('Failed to load catalogues', describeHttpError(error));
      this.notificationService.showError('Failed to load catalogues');
    }
  }

  async addCatalog(c: Partial<CatalogOption>): Promise<void> {
    try {
      const created = await firstValueFrom(this.apiService.createCatalog(c));
      this.catalogs.set([...this.catalogs(), created]);
      this.logger.info(`Created catalogue: ${created.name}`);
      this.notificationService.showInfo(`Added catalogue: ${created.name}`);
    } catch (error) {
      this.logger.error('Failed to create catalogue', describeHttpError(error));
      this.notificationService.showError('Failed to create catalogue');
    }
  }

  /**
   * Renames a catalogue in place, keeping its id, so every coin attributed to it is
   * relabelled (remove-and-re-add would orphan them).
   */
  async renameCatalog(id: number, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return;

    try {
      await firstValueFrom(this.apiService.updateCatalog(id, { name: trimmed }));
      this.catalogs.set(
        this.catalogs().map(c => (c.catalogId === id ? { ...c, name: trimmed } : c))
      );
      this.logger.info(`Renamed catalogue ${id} to ${trimmed}`);
    } catch (error) {
      this.logger.error('Failed to rename catalogue', describeHttpError(error));
      this.notificationService.showError('Failed to rename catalogue');
    }
  }

  async removeCatalog(id: number): Promise<void> {
    try {
      await firstValueFrom(this.apiService.deleteCatalog(id));
      // Kept as inactive: coins that use it still show its name.
      this.catalogs.set(this.catalogs().map(c => (c.catalogId === id ? { ...c, isActive: false } : c)));
      this.logger.info(`Deleted catalogue: ${id}`);
      this.notificationService.showInfo('Catalogue removed');
    } catch (error) {
      this.logger.error('Failed to delete catalogue', describeHttpError(error));
      this.notificationService.showError('Failed to delete catalogue');
    }
  }
}
