import { Component, computed, signal } from '@angular/core';
import { AppToolbar, ExportKind, ImportKind } from './components/app-toolbar/app-toolbar';
import { BulkEditBar } from './components/bulk-edit-bar/bulk-edit-bar';
import { CategoryModal } from './components/category-modal/category-modal';
import { DEFAULT_REFERENCE_SECTION } from './components/category-modal/reference-sections';
import { CoinDetailPanel } from './components/coin-detail-panel/coin-detail-panel';
import { CoinImageGallery } from './components/coin-image-gallery/coin-image-gallery';
import { CoinPhotoViewer } from './components/coin-photo-viewer/coin-photo-viewer';
import { CsvImportModal } from './components/csv-import-modal/csv-import-modal';
import { HelpModal } from './components/help-modal/help-modal';
import { ImageImportModal } from './components/image-import-modal/image-import-modal';
import { InventoryFilterBar } from './components/inventory-filter-bar/inventory-filter-bar';
import { InventoryTable } from './components/inventory-table/inventory-table';
import { NotificationToast } from './components/notification-toast/notification-toast';
import { QuickenImportModal } from './components/quicken-import-modal/quicken-import-modal';
import { ReportModal } from './components/report-modal/report-modal';
import { SettingsModal } from './components/settings-modal/settings-modal';
import { SpotPriceModalComponent } from './components/spot-price-modal/spot-price-modal';
import { StatisticsModal } from './components/statistics-modal/statistics-modal';
import { SupportModal } from './components/support-modal/support-modal';
import { AppSettings } from './features/app-settings';
import { confirmAction } from './features/confirm-action';
import { CoinImagesStore } from './features/inventory/coin-images.store';
import { InventoryColumnsStore } from './features/inventory/inventory-columns.store';
import { InventoryFileIo } from './features/inventory/inventory-file-io';
import { InventoryFilterStore } from './features/inventory/inventory-filter.store';
import { InventorySelectionStore } from './features/inventory/inventory-selection.store';
import { coinPhotoCount } from './services/coin-photos';
import {
  censusUnlinkedDenominations,
  describeUnlinkedCensus
} from './services/denominations/unlinked-denominations';
import { CsvService } from './services/csv.service';
import { InventoryService } from './services/inventory.service';
import { StorageKeys, StorageService } from './services/storage.service';
import { CoinRecord } from './types/coin.model';
import { APP_VERSION } from './version';

/**
 * Application shell: connection banner, status bar, which panel/modal is
 * open, whole-file import/export, start-up hydration and default selection.
 *
 * Shared state lives in the stores under `features/inventory/`. The shell
 * creates one of each (not via DI) and passes them to the child components.
 */
@Component({
  selector: 'app-root',
  imports: [
    AppToolbar, BulkEditBar, CategoryModal, CoinDetailPanel, CoinImageGallery,
    CoinPhotoViewer, CsvImportModal, HelpModal, ImageImportModal, InventoryFilterBar,
    InventoryTable, NotificationToast, QuickenImportModal, ReportModal,
    SettingsModal, SpotPriceModalComponent, StatisticsModal, SupportModal
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  protected get inv() { return this.inventoryService; }

  /** Shown under the title, and reported with every support bundle. */
  protected readonly appVersion = APP_VERSION;

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
  /** Which Import menu entry (Excel or CSV) opened the spreadsheet dialog. */
  protected readonly csvImportMode = signal<'excel' | 'csv'>('excel');
  protected readonly showReportModal = signal(false);
  protected readonly showSpotPriceModal = signal(false);
  protected readonly showStatisticsModal = signal(false);
  /** Help > "Report a problem" dialog. */
  protected readonly showSupportModal = signal(false);

  /** Help screen, opened from the toolbar's help icon. */
  protected readonly showHelpModal = signal(false);

  /*
   * Coins with no linked denomination. The fix lives in Reference Data, which
   * users rarely open, so the shell shows a banner when the count is non-zero.
   * Silent at zero, and until the denomination lookup has loaded.
   */
  protected readonly unlinkedCensus = computed(() =>
    censusUnlinkedDenominations(
      this.inv.inventory(),
      this.inv.denominations(),
      (coinId) => this.inv.isDraftCoin(coinId)
    )
  );

  protected readonly unlinkedCount = computed(() => this.unlinkedCensus().unlinkedCount);

  /** The banner's sentence, or '' when there is nothing to say. */
  protected readonly unlinkedPrompt = computed(() =>
    this.unlinkedCount() === 0 ? '' : describeUnlinkedCensus(this.unlinkedCensus())
  );

  /** Which Reference Data pane the dialog should open on. */
  protected readonly categoryModalSection = signal<string>(DEFAULT_REFERENCE_SECTION);

  /** The banner's button: straight to the pane that fixes them. */
  protected openUnlinkedCoins(): void {
    this.categoryModalSection.set('unlinked');
    this.showCategoryModal.set(true);
  }

  /**
   * Resolves once start-up hydration has finished. Tests await this; nothing in
   * the UI does, because the template copes with an empty inventory.
   */
  protected readonly ready: Promise<void>;

  /** False until a coin has been picked; until then the first visible row is auto-selected. */
  private defaultSelectionInitialized = false;

  public get selectedCoin(): CoinRecord | null {
    return this.inv.selectedCoin();
  }

  /**
   * Photo count for the template's viewer guard. `coin.imagePaths` is absent
   * until the coin's photos are fetched (the list endpoint omits them), so this
   * falls back to the list's `imageCount`.
   */
  protected photoCount(coin: CoinRecord): number {
    return coinPhotoCount(coin);
  }

  constructor(
    private readonly storageService: StorageService,
    protected readonly inventoryService: InventoryService,
    csvService: CsvService
  ) {
    this.filters = new InventoryFilterStore(inventoryService, storageService);
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
  protected openCategoryModal(): void {
    // Reset the pane, or "Manage categories" would keep opening the
    // unlinked-coins pane after the banner had been used.
    this.categoryModalSection.set(DEFAULT_REFERENCE_SECTION);
    this.showCategoryModal.set(true);
  }
  protected closeCategoryModal(): void { this.showCategoryModal.set(false); }
  protected openCsvImportModal(mode: 'excel' | 'csv' = 'excel'): void {
    this.csvImportMode.set(mode);
    this.showCsvImportModal.set(true);
  }
  protected closeCsvImportModal(): void { this.showCsvImportModal.set(false); }
  protected openReportModal(): void { this.showReportModal.set(true); }
  protected closeReportModal(): void { this.showReportModal.set(false); }
  protected openSpotPriceModal(): void { this.showSpotPriceModal.set(true); }
  protected closeSpotPriceModal(): void { this.showSpotPriceModal.set(false); }
  protected openStatisticsModal(): void { this.showStatisticsModal.set(true); }
  protected closeStatisticsModal(): void { this.showStatisticsModal.set(false); }
  protected openSupportModal(): void { this.showSupportModal.set(true); }
  protected closeSupportModal(): void { this.showSupportModal.set(false); }
  protected openHelpModal(): void { this.showHelpModal.set(true); }
  protected closeHelpModal(): void { this.showHelpModal.set(false); }

  /** Help > "Report a problem": closes Help first so the two dialogs never stack. */
  protected openSupportModalFromHelp(): void {
    this.showHelpModal.set(false);
    this.showSupportModal.set(true);
  }
  protected openSettingsModal(): void { this.showSettingsModal.set(true); }
  protected closeSettingsModal(): void { this.showSettingsModal.set(false); }

  protected onQuickenImported(coins: CoinRecord[]): void {
    this.inv.addCoins(coins);
  }

  // ===================== Import & export =====================

  protected handleImportSelection(kind: ImportKind): void {
    if (kind === 'qif') this.openQuickenModal();
    // Excel and CSV share one dialog, told which entry opened it.
    if (kind === 'excel') this.openCsvImportModal('excel');
    if (kind === 'csv') this.openCsvImportModal('csv');
    if (kind === 'images') this.openImageImportModal();
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

  /**
   * Selects a coin and opens the detail panel (row click, Enter/Space, Add Coin).
   * Not a toggle: re-clicking the open row keeps the panel open.
   */
  protected openCoinDetail(coinId: string): void {
    this.selectCoin(coinId);
    this.showDetailPanel.set(true);
  }

  protected closeDetailPanel(): void {
    this.showDetailPanel.set(false);
    this.images.closeImageGallery();
    // Clear any pending focus request; otherwise the next (fresh) panel would
    // act on it and pull focus out of the grid.
    this.detailFieldFocusRequest.set(0);
  }

  /** The "Images" button on a table row: select that coin, then show its photos. */
  protected showCoinImages(coinId: string): void {
    this.selectCoin(coinId);
    this.images.openImageGallery();
  }

  /** Creates a draft coin, opens it in the detail panel and focuses the first field. */
  protected addBlankCoin(): void {
    const coin = this.inv.addBlankCoin();
    this.openCoinDetail(coin.id);
    this.requestDetailFieldFocus();
  }

  /**
   * Asks the detail panel to focus its first field. A counter, not a flag, so
   * repeated requests each fire. Only Add Coin uses it; row clicks keep focus
   * in the grid.
   */
  protected readonly detailFieldFocusRequest = signal(0);

  private requestDetailFieldFocus(): void {
    this.detailFieldFocusRequest.update(count => count + 1);
  }

  protected deleteSelectedCoin(): void {
    const coin = this.selectedCoin;
    if (!coin) return;

    const confirmed = confirmAction(`Delete ${coin.coinType || 'this coin'}${coin.year ? ` (${coin.year})` : ''}?`);

    if (!confirmed) return;
    this.closeDetailPanel();
    this.inv.deleteCoin(coin.id);
  }

  // ===================== Search & filter coordination =====================
  // Filtering can hide the selected coin, so the shell re-picks one.

  protected onSearchQueryChange(value: string): void {
    this.filters.searchQuery.set(value);
    this.syncDefaultSelection();
  }

  protected onCategoryFilterChange(value: string): void {
    this.filters.categoryFilter.set(value);
    this.syncDefaultSelection();
  }

  // ===================== Start-up & connection =====================

  /** "Retry connection" button: reconnects without reloading the page. Never throws. */
  protected async retryConnection(): Promise<void> {
    const connected = await this.inv.retryConnection();
    if (connected) {
      this.defaultSelectionInitialized = false;
      this.syncDefaultSelection();
      // Run the start-up price fetch that a failed start-up skipped (guarded against repeats).
      void this.inv.autoRefreshSpotPrices();
    }
  }

  private async hydrateFromStorage(): Promise<void> {
    try {
      await this.inv.hydrate();

      // Refresh spot prices in the background. Not awaited: the external
      // service may be slow, and saved prices are already applied. Never throws.
      void this.inv.autoRefreshSpotPrices();
    } catch {
      // Connection failed: connectionError is set and the UI shows a retry
      // button. The price fetch is deferred to retryConnection().
    }
    this.syncDefaultSelection();

    const storedSettings = await this.storageService.get<AppSettings>(StorageKeys.AppSettings);
    if (storedSettings) {
      this.showTransactionsInDetails.set(Boolean(storedSettings.showTransactionsInDetails));
    }

    await this.columns.restoreFromStorage();
    await this.filters.restoreFromStorage();
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
