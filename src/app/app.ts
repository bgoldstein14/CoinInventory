import { Component, signal } from '@angular/core';
import { AppToolbar, ExportKind, ImportKind } from './components/app-toolbar/app-toolbar';
import { BulkEditBar } from './components/bulk-edit-bar/bulk-edit-bar';
import { CategoryModal } from './components/category-modal/category-modal';
import { CoinDetailPanel } from './components/coin-detail-panel/coin-detail-panel';
import { CoinImageGallery } from './components/coin-image-gallery/coin-image-gallery';
import { CoinPhotoViewer } from './components/coin-photo-viewer/coin-photo-viewer';
import { CsvImportModal } from './components/csv-import-modal/csv-import-modal';
import { ImageImportModal } from './components/image-import-modal/image-import-modal';
import { InventoryFilterBar } from './components/inventory-filter-bar/inventory-filter-bar';
import { InventoryTable } from './components/inventory-table/inventory-table';
import { NotificationToast } from './components/notification-toast/notification-toast';
import { QuickenImportModal } from './components/quicken-import-modal/quicken-import-modal';
import { ReportModal } from './components/report-modal/report-modal';
import { SettingsModal } from './components/settings-modal/settings-modal';
import { SpotPriceModalComponent } from './components/spot-price-modal/spot-price-modal';
import { AppSettings } from './features/app-settings';
import { confirmAction } from './features/confirm-action';
import { CoinImagesStore } from './features/inventory/coin-images.store';
import { InventoryColumnsStore } from './features/inventory/inventory-columns.store';
import { InventoryFileIo } from './features/inventory/inventory-file-io';
import { InventoryFilterStore } from './features/inventory/inventory-filter.store';
import { InventorySelectionStore } from './features/inventory/inventory-selection.store';
import { CsvService } from './services/csv.service';
import { InventoryService } from './services/inventory.service';
import { StorageKeys, StorageService } from './services/storage.service';
import { CoinRecord } from './types/coin.model';

/**
 * App — the application shell.
 *
 * WHAT LIVES HERE
 * Only the things that are genuinely about the page as a whole:
 *  - the database connection banner and the status bar
 *  - which panel/modal is currently open
 *  - importing and exporting whole files
 *  - start-up hydration, and keeping "the selected coin" sensible
 *
 * WHAT DOES NOT LIVE HERE
 * Everything that belongs to one region of the screen has its own component
 * under `components/`, and the state those regions share lives in the small
 * stores under `features/inventory/`:
 *
 *   filters   (InventoryFilterStore)    search, filters, sort order
 *   columns   (InventoryColumnsStore)   which table columns are visible
 *   selection (InventorySelectionStore) the tick-boxes and bulk actions
 *   images    (CoinImagesStore)         the photo gallery and full-screen viewer
 *   io        (InventoryFileIo)         importing/exporting the whole collection
 *
 * The shell creates one of each and passes them to the children that need
 * them. Creating them here (rather than registering them with Angular's
 * injector) keeps the ownership obvious: there is exactly one of each, and this
 * component owns it.
 */
@Component({
  selector: 'app-root',
  imports: [
    AppToolbar, BulkEditBar, CategoryModal, CoinDetailPanel, CoinImageGallery,
    CoinPhotoViewer, CsvImportModal, ImageImportModal, InventoryFilterBar,
    InventoryTable, NotificationToast, QuickenImportModal, ReportModal,
    SettingsModal, SpotPriceModalComponent
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  protected get inv() { return this.inventoryService; }

  // --- Shared state, owned here and handed to the child components ---
  protected readonly filters: InventoryFilterStore;
  protected readonly columns: InventoryColumnsStore;
  protected readonly selection: InventorySelectionStore;
  protected readonly images: CoinImagesStore;

  /** Import/export of the whole collection as a file. */
  protected readonly io: InventoryFileIo;

  // --- View state ---
  protected readonly showDetailPanel = signal(false);
  protected readonly showSettingsModal = signal(false);

  /** User preference (persisted): show the transaction history in the detail panel. */
  protected readonly showTransactionsInDetails = signal(false);

  // --- Modal visibility ---
  protected readonly showQuickenModal = signal(false);
  protected readonly showImageImportModal = signal(false);
  protected readonly showCategoryModal = signal(false);
  protected readonly showCsvImportModal = signal(false);
  protected readonly showReportModal = signal(false);
  protected readonly showSpotPriceModal = signal(false);

  /**
   * Resolves once start-up hydration has finished. Tests await this; nothing in
   * the UI does, because the template copes with an empty inventory.
   */
  protected readonly ready: Promise<void>;

  /**
   * Has the user (or the app) ever picked a coin? Until they have, the shell
   * auto-selects the first visible row so the screen is never empty.
   */
  private defaultSelectionInitialized = false;

  public get selectedCoin(): CoinRecord | null {
    return this.inv.selectedCoin();
  }

  constructor(
    private readonly storageService: StorageService,
    protected readonly inventoryService: InventoryService,
    csvService: CsvService
  ) {
    this.filters = new InventoryFilterStore(inventoryService);
    this.columns = new InventoryColumnsStore(storageService);
    this.selection = new InventorySelectionStore(inventoryService, this.filters);
    this.images = new CoinImagesStore(inventoryService);
    this.io = new InventoryFileIo(inventoryService, csvService);
    this.ready = this.hydrateFromStorage();
  }

  // ===================== Modal controls =====================

  protected openQuickenModal(): void { this.showQuickenModal.set(true); }
  protected closeQuickenModal(): void { this.showQuickenModal.set(false); }
  protected openImageImportModal(): void { this.showImageImportModal.set(true); }
  protected closeImageImportModal(): void { this.showImageImportModal.set(false); }
  protected openCategoryModal(): void { this.showCategoryModal.set(true); }
  protected closeCategoryModal(): void { this.showCategoryModal.set(false); }
  protected openCsvImportModal(): void { this.showCsvImportModal.set(true); }
  protected closeCsvImportModal(): void { this.showCsvImportModal.set(false); }
  protected openReportModal(): void { this.showReportModal.set(true); }
  protected closeReportModal(): void { this.showReportModal.set(false); }
  protected openSpotPriceModal(): void { this.showSpotPriceModal.set(true); }
  protected closeSpotPriceModal(): void { this.showSpotPriceModal.set(false); }
  protected openSettingsModal(): void { this.showSettingsModal.set(true); }
  protected closeSettingsModal(): void { this.showSettingsModal.set(false); }

  protected onQuickenImported(coins: CoinRecord[]): void {
    this.inv.addCoins(coins);
  }

  // ===================== Import & export =====================
  //
  // The toolbar reports which menu entry was picked; two of them open a modal
  // and the rest are plain file operations handled by `io`.

  protected handleImportSelection(kind: ImportKind): void {
    if (kind === 'qif') this.openQuickenModal();
    if (kind === 'csv') this.openCsvImportModal();
    if (kind === 'json') this.io.triggerJsonImport();
  }

  protected handleExportSelection(kind: ExportKind): void {
    if (kind === 'csv') this.io.exportCsv();
    if (kind === 'json') this.io.downloadInventoryJson();
    if (kind === 'insurance') this.io.exportInsuranceCsv();
  }

  // ===================== Selecting & editing coins =====================

  protected selectCoin(coinId: string): void {
    this.defaultSelectionInitialized = true;
    this.inv.selectCoin(coinId);
    this.images.closeImageGallery();
  }

  /** The "Details" button: opens the sidebar, or closes it if it was already showing this coin. */
  protected openCoinDetail(coinId: string): void {
    const alreadyOpen = this.showDetailPanel() && this.selectedCoin?.id === coinId;
    this.selectCoin(coinId);
    this.showDetailPanel.set(!alreadyOpen);
    if (alreadyOpen) {
      this.images.closeImageGallery();
    }
  }

  protected closeDetailPanel(): void {
    this.showDetailPanel.set(false);
    this.images.closeImageGallery();
  }

  /** The "Images" button on a table row: select that coin, then show its photos. */
  protected showCoinImages(coinId: string): void {
    this.selectCoin(coinId);
    this.images.openImageGallery();
  }

  protected addBlankCoin(): void {
    this.inv.addBlankCoin();
    this.images.closeImageGallery();
  }

  protected deleteSelectedCoin(): void {
    const coin = this.selectedCoin;
    if (!coin) return;

    const confirmed = confirmAction(`Delete ${coin.coinType || 'this coin'}${coin.year ? ` (${coin.year})` : ''}?`);

    if (!confirmed) return;
    this.showDetailPanel.set(false);
    this.images.closeImageGallery();
    this.inv.deleteCoin(coin.id);
  }

  // ===================== Search & filter coordination =====================
  //
  // The filter bar owns the controls, but changing the *visible* list can leave
  // the currently selected coin off-screen — so the shell re-picks one.

  protected onSearchQueryChange(value: string): void {
    this.filters.searchQuery.set(value);
    this.syncDefaultSelection();
  }

  protected onCategoryFilterChange(value: string): void {
    this.filters.categoryFilter.set(value);
    this.syncDefaultSelection();
  }

  // ===================== Start-up & connection =====================

  /**
   * Re-attempt the database connection after a failure, without reloading
   * the page. Bound to the "Retry connection" buttons in app.html.
   *
   * `InventoryService.retryConnection()` never throws — it reports success as
   * a boolean and updates the `connecting` / `connected` / `connectionError`
   * signals that the template is already watching.
   */
  protected async retryConnection(): Promise<void> {
    const connected = await this.inv.retryConnection();
    if (connected) {
      // Fresh coin list — make sure something sensible is selected again.
      this.defaultSelectionInitialized = false;
      this.syncDefaultSelection();
    }
  }

  private async hydrateFromStorage(): Promise<void> {
    try {
      await this.inv.hydrate();
    } catch {
      // Database connection failed — connectionError signal is already set,
      // UI will show the error state (including a "Retry connection" button).
      // App still loads with an empty inventory.
    }
    this.syncDefaultSelection();

    const storedSettings = await this.storageService.get<AppSettings>(StorageKeys.AppSettings);
    if (storedSettings) {
      this.showTransactionsInDetails.set(Boolean(storedSettings.showTransactionsInDetails));
    }

    await this.columns.restoreFromStorage();
  }

  /**
   * Keeps a sensible coin selected: the first visible one on first load, and a
   * replacement whenever the selected coin is filtered out of view.
   */
  private syncDefaultSelection(): void {
    const visible = this.filters.filteredInventory();
    if (visible.length === 0) return;

    const selectedId = this.inv.selectedCoinId();
    if (!this.defaultSelectionInitialized) {
      this.inv.selectCoin(visible[0].id);
      this.defaultSelectionInitialized = true;
      return;
    }

    if (!selectedId || !visible.some(coin => coin.id === selectedId)) {
      this.inv.selectCoin(visible[0].id);
    }
  }
}
