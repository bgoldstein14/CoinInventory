import { DecimalPipe } from '@angular/common';
import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ImageMatchingService } from './services/image-matching.service';
import { QuickenImportService } from './services/quicken-import.service';
import { StorageKeys, StorageService } from './services/storage.service';
import { CoinRecord, ImageMatchCandidate, QuickenImportRecord } from './types/coin.model';

/**
 * Starter inventory shown the first time the app runs (before anything has
 * been saved to IndexedDB). Also used as the fallback when stored data is
 * missing, empty, or fails to parse.
 */
const seedInventory: CoinRecord[] = [
  {
    id: 'c-001',
    name: 'Liberty Head Double Eagle',
    denomination: '20 Dollar',
    year: 1907,
    type: 'Liberty Head',
    category: 'Gold Coin',
    country: 'United States',
    grade: 'MS64',
    certCompany: 'NGC',
    certNumber: '255481-016',
    variety: 'No Motto',
    mintMark: '',
    composition: '90% Gold',
    purchaseDate: '2024-08-15',
    purchasePrice: 2450,
    currentValue: 2580,
    notes: 'Strong luster, exceptional strike, original toning.',
    imagePaths: ['liberty_head_double_eagle.jpg'],
    tags: ['gold', 'United States'],
    source: 'manual'
  },
  {
    id: 'c-002',
    name: 'Mercury Dime',
    denomination: '10 Cents',
    year: 1945,
    type: 'Mercury',
    category: 'Silver Coin',
    country: 'United States',
    grade: 'XF',
    certCompany: '',
    certNumber: '',
    variety: 'FS-101',
    mintMark: 'S',
    composition: '90% Silver',
    purchaseDate: '2023-11-03',
    purchasePrice: 18,
    currentValue: 24,
    notes: 'Lightly toned, eye appeal above average.',
    imagePaths: ['mercury_dime_1945.jpg'],
    tags: ['silver', 'US'],
    source: 'manual'
  }
];

const inventoryColumnOrder = [
  'name',
  'grade',
  'category',
  'denomination',
  'country',
  'year',
  'purchasePrice',
  'currentValue',
  'mintMark',
  'variety',
  'certNumber',
  'tags',
  'source'
] as const;

type InventoryColumn = (typeof inventoryColumnOrder)[number];

const inventoryColumnLabels: Record<InventoryColumn, string> = {
  name: 'Name',
  grade: 'Grade',
  category: 'Category',
  denomination: 'Denomination',
  country: 'Country',
  year: 'Year',
  purchasePrice: 'Purchase Price',
  currentValue: 'Current Value',
  mintMark: 'Mint Mark',
  variety: 'Variety',
  certNumber: 'Cert',
  tags: 'Tags',
  source: 'Source'
};

/** Columns shown by default before the user customizes visibility. */
const defaultVisibleColumns: InventoryColumn[] = [
  'name',
  'grade',
  'category',
  'denomination',
  'country',
  'year',
  'purchasePrice',
  'currentValue'
];

type SortDirection = 'asc' | 'desc';

interface SortState {
  column: InventoryColumn;
  direction: SortDirection;
}

/** Category filter value meaning "show every category". */
const allCategoriesFilter = 'All';

/**
 * Root component for the Coin Inventory application.
 *
 * Owns the inventory data model, the Quicken (QIF) import workflow, the
 * filename-based image matching workflow, and the inventory table's
 * search / filter / sort / column-visibility state. Persistence goes
 * through {@link StorageService} (IndexedDB), since coin photos stored as
 * base64 data URLs quickly exceed what localStorage can hold.
 */
@Component({
  selector: 'app-root',
  imports: [FormsModule, DecimalPipe],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  protected readonly inventory = signal<CoinRecord[]>(seedInventory);
  protected readonly quickenText = signal<string>(`!Type:Invst\nD2024-01-15\nNBuy\nYLiberty Head Double Eagle\nT2450.00\nMUnited States Gold\n^\n`);
  protected readonly importedRecords = signal<QuickenImportRecord[]>([]);
  /** Warnings surfaced by the last Quicken parse (e.g. skipped sales, unrecognized action codes). */
  protected readonly quickenWarnings = signal<string[]>([]);
  protected readonly imageMatches = signal<ImageMatchCandidate[]>([]);
  protected readonly quickenAccounts = signal<string[]>([]);
  protected readonly selectedAccounts = signal<string[]>([]);
  protected readonly selectedCoinId = signal<string | null>(seedInventory[0]?.id ?? null);
  protected readonly showImageGallery = signal(false);
  protected readonly showPhotoViewer = signal(false);
  protected readonly photoViewerIndex = signal<number>(0);
  protected readonly inventoryColumnOptions = signal<InventoryColumn[]>([...inventoryColumnOrder]);
  protected readonly visibleInventoryColumns = signal<InventoryColumn[]>([...defaultVisibleColumns]);
  protected readonly manualReviewMatches = signal<Array<{ imagePath: string; matchedRecordId: string | null; confidence: number; reason: string }>>([]);
  protected readonly inventoryColumnLabels = inventoryColumnLabels;

  /** Free-text search across name, denomination, grade, cert, variety, notes, and tags. */
  protected readonly searchQuery = signal<string>('');
  /** Selected category filter, or `allCategoriesFilter` to show everything. */
  protected readonly categoryFilter = signal<string>(allCategoriesFilter);
  /** Active inventory table sort column/direction. */
  protected readonly sortState = signal<SortState>({ column: 'name', direction: 'asc' });
  protected readonly allCategoriesFilter = allCategoriesFilter;

  /**
   * Reference to the global `Number` constructor, exposed as a component
   * member so the template can call it. Angular's template type-checker
   * only resolves whitelisted globals inside bindings - a bare `Number(...)`
   * call in app.html fails to compile even though it's valid TypeScript;
   * routing it through `this.Number` resolves the same global correctly.
   */
  protected readonly Number = Number;

  /** Promise that resolves once any previously saved state has been loaded. Exposed for tests. */
  protected readonly ready: Promise<void>;

  protected readonly inventoryCategories = computed(() => {
    const categories = this.inventory().map((coin) => coin.category).filter(Boolean);
    return [...new Set(categories)];
  });

  /**
   * The inventory rows to render: filtered by the active search text and
   * category, then sorted by the active sort column/direction. Selection,
   * deletion, and persistence always operate on the full `inventory()`
   * signal - only the table's visible rows are affected by this.
   */
  protected readonly filteredInventory = computed(() => {
    const query = this.searchQuery().trim().toLowerCase();
    const category = this.categoryFilter();
    const { column, direction } = this.sortState();

    const filtered = this.inventory().filter((coin) => {
      if (category !== allCategoriesFilter && coin.category !== category) {
        return false;
      }

      if (!query) {
        return true;
      }

      const haystack = [
        coin.name,
        coin.denomination,
        coin.type,
        coin.country,
        coin.grade,
        coin.certCompany,
        coin.certNumber,
        coin.variety,
        coin.mintMark,
        coin.notes,
        ...coin.tags
      ]
        .join(' ')
        .toLowerCase();

      return haystack.includes(query);
    });

    return [...filtered].sort((left, right) => {
      const comparison = this.compareColumnValues(left[column], right[column]);
      return direction === 'asc' ? comparison : -comparison;
    });
  });

  protected readonly groupedImportedRecords = computed(() => {
    return this.importedRecords().reduce<Record<string, QuickenImportRecord[]>>((acc, record) => {
      const account = record.account ?? 'Unassigned';
      acc[account] ??= [];
      acc[account].push(record);
      return acc;
    }, {});
  });

  protected readonly manualReviewQueue = computed(() => {
    return this.imageMatches().filter((match) => !match.matchedRecordId || match.confidence < 0.6);
  });

  protected readonly totalValue = computed(() =>
    this.inventory().reduce((sum, coin) => sum + coin.currentValue, 0)
  );

  protected readonly totalCost = computed(() =>
    this.inventory().reduce((sum, coin) => sum + coin.purchasePrice, 0)
  );

  public get selectedCoin(): CoinRecord | null {
    return this.inventory().find((coin) => coin.id === this.selectedCoinId()) ?? null;
  }

  constructor(
    private readonly quickenImportService: QuickenImportService,
    private readonly imageMatchingService: ImageMatchingService,
    private readonly storageService: StorageService
  ) {
    this.refreshQuickenAccounts();
    this.ensureSelectedCoin();
    this.ready = this.hydrateFromStorage();
  }

  protected onQuickenTextChange(value: string): void {
    this.quickenText.set(value);
    this.refreshQuickenAccounts();
  }

  protected refreshQuickenAccounts(): void {
    const result = this.quickenImportService.parse(this.quickenText());
    this.quickenAccounts.set(result.accounts);

    if (result.accounts.length > 0 && this.selectedAccounts().length === 0) {
      this.selectedAccounts.set([...result.accounts]);
    }
  }

  protected toggleAccount(account: string): void {
    const next = this.selectedAccounts();
    const exists = next.includes(account);
    this.selectedAccounts.set(
      exists ? next.filter((item) => item !== account) : [...next, account]
    );
  }

  protected toggleAllAccounts(): void {
    const accounts = this.quickenAccounts();
    const selected = this.selectedAccounts();
    this.selectedAccounts.set(
      selected.length === accounts.length ? [] : [...accounts]
    );
  }

  protected previewImport(): void {
    const result = this.quickenImportService.parse(this.quickenText(), this.selectedAccounts());
    this.importedRecords.set(result.importedRecords);
    this.quickenWarnings.set(result.warnings);
  }

  protected async handleQuickenFileSelection(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      return;
    }

    const text = await file.text();
    this.quickenText.set(text);
    this.refreshQuickenAccounts();

    const result = this.quickenImportService.parse(text, this.selectedAccounts());
    this.importedRecords.set(result.importedRecords);
    this.quickenWarnings.set(result.warnings);
  }

  protected importQuicken(): void {
    const result = this.quickenImportService.parse(this.quickenText(), this.selectedAccounts());
    this.importedRecords.set(result.importedRecords);
    this.quickenWarnings.set(result.warnings);

    const merged: CoinRecord[] = [
      ...this.inventory(),
      ...result.importedRecords.map((record): CoinRecord => ({
        id: record.id,
        name: record.name,
        denomination: record.denomination,
        year: null,
        type: record.type,
        category: 'Imported',
        country: record.country,
        grade: 'Unknown',
        certCompany: '',
        certNumber: '',
        variety: '',
        mintMark: '',
        composition: '',
        purchaseDate: record.purchaseDate ?? '',
        purchasePrice: record.purchasePrice,
        currentValue: record.currentValue,
        notes: record.notes,
        imagePaths: [],
        tags: ['imported'],
        source: 'quicken'
      }))
    ];

    this.inventory.set(merged);
    this.persistInventoryState();
    this.ensureSelectedCoin();
  }

  protected toggleColumn(column: InventoryColumn): void {
    const next = this.visibleInventoryColumns();
    const exists = next.includes(column);
    const updated = exists ? next.filter((item) => item !== column) : [...next, column];
    const safeUpdated = updated.length > 0 ? updated : [column];
    this.visibleInventoryColumns.set(safeUpdated);
    this.persistVisibleColumns(safeUpdated);
  }

  protected selectCoin(coinId: string): void {
    this.selectedCoinId.set(coinId);
    this.showImageGallery.set(false);
  }

  protected toggleImageGallery(): void {
    if (!this.selectedCoin) {
      return;
    }
    this.showImageGallery.set(!this.showImageGallery());
  }

  protected addBlankCoin(): void {
    const nextCoin: CoinRecord = {
      id: crypto.randomUUID(),
      name: 'New Coin',
      denomination: 'Unknown',
      year: null,
      type: 'Unknown',
      category: 'Uncategorized',
      country: 'Unknown',
      grade: 'Ungraded',
      certCompany: '',
      certNumber: '',
      variety: '',
      mintMark: '',
      composition: '',
      purchaseDate: '',
      purchasePrice: 0,
      currentValue: 0,
      notes: '',
      imagePaths: [],
      tags: ['new'],
      source: 'manual'
    };

    this.inventory.set([...this.inventory(), nextCoin]);
    this.selectedCoinId.set(nextCoin.id);
    this.showImageGallery.set(false);
    this.persistInventoryState();
  }

  protected deleteSelectedCoin(): void {
    const selectedCoin = this.selectedCoin;
    if (!selectedCoin) {
      return;
    }

    const nextInventory = this.inventory().filter((coin) => coin.id !== selectedCoin.id);
    this.inventory.set(nextInventory);
    this.persistInventoryState();
    this.ensureSelectedCoin();
  }

  /**
   * Serializes the full inventory as compact JSON. This is the canonical
   * "current state as a string" used for round-tripping (e.g. detecting
   * whether an imported file actually differs). The user-facing download
   * in {@link downloadInventoryJson} pretty-prints its own copy instead,
   * since that file is meant to be opened and read by a person.
   */
  protected exportInventoryData(): string {
    return JSON.stringify(this.inventory());
  }

  protected async importInventoryData(json: string): Promise<void> {
    try {
      const parsed = JSON.parse(json) as CoinRecord[];
      if (!Array.isArray(parsed) || parsed.length === 0) {
        return;
      }

      const normalized = parsed.map((coin) => ({
        ...coin,
        id: coin.id || crypto.randomUUID(),
        imagePaths: Array.isArray(coin.imagePaths) ? coin.imagePaths : [],
        tags: Array.isArray(coin.tags) ? coin.tags : [],
        source: coin.source || 'manual',
        grade: coin.grade || 'Ungraded'
      }));

      this.inventory.set(normalized);
      this.persistInventoryState();
      this.ensureSelectedCoin();
    } catch {
      return;
    }
  }

  protected handleInventoryImportFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      return;
    }

    file.text().then((text) => {
      void this.importInventoryData(text);
      input.value = '';
    });
  }

  protected downloadInventoryJson(): void {
    // Pretty-printed for readability when a user opens the exported file in
    // a text editor; exportInventoryData() itself stays compact since it is
    // used for internal round-tripping rather than human consumption.
    const payload = JSON.stringify(this.inventory(), null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'coin-inventory.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  protected openPhotoViewer(index: number): void {
    const coin = this.selectedCoin;
    if (!coin || coin.imagePaths.length === 0) {
      return;
    }

    this.photoViewerIndex.set(index);
    this.showPhotoViewer.set(true);
  }

  protected closePhotoViewer(): void {
    this.showPhotoViewer.set(false);
  }

  protected movePhotoViewer(step: number): void {
    const coin = this.selectedCoin;
    if (!coin || coin.imagePaths.length === 0) {
      return;
    }

    const nextIndex = (this.photoViewerIndex() + step + coin.imagePaths.length) % coin.imagePaths.length;
    this.photoViewerIndex.set(nextIndex);
  }

  protected async addCoinImages(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    const selectedCoin = this.selectedCoin;
    if (!selectedCoin || files.length === 0) {
      return;
    }

    const nextPaths = [...selectedCoin.imagePaths];
    for (const file of files) {
      const dataUrl = await this.readFileAsDataUrl(file);
      nextPaths.push(dataUrl);
    }

    this.updateCoin(selectedCoin.id, { imagePaths: [...new Set(nextPaths)] });
    input.value = '';
    this.showImageGallery.set(true);
  }

  protected handleImageDrop(event: DragEvent): void {
    event.preventDefault();
    const selectedCoin = this.selectedCoin;
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (!selectedCoin || files.length === 0) {
      return;
    }

    const imageFiles = files.filter((file) => file.type.startsWith('image/'));
    if (imageFiles.length === 0) {
      return;
    }

    void this.addDroppedFiles(imageFiles);
  }

  protected handleDragOver(event: DragEvent): void {
    event.preventDefault();
  }

  protected removeCoinImage(imagePath: string): void {
    const selectedCoin = this.selectedCoin;
    if (!selectedCoin) {
      return;
    }

    const nextNames = selectedCoin.imagePaths.filter((path) => path !== imagePath);
    this.updateCoin(selectedCoin.id, { imagePaths: nextNames });
  }

  protected updateSelectedCoin<K extends keyof CoinRecord>(field: K, value: CoinRecord[K]): void {
    const selectedCoin = this.selectedCoin;
    if (!selectedCoin) {
      return;
    }

    this.updateCoin(selectedCoin.id, { [field]: value } as Partial<CoinRecord>);
  }

  protected formatInventoryCell(coin: CoinRecord, column: InventoryColumn): string {
    switch (column) {
      case 'name':
        return coin.name;
      case 'grade':
        return coin.grade || 'Ungraded';
      case 'category':
        return coin.category || '—';
      case 'denomination':
        return coin.denomination || '—';
      case 'country':
        return coin.country || '—';
      case 'year':
        return coin.year ? String(coin.year) : '—';
      case 'purchasePrice':
        return `$${coin.purchasePrice.toFixed(2)}`;
      case 'currentValue':
        return `$${coin.currentValue.toFixed(2)}`;
      case 'mintMark':
        return coin.mintMark || '—';
      case 'variety':
        return coin.variety || '—';
      case 'certNumber':
        return coin.certCompany || coin.certNumber ? `${coin.certCompany} ${coin.certNumber}`.trim() || '—' : '—';
      case 'tags':
        return coin.tags.join(', ') || '—';
      case 'source':
        return coin.source;
      default:
        return '—';
    }
  }

  /** The coin's first attached image, if any - used for the inventory table thumbnail. */
  protected primaryImage(coin: CoinRecord): string | null {
    return coin.imagePaths[0] ?? null;
  }

  /**
   * CSS class for the grade badge shown in the inventory table, grouping
   * grades into the tiers a dealer or collector recognizes at a glance:
   * mint state / proof, circulated-but-attractive, worn, and ungraded.
   */
  protected gradeBadgeClass(grade: string): string {
    const normalized = (grade || '').trim().toUpperCase();
    if (!normalized || normalized === 'UNGRADED') {
      return 'badge badge--ungraded';
    }
    if (/^(MS|PR|PF)/.test(normalized)) {
      return 'badge badge--mint';
    }
    if (/^(AU|XF|VF)/.test(normalized)) {
      return 'badge badge--circulated';
    }
    return 'badge badge--worn';
  }

  /** Combined certification badge label (e.g. "NGC #255481-016"), or null when uncertified. */
  protected certBadgeLabel(coin: CoinRecord): string | null {
    if (!coin.certCompany && !coin.certNumber) {
      return null;
    }
    const company = coin.certCompany || 'Cert';
    return coin.certNumber ? `${company} #${coin.certNumber}` : company;
  }

  /** Toggles the inventory table's sort column, flipping direction on repeat clicks. */
  protected setSortColumn(column: InventoryColumn): void {
    const current = this.sortState();
    this.sortState.set(
      current.column === column
        ? { column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { column, direction: 'asc' }
    );
  }

  /** Arrow glyph shown in a sortable column header: active direction, or a neutral hint otherwise. */
  protected sortIndicator(column: InventoryColumn): string {
    const current = this.sortState();
    if (current.column !== column) {
      return '';
    }
    return current.direction === 'asc' ? '▲' : '▼';
  }

  protected onSearchQueryChange(value: string): void {
    this.searchQuery.set(value);
  }

  protected onCategoryFilterChange(value: string): void {
    this.categoryFilter.set(value);
  }

  protected assignManualReviewMatch(imagePath: string, coinId: string): void {
    const updated = this.imageMatches().map((match) =>
      match.imagePath === imagePath
        ? {
            ...match,
            matchedRecordId: coinId,
            confidence: 0.8,
            reason: 'Manually assigned during review.'
          }
        : match
    );

    this.imageMatches.set(updated);
    this.manualReviewMatches.set(
      this.manualReviewMatches().filter((match) => match.imagePath !== imagePath)
    );
  }

  protected handleImageSelection(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    const paths = files.map((file) => file.name);
    const matches = this.imageMatchingService.matchImages(paths, this.inventory());
    this.imageMatches.set(matches);
  }

  protected unmatchedImages(): ImageMatchCandidate[] {
    return this.imageMatches().filter((match) => !match.matchedRecordId);
  }

  protected groupedAccountNames(): string[] {
    return Object.keys(this.groupedImportedRecords());
  }

  private ensureSelectedCoin(): void {
    if (this.inventory().length === 0) {
      this.selectedCoinId.set(null);
      return;
    }

    const current = this.selectedCoinId();
    if (!current || !this.inventory().some((coin) => coin.id === current)) {
      this.selectedCoinId.set(this.inventory()[0].id);
    }
  }

  private updateCoin(coinId: string, updates: Partial<CoinRecord>): void {
    const nextInventory = this.inventory().map((coin) =>
      coin.id === coinId ? { ...coin, ...updates } : coin
    );

    this.inventory.set(nextInventory);
    this.persistInventoryState();
  }

  /**
   * Reads a File's bytes and returns a base64 `data:` URL. Deliberately
   * avoids `FileReader`, which is a browser-only API not available under
   * the Node-based unit test environment this project runs on; Node does
   * provide a global `File`, but not `FileReader`. `File.arrayBuffer()`
   * plus manual base64 encoding works identically in the browser and in
   * Node/Vitest, so image handling can be unit tested without a DOM.
   */
  private async readFileAsDataUrl(file: File): Promise<string> {
    try {
      const buffer = await file.arrayBuffer();
      const base64 = this.encodeBase64(new Uint8Array(buffer));
      const mimeType = file.type || 'application/octet-stream';
      return `data:${mimeType};base64,${base64}`;
    } catch {
      return file.name;
    }
  }

  /** Encodes raw bytes as base64, chunked to avoid call-stack limits on large images. */
  private encodeBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, offset + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }

  private async addDroppedFiles(files: File[]): Promise<void> {
    const selectedCoin = this.selectedCoin;
    if (!selectedCoin) {
      return;
    }

    const nextPaths = [...selectedCoin.imagePaths];
    for (const file of files) {
      const dataUrl = await this.readFileAsDataUrl(file);
      nextPaths.push(dataUrl);
    }

    this.updateCoin(selectedCoin.id, { imagePaths: [...new Set(nextPaths)] });
    this.showImageGallery.set(true);
  }

  /**
   * Loads previously saved inventory and column-visibility state from
   * IndexedDB, if any exists, and applies it over the seed defaults the
   * signals were constructed with. Safe to call once at startup; a
   * missing or empty stored value is treated as "nothing to restore".
   */
  private async hydrateFromStorage(): Promise<void> {
    const [storedInventory, storedColumns] = await Promise.all([
      this.storageService.get<CoinRecord[]>(StorageKeys.Inventory),
      this.storageService.get<InventoryColumn[]>(StorageKeys.VisibleColumns)
    ]);

    if (Array.isArray(storedInventory) && storedInventory.length > 0) {
      this.inventory.set(storedInventory);
      this.ensureSelectedCoin();
    }

    if (Array.isArray(storedColumns) && storedColumns.length > 0) {
      this.visibleInventoryColumns.set(storedColumns);
    }
  }

  private persistInventoryState(): void {
    void this.storageService.set(StorageKeys.Inventory, this.inventory());
  }

  private persistVisibleColumns(columns: InventoryColumn[]): void {
    void this.storageService.set(StorageKeys.VisibleColumns, columns);
  }

  /** Ordering comparator for a single inventory column's value, used by the sortable table header. */
  private compareColumnValues(left: unknown, right: unknown): number {
    if (typeof left === 'number' && typeof right === 'number') {
      return left - right;
    }

    const leftText = (left ?? '').toString().toLowerCase();
    const rightText = (right ?? '').toString().toLowerCase();
    return leftText.localeCompare(rightText);
  }
}
