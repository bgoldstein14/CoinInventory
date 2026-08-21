import { DecimalPipe } from '@angular/common';
import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ImageMatchingService } from './services/image-matching.service';
import { QuickenImportService } from './services/quicken-import.service';
import { StorageKeys, StorageService } from './services/storage.service';
import { CoinRecord, ImageMatchCandidate, QuickenImportRecord } from './types/coin.model';

export const cacGreenBeanIconPath = 'CACGreenBean-trimmed.png';

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
    source: 'manual',
    hasCacSticker: true
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
    source: 'manual',
    hasCacSticker: false
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

const allCategoriesFilter = 'All';

const unassignedQuickenAccount = 'Unassigned';

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

  protected readonly categoryOptions = signal<string[]>(
    [...new Set(seedInventory.map((coin) => coin.category).filter(Boolean))].sort()
  );
  protected readonly newCategoryOption = signal<string>('');

  protected readonly searchQuery = signal<string>('');
  protected readonly categoryFilter = signal<string>(allCategoriesFilter);
  protected readonly sortState = signal<SortState>({ column: 'name', direction: 'asc' });
  protected readonly allCategoriesFilter = allCategoriesFilter;

  protected readonly cacGreenBeanIconPath = cacGreenBeanIconPath;

  protected readonly Number = Number;

  protected readonly ready: Promise<void>;

  protected readonly inventoryCategories = computed(() => {
    const categories = this.inventory().map((coin) => coin.category).filter(Boolean);
    return [...new Set(categories)];
  });

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
        category: this.categoryFromQuickenAccount(record.account),
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
        source: 'quicken',
        hasCacSticker: false
      }))
    ];

    this.inventory.set(merged);
    this.persistInventoryState();
    this.ensureSelectedCoin();

    const newAccountNames = result.importedRecords
      .map((record) => record.account)
      .filter((account): account is string => Boolean(account) && account !== unassignedQuickenAccount);
    this.mergeCategoryOptions(newAccountNames);
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
      category: '',
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
      source: 'manual',
      hasCacSticker: false
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
        grade: coin.grade || 'Ungraded',
        category: coin.category || '',
        hasCacSticker: Boolean(coin.hasCacSticker)
      }));

      this.inventory.set(normalized);
      this.persistInventoryState();
      this.ensureSelectedCoin();

      const importedCategories = normalized.map((coin) => coin.category).filter(Boolean);
      this.mergeCategoryOptions(importedCategories);
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

  protected toggleCacSticker(): void {
    const selectedCoin = this.selectedCoin;
    if (!selectedCoin) {
      return;
    }

    this.updateCoin(selectedCoin.id, { hasCacSticker: !selectedCoin.hasCacSticker });
  }

  protected addCategoryOptionFromDraft(): void {
    const draft = this.newCategoryOption().trim();
    if (!draft) {
      return;
    }

    this.mergeCategoryOptions([draft]);
    this.newCategoryOption.set('');
  }

  protected onNewCategoryOptionChange(value: string): void {
    this.newCategoryOption.set(value);
  }

  protected removeCategoryOption(category: string): void {
    const next = this.categoryOptions().filter((option) => option !== category);
    this.categoryOptions.set(next);
    this.persistCategoryOptions(next);
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

  protected primaryImage(coin: CoinRecord): string | null {
    return coin.imagePaths[0] ?? null;
  }

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

  protected certBadgeLabel(coin: CoinRecord): string | null {
    if (!coin.certCompany && !coin.certNumber) {
      return null;
    }
    const company = coin.certCompany || 'Cert';
    return coin.certNumber ? `${company} #${coin.certNumber}` : company;
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

  private categoryFromQuickenAccount(account: string | undefined): string {
    if (!account || account === unassignedQuickenAccount) {
      return '';
    }
    return account;
  }

  private mergeCategoryOptions(names: string[]): void {
    const current = new Set(this.categoryOptions());
    let changed = false;

    for (const name of names) {
      const trimmed = name.trim();
      if (trimmed && !current.has(trimmed)) {
        current.add(trimmed);
        changed = true;
      }
    }

    if (!changed) {
      return;
    }

    const next = [...current].sort();
    this.categoryOptions.set(next);
    this.persistCategoryOptions(next);
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

  private async hydrateFromStorage(): Promise<void> {
    const [storedInventory, storedColumns, storedCategoryOptions] = await Promise.all([
      this.storageService.get<CoinRecord[]>(StorageKeys.Inventory),
      this.storageService.get<InventoryColumn[]>(StorageKeys.VisibleColumns),
      this.storageService.get<string[]>(StorageKeys.CategoryOptions)
    ]);

    if (Array.isArray(storedInventory) && storedInventory.length > 0) {
      this.inventory.set(storedInventory);
      this.ensureSelectedCoin();
    }

    if (Array.isArray(storedColumns) && storedColumns.length > 0) {
      this.visibleInventoryColumns.set(storedColumns);
    }

    if (Array.isArray(storedCategoryOptions) && storedCategoryOptions.length > 0) {
      this.categoryOptions.set(storedCategoryOptions);
    } else {
      this.persistCategoryOptions(this.categoryOptions());
    }
  }

  private persistInventoryState(): void {
    void this.storageService.set(StorageKeys.Inventory, this.inventory());
  }

  private persistVisibleColumns(columns: InventoryColumn[]): void {
    void this.storageService.set(StorageKeys.VisibleColumns, columns);
  }

  private persistCategoryOptions(categories: string[]): void {
    void this.storageService.set(StorageKeys.CategoryOptions, categories);
  }

  private compareColumnValues(left: unknown, right: unknown): number {
    if (typeof left === 'number' && typeof right === 'number') {
      return left - right;
    }

    const leftText = (left ?? '').toString().toLowerCase();
    const rightText = (right ?? '').toString().toLowerCase();
    return leftText.localeCompare(rightText);
  }
}
