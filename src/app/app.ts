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
  /** Which Import menu entry opened the spreadsheet dialog — see its `mode`
   *  input. One dialog, two doors; this is which door. */
  protected readonly csvImportMode = signal<'excel' | 'csv'>('excel');
  protected readonly showReportModal = signal(false);
  protected readonly showSpotPriceModal = signal(false);
  protected readonly showStatisticsModal = signal(false);
  /*
   * "Help > Report a problem" (components/support-modal).
   *
   * Owned here like every other dialog: the toolbar only reports that it was
   * asked for. Worth saying out loud because the batch image import once had
   * a modal, a signal and an open/close pair with nothing ever calling the
   * opener — see handleImportSelection below — so the join is the part that
   * goes missing, not the component.
   */
  protected readonly showSupportModal = signal(false);

  /*
   * The Help screen (components/help-modal) — what the toolbar's help icon
   * now opens. The icon used to open showSupportModal directly; "Report a
   * problem" is the first control on the Help screen, so that route is one
   * click longer and no harder to find.
   */
  protected readonly showHelpModal = signal(false);

  /*
   * "SOME OF YOUR COINS HAVE NO DENOMINATION" — THE PROMPT
   * WHY THE SHELL CARRIES THIS AT ALL
   * The screen that FIXES unlinked coins lives inside Reference Data, because
   * every fix it offers is a reference-data fix (see reference-sections.ts).
   * That is the right home and it is a home a non-technical user would never
   * open. Migration 014's report had exactly that problem in a worse form:
   * the diagnosis existed, in SQL output nobody would ever encounter.
   *
   * So the shell asks the same question the pane does, and raises a banner
   * when the answer is not zero. The banner is the only thing in the app
   * that tells somebody the problem exists; the pane is where it is fixed.
   *
   * IT IS SILENT AT ZERO, AND THAT IS NOT AN INCONSISTENCY
   * The pane reports zero loudly — "Every coin has a denomination" is what
   * the user went there to find out. A permanent green bar on the main
   * screen saying the same thing is noise, and noise is what makes the
   * non-zero case invisible. Different question, different answer.
   *
   * It is also silent until the lookup has landed; `censusUnlinkedDenominations`
   * handles that and explains why.
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

  /**
   * Has the user (or the app) ever picked a coin? Until they have, the shell
   * auto-selects the first visible row so the screen is never empty.
   */
  private defaultSelectionInitialized = false;

  public get selectedCoin(): CoinRecord | null {
    return this.inv.selectedCoin();
  }

  /**
   * How many photographs a coin has, for the template's "is the viewer worth
   * showing" guard.
   *
   * Exposed here because `coin.imagePaths` is ABSENT until that coin's
   * photographs are fetched — the list endpoint stopped carrying them after
   * a 105-coin collection made its response impossible to serialise (see
   * server/routes/coins/list-query.ts) — so `.length` in a template would
   * throw. `coinPhotoCount` falls back to the `imageCount` the list DID send.
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
    // Back to the default pane. Without this, using the banner once would
    // make the filter bar's "Manage categories" button silently open the
    // unlinked-coins screen from then on.
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

  /**
   * Help > "Report a problem". HELP CLOSES FIRST, and that is the whole
   * reason this is a method rather than two bindings in the template: two
   * dialogs open at once would stack two backdrops and two × buttons, and
   * the user would have to close the reporter twice to get back to work.
   */
  protected openSupportModalFromHelp(): void {
    this.showHelpModal.set(false);
    this.showSupportModal.set(true);
  }
  protected openSettingsModal(): void { this.showSettingsModal.set(true); }
  protected closeSettingsModal(): void { this.showSettingsModal.set(false); }

  /*
   * `openReferenceDataFromSettings()` lived here, raised by an "Open
   * Reference Data" button inside the Settings dialog. Both are gone: the
   * owner judged the button redundant because the toolbar already carries an
   * obvious route to the reference lists. The method went with it rather
   * than being left behind — an unreferenced handler is how a deleted
   * button grows back.
   */

  protected onQuickenImported(coins: CoinRecord[]): void {
    this.inv.addCoins(coins);
  }

  // ===================== Import & export =====================
  //
  // The toolbar reports which menu entry was picked; two of them open a modal
  // and the rest are plain file operations handled by `io`.

  protected handleImportSelection(kind: ImportKind): void {
    if (kind === 'qif') this.openQuickenModal();
    // Two menu entries, ONE dialog, told which door it was opened through.
    // See `mode` in csv-import-modal.ts for why the modal is shared and the
    // menu is not.
    if (kind === 'excel') this.openCsvImportModal('excel');
    if (kind === 'csv') this.openCsvImportModal('csv');
    // There is deliberately no 'json' branch: importing an inventory JSON
    // was removed from the Import menu. Export -> JSON is untouched.
    // Photos rather than coin records -- see ImportKind. This line was the
    // missing one: the modal, its signal and its open/close methods all
    // existed, but nothing ever called openImageImportModal(), so the batch
    // image import was unreachable from the UI entirely.
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
   * A COIN WAS ASKED FOR. The one code path behind every gesture that means
   * "show me this coin": clicking a grid row, pressing Enter or Space on a
   * focused row, and creating a new row with Add Coin.
   *
   * IT IS NOT A TOGGLE ANY MORE, and that is deliberate. It used to be
   * reached only from a per-row "Details" button, where closing on a second
   * press is the right behaviour for a button. The ROW is now what opens the
   * panel, and a row is not a button: clicking the row you are currently
   * reading should not make the information vanish. The panel's own Close
   * button is the way out, and clicking another row moves the panel to it.
   */
  protected openCoinDetail(coinId: string): void {
    this.selectCoin(coinId);
    this.showDetailPanel.set(true);
  }

  protected closeDetailPanel(): void {
    this.showDetailPanel.set(false);
    this.images.closeImageGallery();
    // Forget any outstanding "put the caret in the first field". The panel
    // is destroyed when it closes, so the NEXT one is a fresh instance that
    // has never acted on this request — and if the next thing the user does
    // is click a grid row, acting on it would throw focus out of the grid
    // and stop the arrow keys working. See CoinDetailPanel.applyPendingFocus.
    this.detailFieldFocusRequest.set(0);
  }

  /** The "Images" button on a table row: select that coin, then show its photos. */
  protected showCoinImages(coinId: string): void {
    this.selectCoin(coinId);
    this.images.openImageGallery();
  }

  /**
   * ADD COIN — create a row AND open it.
   *
   * It used to create the draft row and stop there, so the user got an empty
   * row with no visible place to type and had to discover that a second
   * click was needed before they could enter anything. A new coin is just a
   * row you immediately want to look at, so it goes through
   * `openCoinDetail` — the same code path a row click takes — and then asks
   * the panel for the caret.
   *
   * `selectCoin` (inside openCoinDetail) closes the image gallery, which is
   * what the old body did explicitly.
   */
  protected addBlankCoin(): void {
    const coin = this.inv.addBlankCoin();
    this.openCoinDetail(coin.id);
    this.requestDetailFieldFocus();
  }

  /**
   * Ask the open detail panel to put the caret in its first field.
   *
   * A COUNTER rather than a flag: pressing Add Coin twice must move the
   * caret twice, and a boolean already set to `true` would make the second
   * press do nothing. See CoinDetailPanel.focusFirstFieldRequest.
   *
   * Only Add Coin calls this. Opening the panel from a row deliberately
   * leaves focus in the grid, or the arrow keys would stop working the
   * instant the panel appeared.
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
      // If the automatic start-up price fetch never got its chance (start-up
      // failed, so there was no "finished starting up" moment), this is that
      // moment. The call guards itself against running twice, so a user who
      // presses Retry five times still gets at most one successful fetch.
      void this.inv.autoRefreshSpotPrices();
    }
  }

  private async hydrateFromStorage(): Promise<void> {
    try {
      await this.inv.hydrate();

      // ---- Finished starting up: refresh spot prices from live COMEX ----
      //
      // NOT awaited, and that is the whole point. hydrate() has resolved, so
      // the coins are on screen and the app is usable; this call goes out to
      // the public internet and may be slow, blocked or simply hang. Awaiting
      // it would put a third-party web service between the owner and his coin
      // list. It lands when it lands.
      //
      // It is also placed AFTER hydrate() rather than inside it so the
      // ordering is right: hydrate() has already applied the prices saved in
      // the database, so every melt value is populated immediately and this
      // merely makes them more current. A failed fetch changes nothing.
      //
      // `void` marks "deliberately not awaited". Safe because
      // autoRefreshSpotPrices() never throws — see its comment.
      void this.inv.autoRefreshSpotPrices();
    } catch {
      // Database connection failed — connectionError signal is already set,
      // UI will show the error state (including a "Retry connection" button).
      // App still loads with an empty inventory.
      //
      // No automatic price fetch here: start-up did not finish, and prices
      // without a coin list are no use. The "Retry connection" handler above
      // picks it up if the user gets the backend going.
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
