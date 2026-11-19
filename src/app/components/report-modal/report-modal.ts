import { Component, computed, inject, input, output, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { coinHasPhotos } from '../../services/coin-photos';
import { InventoryService } from '../../services/inventory.service';
import { collectionNotReadyNotice } from '../../features/inventory/collection-zero-state';
import { NotificationService } from '../../services/notification.service';
import { InventoryColumnsStore } from '../../features/inventory/inventory-columns.store';
import { InventoryFilterStore } from '../../features/inventory/inventory-filter.store';
import { CoinRecord } from '../../types/coin.model';
import { heldCoins } from '../../types/collection-status';
import { coinDenominationDisplay } from '../../types/inventory-columns';
import { NO_DENOMINATION } from '../../services/denominations/denomination-display';
import { sumCurrentValue, sumPurchasePrice } from '../../services/inventory/inventory-metrics';
import { buildInsuranceReport, buildInventoryReport } from './reports/build-report';
import { toReportThumbnail } from './reports/image-thumbnail';
import { openPrintWindow } from './reports/print-window';
import { renderReportHtml } from './reports/report-html';
import {
  collectReportImages,
  describeReportImages,
  makeCoinImageLoader,
  planReportImages
} from './reports/report-images';
import { inventoryReportFields } from './reports/report-fields';
import { describeReportScope } from './reports/report-scope';
import { ReportDocument } from './reports/report-types';

/**
 * The "Reports" screen: a collection summary, two printable documents and two
 * CSV exports. Report content is decided by the pure functions in ./reports/
 * (testable without a DOM); this class only wires signals to them and opens
 * the print window.
 */
@Component({
  selector: 'app-report-modal',
  imports: [DecimalPipe],
  templateUrl: './report-modal.html',
  styleUrl: './report-modal.scss'
})
export class ReportModal {
  private readonly inventoryService = inject(InventoryService);
  private readonly api = inject(ApiService);
  private readonly notifications = inject(NotificationService);

  protected get inv() { return this.inventoryService; }

  /**
   * Notice shown until the collection has loaded, so the screen does not
   * report a $0.00 collection while the inventory is still empty.
   */
  protected readonly notReadyNotice = computed(() =>
    collectionNotReadyNotice({
      loaded: this.inv.connected(),
      failed: this.inv.connectionError() !== null
    })
  );

  /**
   * The grid's filter/sort state and column visibility. Optional: without
   * them the listing falls back to the whole collection and default columns.
   */
  readonly filters = input<InventoryFilterStore | null>(null);
  readonly columns = input<InventoryColumnsStore | null>(null);

  readonly closed = output<void>();
  readonly exportCsvRequested = output<void>();
  readonly exportInsuranceCsvRequested = output<void>();

  /**
   * Include photographs on the insurance schedule. Optional because converting
   * hundreds of images takes a few seconds.
   */
  protected readonly includePhotos = signal(true);

  /** Non-null while a report is being built; drives the button's busy state. */
  protected readonly buildingReport = signal<string | null>(null);

  /**
   * Summary figures for the held collection (owned and for-sale coins). The
   * sold figures use the full inventory, since a sold coin is never held.
   */
  protected readonly reportStats = computed(() => {
    const inv = this.inv.inventory();
    const held = heldCoins(inv);
    // These sums filter to held coins themselves.
    const totalCost = sumPurchasePrice(inv);
    const totalValue = sumCurrentValue(inv);
    const sold = inv.filter(c => (c.soldPrice ?? 0) > 0);
    const totalSold = sold.reduce((s, c) => s + (c.soldPrice ?? 0), 0);
    const graded = held.filter(c => c.certCompany);
    // coinHasPhotos uses `imageCount`, which the list endpoint carries;
    // `imagePaths` is only present on coins that have been opened.
    const withImages = held.filter(c => coinHasPhotos(c));
    const byCategory: Record<string, { count: number; value: number }> = {};
    for (const c of held) {
      const cat = c.category || '(none)';
      byCategory[cat] ??= { count: 0, value: 0 };
      byCategory[cat].count++;
      byCategory[cat].value += c.currentValue;
    }
    // Grouped by the denomination label the grid shows, not the raw column.
    // coinDenominationDisplay() returns the NO_DENOMINATION placeholder, never ''.
    const denominations = this.inv.denominations();
    const byDenomination: Record<string, { count: number; value: number }> = {};
    for (const c of held) {
      const shown = coinDenominationDisplay(c, denominations);
      const denom = shown === NO_DENOMINATION ? '(none)' : shown;
      byDenomination[denom] ??= { count: 0, value: 0 };
      byDenomination[denom].count++;
      byDenomination[denom].value += c.currentValue;
    }
    return {
      totalCoins: held.length, totalCost, totalValue,
      totalProfit: totalValue - totalCost,
      soldCount: sold.length, totalSold,
      gradedCount: graded.length,
      withImagesCount: withImages.length,
      byCategory: Object.entries(byCategory).sort((a, b) => b[1].value - a[1].value),
      byDenomination: Object.entries(byDenomination).sort((a, b) => b[1].value - a[1].value)
    };
  });

  /** How many coins the insurance schedule will actually list. */
  protected readonly insurableCount = computed(() => heldCoins(this.inv.inventory()).length);

  /** How many coins the inventory listing will print, after the user's filters. */
  protected readonly listingCount = computed(
    () => (this.filters()?.filteredInventory() ?? this.inv.inventory()).length
  );

  // --- The two printable reports ---

  /**
   * The insurance / appraisal schedule. Uses the whole inventory, not the
   * filtered view, so the schedule never silently omits coins.
   */
  protected async printInsuranceReport(): Promise<void> {
    const coins = this.inv.inventory();
    await this.buildAndPrint('insurance', async () => {
      const { images, imageNote } = await this.gatherPhotos(heldCoins(coins));
      return buildInsuranceReport({
        coins,
        generatedAt: new Date(),
        spotPrices: this.inv.spotPrices(),
        // Needed to resolve each coin's catalogId and denominationId to labels.
        catalogs: this.inv.catalogs(),
        denominations: this.inv.denominations(),
        images,
        imageNote
      });
    });
  }

  /** The inventory listing as filtered and sorted on screen, without photographs. */
  protected async printInventoryReport(): Promise<void> {
    const filters = this.filters();
    const coins = filters?.filteredInventory() ?? this.inv.inventory();

    await this.buildAndPrint('inventory', async () => buildInventoryReport({
      coins,
      generatedAt: new Date(),
      spotPrices: this.inv.spotPrices(),
      catalogs: this.inv.catalogs(),
      denominations: this.inv.denominations(),
      fields: inventoryReportFields(this.columns()?.visibleInventoryColumns() ?? []),
      scopeNote: filters
        ? describeReportScope({
          searchQuery: filters.searchQuery(),
          category: filters.categoryFilter(),
          coinSet: filters.coinSetFilter(),
          grade: filters.gradeFilter(),
          valueMin: filters.valueMinFilter(),
          valueMax: filters.valueMaxFilter(),
          source: filters.sourceFilter(),
          country: filters.countryFilter(),
          sort: filters.sortState(),
          shown: coins.length,
          total: this.inv.inventory().length
        })
        : null
    }));
  }

  /**
   * Build a document, render it and print it. The finally clears the busy
   * flag so a failure does not leave the report buttons disabled; a blocked
   * pop-up is reported rather than failing silently.
   */
  private async buildAndPrint(label: string, build: () => Promise<ReportDocument>): Promise<void> {
    if (this.buildingReport()) return;
    this.buildingReport.set(label);

    try {
      const outcome = openPrintWindow(renderReportHtml(await build()));
      if (outcome === 'blocked') {
        this.notifications.showWarning(
          'The report could not open a print window. Allow pop-ups for this app and try again.'
        );
      }
    } catch {
      this.notifications.showError('The report could not be produced. Nothing has been changed.');
    } finally {
      this.buildingReport.set(null);
    }
  }

  /** Resolve the photographs for a set of coins (sequenced by collectReportImages). */
  private async gatherPhotos(coins: readonly CoinRecord[]) {
    if (!this.includePhotos()) {
      return { images: undefined, imageNote: 'Photographs were not included in this report.' };
    }

    const plan = planReportImages(coins);
    const collected = await collectReportImages(plan, {
      loadCoinImages: makeCoinImageLoader(coins, async coinId => {
        const records = await firstValueFrom(this.api.getCoinImages(coinId));
        return records.map(record => record.imageData);
      }),
      toThumbnail: toReportThumbnail
    });

    return { images: collected.images, imageNote: describeReportImages(plan, collected) };
  }
}
