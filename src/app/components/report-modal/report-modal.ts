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
// The shared sums, not an inline reduce: they already filter to held coins
// themselves, so this screen cannot drift away from the rest of the app's
// idea of what the collection is worth.
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
 * ReportModal — the "Reports" screen: a summary of the collection on screen,
 * two printable documents, and two CSV exports.
 *
 * DELIBERATELY THIN. Everything that decides what a report CONTAINS lives in
 * ./reports/, as pure functions with their own specs. This class does four
 * things and no more: read the signals, call the builder, hand the result to
 * the renderer, open a print window. The reason is the test runner — the
 * frontend suite runs under Node with NO jsdom, so nothing rendered here can
 * be asserted on and anything decided here would be untested by
 * construction. reports/report-types.ts has the shape of the pipeline.
 *
 * PRINTING, NOT A PDF LIBRARY: the production initial bundle is 752 kB
 * against a 500 kB warning and a 1 MB hard error, pdfmake is about 1.1 MB,
 * and the browser's own print dialog already produces a real PDF through
 * "Save as PDF" on every platform this app ships to. The long version,
 * including what is given up, is in reports/print-window.ts.
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
   * Has the collection actually arrived?
   *
   * Every figure on this screen is computed over `inv.inventory()`, which is
   * an empty array until hydration finishes — rendered then, the screen
   * states with complete confidence that the collection is worth $0.00.
   * `connected()` is what makes the difference knowable: ConnectionManager
   * .hydrate() sets it only once the coin fetch has come back. The wording
   * lives in the pure module features/inventory/collection-zero-state.ts,
   * because nothing decided in a template can be tested without jsdom.
   */
  protected readonly notReadyNotice = computed(() =>
    collectionNotReadyNotice({
      loaded: this.inv.connected(),
      failed: this.inv.connectionError() !== null
    })
  );

  /**
   * The grid's filter/sort state and column visibility.
   *
   * OPTIONAL on purpose. The App shell owns both stores and passes them in,
   * but a report must still be producible without them: the inventory
   * listing then falls back to the whole collection and the default column
   * set rather than refusing to print. It also keeps the component
   * constructible in a spec with nothing but an InventoryService.
   */
  readonly filters = input<InventoryFilterStore | null>(null);
  readonly columns = input<InventoryColumnsStore | null>(null);

  readonly closed = output<void>();
  readonly exportCsvRequested = output<void>();
  readonly exportInsuranceCsvRequested = output<void>();

  /**
   * Include photographs on the insurance schedule?
   *
   * On by default: the photographs are the entire reason this report exists,
   * since a CSV can already carry everything else. A tick-box rather than a
   * fixed behaviour because converting several hundred images takes a few
   * seconds, and somebody checking a figure wants the page now.
   */
  protected readonly includePhotos = signal(true);

  /** Non-null while a report is being built; drives the button's busy state. */
  protected readonly buildingReport = signal<string | null>(null);

  /**
   * Why this uses two different coin lists, and why that is not an oversight.
   *
   * `held` is the collection the user actually possesses — see
   * isHeldInCollection() in types/collection-status.ts, which tests
   * POSSESSION rather than title: `owned` and `for-sale` are held; `wanted`,
   * `ordered` and `sold` are not. Summing the whole inventory instead would
   * fold a want-list coin, entered at the price the collector expects to
   * pay, into the value of a collection he does not own — on the very screen
   * whose other half prints an insurance schedule that leaves it out.
   *
   * THE SOLD FIGURES ARE THE EXCEPTION AND MUST STAY ON `inv`. A sold coin
   * is by definition not held, so computing `sold` from `held` would make
   * the list permanently empty and `totalSold` permanently zero — a
   * plausible figure that is always a lie. Those two answer "what have I
   * sold", not "what do I have".
   */
  protected readonly reportStats = computed(() => {
    const inv = this.inv.inventory();
    const held = heldCoins(inv);
    // Handed the FULL inventory on purpose: these two filter to held coins
    // themselves. Passing `held` would work — heldCoins is idempotent — but
    // it would imply the filtering is this screen's job, and the next caller
    // would copy that.
    const totalCost = sumPurchasePrice(inv);
    const totalValue = sumCurrentValue(inv);
    // Deliberately `inv`, not `held`. See the note above.
    const sold = inv.filter(c => (c.soldPrice ?? 0) > 0);
    const totalSold = sold.reduce((s, c) => s + (c.soldPrice ?? 0), 0);
    // `held` from here down: these describe the collection, and a coin on
    // the want list is not in it.
    const graded = held.filter(c => c.certCompany);
    // coinHasPhotos, not `imagePaths.length`: the list endpoint no longer
    // carries photographs, so that array is absent on every coin the user
    // has not opened. `imageCount` comes with the list and answers this for
    // the whole collection without a single fetch.
    const withImages = held.filter(c => coinHasPhotos(c));
    const byCategory: Record<string, { count: number; value: number }> = {};
    for (const c of held) {
      const cat = c.category || '(none)';
      byCategory[cat] ??= { count: 0, value: 0 };
      byCategory[cat].count++;
      byCategory[cat].value += c.currentValue;
    }
    // KEYED ON WHAT THE GRID SHOWS, not on the raw column: for any coin
    // whose `denominationId` resolves the two are different strings, because
    // the column still says what the import said. This summary sits one
    // click away from the inventory table, so a list naming the same coin
    // differently would read as a second, disagreeing answer.
    // coinDenominationDisplay() is the function the grid cell uses.
    //
    // The '(none)' bucket stays, matching byCategory above. (The statistics
    // chart deliberately does NOT do this -- see composition-breakdown.ts,
    // where a '(none)' bar sorted among real ones by size is a silent lie.
    // Here it is a labelled row in a plain list, read as text rather than as
    // a shape, so that hazard does not arise.)
    //
    // An explicit test against NO_DENOMINATION rather than the `|| '(none)'`
    // idiom byCategory uses, because that idiom would be DEAD CODE here:
    // coinDenominationDisplay() never answers an empty string, it answers
    // the em-dash placeholder.
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
   * The insurance / appraisal schedule.
   *
   * Takes the WHOLE inventory, not the filtered view: a schedule that
   * silently covered only the category the user happened to be looking at
   * would be a dangerous document. buildInsuranceReport() narrows it to the
   * coins actually in the collection, using the same rule as the CSV export,
   * and prints what it dropped.
   */
  protected async printInsuranceReport(): Promise<void> {
    const coins = this.inv.inventory();
    await this.buildAndPrint('insurance', async () => {
      const { images, imageNote } = await this.gatherPhotos(heldCoins(coins));
      return buildInsuranceReport({
        coins,
        generatedAt: new Date(),
        spotPrices: this.inv.spotPrices(),
        // The two lookups a printed cell cannot be produced without: the
        // coin carries `catalogId` and `denominationId`, and the name and
        // the label behind them live here. Omitting either prints a
        // document that quietly disagrees with the screen it came from.
        catalogs: this.inv.catalogs(),
        denominations: this.inv.denominations(),
        images,
        imageNote
      });
    });
  }

  /**
   * The full inventory listing — what is on screen, on paper.
   *
   * No photographs: this is a reference listing, often of the whole
   * collection, and the point of it is being quick to produce and quick to
   * read. The photographs belong on the schedule that needs them.
   */
  protected async printInventoryReport(): Promise<void> {
    const filters = this.filters();
    const coins = filters?.filteredInventory() ?? this.inv.inventory();

    await this.buildAndPrint('inventory', async () => buildInventoryReport({
      coins,
      generatedAt: new Date(),
      spotPrices: this.inv.spotPrices(),
      // See the note on the insurance schedule above. This listing prints
      // whatever columns the user has ticked, and for a collector of
      // ancients the catalogue reference is routinely among them -- often
      // the only thing identifying the coin.
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
   * Build a document, render it and print it.
   *
   * The try/finally around the busy flag matters more than it looks: without
   * it, one failure leaves every report button disabled for the rest of the
   * session with no indication why.
   *
   * A blocked pop-up is reported through the notification service rather than
   * being swallowed. It is the single most likely way this feature fails on a
   * user's machine, and the symptom — a button that does nothing at all — is
   * indistinguishable from a bug.
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

  /**
   * Resolve the photographs for a set of coins, one coin at a time.
   *
   * Every size defence lives in reports/report-images.ts; this is only the
   * wiring that gives it an API client and a canvas. The sequencing is the
   * collector's, not this method's — see collectReportImages for why a
   * Promise.all would be the 150 MB bug.
   */
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
