import { DecimalPipe } from '@angular/common';
import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ImageMatchingService } from './services/image-matching.service';
import { QuickenImportService } from './services/quicken-import.service';
import { CoinRecord, ImageMatchCandidate, QuickenImportRecord } from './types/coin.model';

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

const inventoryStorageKey = 'coin-inventory-data';
const inventoryColumnStorageKey = 'coin-inventory-column-visibility';

@Component({
  selector: 'app-root',
  imports: [FormsModule, DecimalPipe],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  protected readonly inventory = signal<CoinRecord[]>(this.loadInventoryState());
  protected readonly quickenText = signal<string>(`!Type:Invst
D2024-01-15
NLiberty Head Double Eagle
T2450.00
MUnited States Gold
YCoin Collection
^
`);
  protected readonly importedRecords = signal<QuickenImportRecord[]>([]);
  protected readonly imageMatches = signal<ImageMatchCandidate[]>([]);
  protected readonly quickenAccounts = signal<string[]>([]);
  protected readonly selectedAccounts = signal<string[]>([]);
  protected readonly selectedCoinId = signal<string | null>(seedInventory[0]?.id ?? null);
  protected readonly showImageGallery = signal(false);
  protected readonly showPhotoViewer = signal(false);
  protected readonly photoViewerIndex = signal<number>(0);
  protected readonly inventoryColumnOptions = signal<InventoryColumn[]>([...inventoryColumnOrder]);
  protected readonly visibleInventoryColumns = signal<InventoryColumn[]>(this.loadVisibleColumns());
  protected readonly manualReviewMatches = signal<Array<{ imagePath: string; matchedRecordId: string | null; confidence: number; reason: string }>>([]);
  protected readonly inventoryColumnLabels = inventoryColumnLabels;

  protected readonly inventoryCategories = computed(() => {
    const categories = this.inventory().map((coin) => coin.category).filter(Boolean);
    return [...new Set(categories)];
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
    private readonly imageMatchingService: ImageMatchingService
  ) {
    this.refreshQuickenAccounts();
    this.ensureSelectedCoin();
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
  }

  protected importQuicken(): void {
    const result = this.quickenImportService.parse(this.quickenText(), this.selectedAccounts());
    this.importedRecords.set(result.importedRecords);

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

  protected exportInventoryData(): string {
    return JSON.stringify(this.inventory(), null, 2);
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
    const payload = this.exportInventoryData();
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

  private readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? file.name));
      reader.onerror = () => resolve(file.name);
      reader.readAsDataURL(file);
    });
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

  private loadInventoryState(): CoinRecord[] {
    if (typeof window === 'undefined') {
      return seedInventory;
    }

    try {
      const stored = window.localStorage.getItem(inventoryStorageKey);
      if (!stored) {
        return seedInventory;
      }

      const parsed = JSON.parse(stored) as CoinRecord[];
      return Array.isArray(parsed) && parsed.length > 0 ? parsed : seedInventory;
    } catch {
      return seedInventory;
    }
  }

  private loadVisibleColumns(): InventoryColumn[] {
    if (typeof window === 'undefined') {
      return ['name', 'grade', 'category', 'denomination', 'country', 'year', 'purchasePrice', 'currentValue'];
    }

    try {
      const stored = window.localStorage.getItem(inventoryColumnStorageKey);
      if (!stored) {
        return ['name', 'grade', 'category', 'denomination', 'country', 'year', 'purchasePrice', 'currentValue'];
      }

      const parsed = JSON.parse(stored) as InventoryColumn[];
      return Array.isArray(parsed) && parsed.length > 0 ? parsed : ['name', 'grade', 'category', 'denomination', 'country', 'year', 'purchasePrice', 'currentValue'];
    } catch {
      return ['name', 'grade', 'category', 'denomination', 'country', 'year', 'purchasePrice', 'currentValue'];
    }
  }

  private persistInventoryState(): void {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(inventoryStorageKey, JSON.stringify(this.inventory()));
  }

  private persistVisibleColumns(columns: InventoryColumn[]): void {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(inventoryColumnStorageKey, JSON.stringify(columns));
  }
}
