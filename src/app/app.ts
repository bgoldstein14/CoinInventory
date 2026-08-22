import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CategoryModal } from './components/category-modal/category-modal';
import { CsvImportModal } from './components/csv-import-modal/csv-import-modal';
import { ImageImportModal } from './components/image-import-modal/image-import-modal';
import { QuickenImportModal } from './components/quicken-import-modal/quicken-import-modal';
import { ReportModal } from './components/report-modal/report-modal';
import { SpotPriceModalComponent } from './components/spot-price-modal/spot-price-modal';
import { CsvService } from './services/csv.service';
import { InventoryService } from './services/inventory.service';
import { StorageKeys, StorageService } from './services/storage.service';
import { CoinRecord, TransactionRecord } from './types/coin.model';
import {
  InventoryColumn, SortState, inventoryColumnOrder, inventoryColumnLabels,
  defaultVisibleColumns, formatInventoryCell, profitLossClass, gradeBadgeClass,
  certBadgeLabel, METAL_CONTENT_OPTIONS
} from './types/inventory-columns';

export const cacGreenBeanIconPath = 'CACGreenBean-trimmed.png';

const allCategoriesFilter = 'All';
const allSetsFilter = 'All';

@Component({
  selector: 'app-root',
  imports: [
    FormsModule, DecimalPipe, DatePipe,
    CategoryModal, CsvImportModal, ImageImportModal,
    QuickenImportModal, ReportModal, SpotPriceModalComponent
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  protected get inv() { return this.inventoryService; }

  // --- View state ---
  protected readonly showImageGallery = signal(false);
  protected readonly showPhotoViewer = signal(false);
  protected readonly photoViewerIndex = signal<number>(0);
  protected readonly inventoryColumnOptions = signal<InventoryColumn[]>([...inventoryColumnOrder]);
  protected readonly visibleInventoryColumns = signal<InventoryColumn[]>([...defaultVisibleColumns]);
  protected readonly inventoryColumnLabels = inventoryColumnLabels;

  // --- Multi-select ---
  protected readonly selectedCoinIds = signal<Set<string>>(new Set());
  private lastClickedIndex = -1;

  // --- Search & filter ---
  protected readonly searchQuery = signal<string>('');
  protected readonly categoryFilter = signal<string>(allCategoriesFilter);
  protected readonly sortState = signal<SortState>({ column: 'name', direction: 'asc' });
  protected readonly allCategoriesFilter = allCategoriesFilter;
  protected readonly showAdvancedFilters = signal(false);
  protected readonly gradeFilter = signal<string>('');
  protected readonly valueMinFilter = signal<string>('');
  protected readonly valueMaxFilter = signal<string>('');
  protected readonly sourceFilter = signal<string>('');
  protected readonly countryFilter = signal<string>('');
  protected readonly coinSetFilter = signal<string>(allSetsFilter);
  protected readonly allSetsFilter = allSetsFilter;
  protected readonly dealerFilter = signal<string>('');

  // --- Modal visibility ---
  protected readonly showQuickenModal = signal(false);
  protected readonly showImageImportModal = signal(false);
  protected readonly showCategoryModal = signal(false);
  protected readonly showColumnPicker = signal(false);
  protected readonly showCsvImportModal = signal(false);
  protected readonly showReportModal = signal(false);
  protected readonly showSpotPriceModal = signal(false);

  // --- Constants ---
  protected readonly cacGreenBeanIconPath = cacGreenBeanIconPath;
  protected readonly metalContentOptions = METAL_CONTENT_OPTIONS;
  protected readonly Number = Number;

  // --- Computed ---

  protected readonly filteredInventory = computed(() => {
    const query = this.searchQuery().trim().toLowerCase();
    const category = this.categoryFilter();
    const coinSet = this.coinSetFilter();
    const grade = this.gradeFilter().trim().toUpperCase();
    const valMin = this.valueMinFilter() ? Number(this.valueMinFilter()) : null;
    const valMax = this.valueMaxFilter() ? Number(this.valueMaxFilter()) : null;
    const source = this.sourceFilter();
    const country = this.countryFilter();
    const dealer = this.dealerFilter().trim().toLowerCase();
    const { column, direction } = this.sortState();

    const filtered = this.inv.inventory().filter(coin => {
      if (category !== allCategoriesFilter && coin.category !== category) return false;
      if (coinSet !== allSetsFilter && (coin.coinSet ?? '') !== coinSet) return false;
      if (grade && !(coin.grade || '').toUpperCase().startsWith(grade)) return false;
      if (valMin !== null && coin.currentValue < valMin) return false;
      if (valMax !== null && coin.currentValue > valMax) return false;
      if (source && coin.source !== source) return false;
      if (country && coin.country !== country) return false;
      if (dealer && !(coin.dealer ?? '').toLowerCase().includes(dealer)) return false;
      if (!query) return true;

      const haystack = [
        coin.name, coin.denomination, coin.type, coin.country,
        coin.grade, coin.certCompany, coin.certNumber, coin.variety,
        coin.mintMark, coin.notes, coin.dealer ?? '', coin.coinSet ?? '',
        ...coin.tags
      ].join(' ').toLowerCase();
      return haystack.includes(query);
    });

    return [...filtered].sort((left, right) => {
      let comparison: number;
      if (column === 'profitLoss') {
        comparison = (left.currentValue - left.purchasePrice) - (right.currentValue - right.purchasePrice);
      } else {
        comparison = this.compareColumnValues(left[column as keyof CoinRecord], right[column as keyof CoinRecord]);
      }
      return direction === 'asc' ? comparison : -comparison;
    });
  });

  protected readonly selectionCount = computed(() => this.selectedCoinIds().size);

  protected readonly selectedCoins = computed(() => {
    const ids = this.selectedCoinIds();
    return this.inv.inventory().filter(c => ids.has(c.id));
  });

  protected readonly allVisibleSelected = computed(() => {
    const visible = this.filteredInventory();
    if (visible.length === 0) return false;
    const ids = this.selectedCoinIds();
    return visible.every(c => ids.has(c.id));
  });

  protected readonly ready: Promise<void>;

  public get selectedCoin(): CoinRecord | null {
    return this.inv.selectedCoin();
  }

  constructor(
    private readonly storageService: StorageService,
    protected readonly inventoryService: InventoryService,
    private readonly csvService: CsvService
  ) {
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
  protected toggleColumnPicker(): void { this.showColumnPicker.set(!this.showColumnPicker()); }
  protected toggleAdvancedFilters(): void { this.showAdvancedFilters.set(!this.showAdvancedFilters()); }

  protected onQuickenImported(coins: CoinRecord[]): void {
    this.inv.addCoins(coins);
  }

  // ===================== Multi-select & Bulk edit =====================

  protected toggleCoinSelection(coinId: string, event: MouseEvent): void {
    event.stopPropagation();
    const current = new Set(this.selectedCoinIds());
    const visible = this.filteredInventory();
    const clickedIndex = visible.findIndex(c => c.id === coinId);

    if (event.shiftKey && this.lastClickedIndex >= 0 && clickedIndex >= 0) {
      const start = Math.min(this.lastClickedIndex, clickedIndex);
      const end = Math.max(this.lastClickedIndex, clickedIndex);
      for (let i = start; i <= end; i++) current.add(visible[i].id);
    } else {
      if (current.has(coinId)) current.delete(coinId);
      else current.add(coinId);
    }

    this.lastClickedIndex = clickedIndex;
    this.selectedCoinIds.set(current);
  }

  protected toggleAllCoins(): void {
    const visible = this.filteredInventory();
    if (this.allVisibleSelected()) {
      const current = new Set(this.selectedCoinIds());
      for (const c of visible) current.delete(c.id);
      this.selectedCoinIds.set(current);
    } else {
      const current = new Set(this.selectedCoinIds());
      for (const c of visible) current.add(c.id);
      this.selectedCoinIds.set(current);
    }
  }

  protected clearSelection(): void {
    this.selectedCoinIds.set(new Set());
    this.lastClickedIndex = -1;
  }

  protected isCoinSelected(coinId: string): boolean {
    return this.selectedCoinIds().has(coinId);
  }

  protected bulkUpdateField(field: string, value: string): void {
    const ids = this.selectedCoinIds();
    if (ids.size === 0) return;

    let coerced: unknown = value;
    if (field === 'purchasePrice' || field === 'currentValue' || field === 'soldPrice' || field === 'weight') {
      coerced = Number(value) || 0;
    } else if (field === 'year') {
      coerced = value ? Number(value) : null;
    }

    const next = this.inv.inventory().map(coin =>
      ids.has(coin.id) ? { ...coin, [field]: coerced } : coin
    );
    this.inv.inventory.set(next);
    this.inv.persistInventory();
  }

  protected bulkDeleteCoins(): void {
    const ids = this.selectedCoinIds();
    if (ids.size === 0) return;
    const next = this.inv.inventory().filter(c => !ids.has(c.id));
    this.inv.inventory.set(next);
    this.selectedCoinIds.set(new Set());
    this.inv.persistInventory();
    this.inv.ensureSelectedCoin();
  }

  // ===================== Inventory CRUD =====================

  protected toggleColumn(column: InventoryColumn): void {
    const next = this.visibleInventoryColumns();
    const exists = next.includes(column);
    const updated = exists ? next.filter(c => c !== column) : [...next, column];
    const safeUpdated = updated.length > 0 ? updated : [column];
    this.visibleInventoryColumns.set(safeUpdated);
    this.persistVisibleColumns(safeUpdated);
  }

  protected selectCoin(coinId: string): void {
    this.inv.selectCoin(coinId);
    this.showImageGallery.set(false);
  }

  protected toggleImageGallery(): void {
    if (!this.selectedCoin) return;
    this.showImageGallery.set(!this.showImageGallery());
  }

  protected addBlankCoin(): void {
    this.inv.addBlankCoin();
    this.showImageGallery.set(false);
  }

  protected deleteSelectedCoin(): void {
    const coin = this.selectedCoin;
    if (!coin) return;
    this.inv.deleteCoin(coin.id);
  }

  protected handleInventoryImportFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    file.text().then(text => { this.inv.importInventoryData(text); input.value = ''; });
  }

  protected downloadInventoryJson(): void {
    const payload = JSON.stringify(this.inv.inventory(), null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'coin-inventory.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  // ===================== CSV Export =====================

  protected exportCsv(): void { this.csvService.exportCsv(this.inv.inventory()); }
  protected exportInsuranceCsv(): void { this.csvService.exportInsuranceCsv(this.inv.inventory()); }

  // ===================== Photo viewer =====================

  protected openPhotoViewer(index: number): void {
    const coin = this.selectedCoin;
    if (!coin || coin.imagePaths.length === 0) return;
    this.photoViewerIndex.set(index);
    this.showPhotoViewer.set(true);
  }

  protected closePhotoViewer(): void { this.showPhotoViewer.set(false); }

  protected movePhotoViewer(step: number): void {
    const coin = this.selectedCoin;
    if (!coin || coin.imagePaths.length === 0) return;
    this.photoViewerIndex.set(
      (this.photoViewerIndex() + step + coin.imagePaths.length) % coin.imagePaths.length
    );
  }

  // ===================== Per-coin images =====================

  protected async addCoinImages(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    const coin = this.selectedCoin;
    if (!coin || files.length === 0) return;

    const nextPaths = [...coin.imagePaths];
    for (const file of files) nextPaths.push(await this.readFileAsDataUrl(file));
    this.inv.updateCoin(coin.id, { imagePaths: [...new Set(nextPaths)] });
    input.value = '';
    this.showImageGallery.set(true);
  }

  protected handleImageDrop(event: DragEvent): void {
    event.preventDefault();
    const coin = this.selectedCoin;
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (!coin || files.length === 0) return;
    const imageFiles = files.filter(f => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;
    void this.addDroppedFiles(imageFiles);
  }

  protected handleDragOver(event: DragEvent): void { event.preventDefault(); }

  protected removeCoinImage(imagePath: string): void {
    const coin = this.selectedCoin;
    if (!coin) return;
    this.inv.updateCoin(coin.id, { imagePaths: coin.imagePaths.filter(p => p !== imagePath) });
  }

  protected updateSelectedCoin<K extends keyof CoinRecord>(field: K, value: CoinRecord[K]): void {
    const coin = this.selectedCoin;
    if (!coin) return;
    this.inv.updateCoin(coin.id, { [field]: value } as Partial<CoinRecord>);
  }

  protected toggleCacSticker(): void {
    const coin = this.selectedCoin;
    if (!coin) return;
    this.inv.updateCoin(coin.id, { hasCacSticker: !coin.hasCacSticker });
  }

  // ===================== Spot prices & melt value =====================

  protected meltValue(coin: CoinRecord): number | null {
    return this.inv.meltValue(coin);
  }

  // ===================== Transactions =====================

  protected addTransactionForSelectedCoin(type: TransactionRecord['type'], amount: number, dealer: string, date: string, notes: string): void {
    const coinId = this.inv.selectedCoinId();
    if (!coinId) return;
    this.inv.addTransaction({
      id: crypto.randomUUID(), coinId, type,
      date: date || new Date().toISOString().slice(0, 10),
      amount: amount || 0, dealer: dealer || '', notes: notes || ''
    });
  }

  protected deleteTransaction(txnId: string): void { this.inv.deleteTransaction(txnId); }

  // ===================== Table formatting =====================

  protected formatInventoryCell = formatInventoryCell;
  protected profitLossClass = profitLossClass;
  protected gradeBadgeClass = gradeBadgeClass;
  protected certBadgeLabel = certBadgeLabel;

  protected primaryImage(coin: CoinRecord): string | null {
    return coin.imagePaths[0] ?? null;
  }

  protected setSortColumn(column: InventoryColumn): void {
    const current = this.sortState();
    this.sortState.set(
      current.column === column
        ? { column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { column, direction: 'asc' }
    );
  }

  protected sortIndicator(column: InventoryColumn): string {
    const current = this.sortState();
    return current.column !== column ? '' : current.direction === 'asc' ? '▲' : '▼';
  }

  protected onSearchQueryChange(value: string): void { this.searchQuery.set(value); }
  protected onCategoryFilterChange(value: string): void { this.categoryFilter.set(value); }

  // ===================== Private helpers =====================

  private compareColumnValues(left: unknown, right: unknown): number {
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    const leftText = (left ?? '').toString().toLowerCase();
    const rightText = (right ?? '').toString().toLowerCase();
    return leftText.localeCompare(rightText);
  }

  private async readFileAsDataUrl(file: File): Promise<string> {
    try {
      const buffer = await file.arrayBuffer();
      const base64 = this.encodeBase64(new Uint8Array(buffer));
      return `data:${file.type || 'application/octet-stream'};base64,${base64}`;
    } catch { return file.name; }
  }

  private encodeBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }

  private async addDroppedFiles(files: File[]): Promise<void> {
    const coin = this.selectedCoin;
    if (!coin) return;
    const nextPaths = [...coin.imagePaths];
    for (const file of files) nextPaths.push(await this.readFileAsDataUrl(file));
    this.inv.updateCoin(coin.id, { imagePaths: [...new Set(nextPaths)] });
    this.showImageGallery.set(true);
  }

  private async hydrateFromStorage(): Promise<void> {
    await this.inv.hydrate();
    const storedColumns = await this.storageService.get<InventoryColumn[]>(StorageKeys.VisibleColumns);
    if (Array.isArray(storedColumns) && storedColumns.length > 0) {
      this.visibleInventoryColumns.set(storedColumns);
    }
  }

  private persistVisibleColumns(columns: InventoryColumn[]): void {
    void this.storageService.set(StorageKeys.VisibleColumns, columns);
  }
}
