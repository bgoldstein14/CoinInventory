import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { catchError, map, timeout } from 'rxjs/operators';
import {
  CoinRecord,
  Denomination,
  MintMarkOption,
  SpotPrices,
  SpotPriceResult,
  LatestSpotPrices,
  LogEntry
} from '../types/coin.model';
import { CatalogOption } from '../types/catalog-reference';
import {
  DenominationLookupResult,
  IssuerCreationResult,
  IssuerRecord,
  IssuerRemovalResult,
  NewIssuer,
  ReferenceUsageCounts,
} from '../types/reference-data.model';
import { CoinImageRecord } from '../types/coin-image.model';
import {
  BackupDirectoryListing,
  BackupInspection,
  BackupJobStatus,
  BackupSuggestion,
  RestoreResult
} from './backup/backup-messages';
import { describeHttpError, resolveApiBaseUrl, retryTransientFailures } from './http-utils';

// Defined in ./http-utils (so LoggingService can use them without pulling in
// HttpClient); re-exported for existing importers.
export { describeHttpError, resolveApiBaseUrl, retryTransientFailures, isHttpErrorResponse, isRetryableError } from './http-utils';

/**
 * Typed HTTP methods for every backend endpoint. All calls return cold
 * Observables (nothing is sent until subscribed). The base URL comes from
 * `resolveApiBaseUrl()`. Coin writes are wrapped in `retryTransientFailures()`
 * so a brief backend hiccup doesn't lose an edit.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  /** Base URL for all API calls, resolved once (see `resolveApiBaseUrl()`). */
  private readonly baseUrl = resolveApiBaseUrl();

  constructor(private http: HttpClient) {}

  // Coins

  /**
   * Fetches all coins. The records have no `imagePaths` key (absent, not empty):
   * inlining every photo's base64 would exceed V8's maximum string length and
   * fail the whole response. Each coin carries `imageCount`; photos come from
   * `getCoinImages()` and grid thumbnails from `coinThumbnailUrl()`.
   */
  getCoins(): Observable<CoinRecord[]> {
    return this.http.get<CoinRecord[]>(`${this.baseUrl}/api/coins`);
  }

  /** Fetch a single coin by ID. */
  getCoin(id: string): Observable<CoinRecord> {
    return this.http.get<CoinRecord>(`${this.baseUrl}/api/coins/${id}`);
  }

  /** Creates a coin; retries on network/5xx failures. */
  createCoin(coin: Partial<CoinRecord>): Observable<{ id: string }> {
    return this.http
      .post<{ id: string }>(`${this.baseUrl}/api/coins`, coin)
      .pipe(retryTransientFailures());
  }

  /**
   * Updates a coin. `coin` must contain only the changed fields: the backend does
   * a partial update, so a whole record would overwrite untouched fields.
   * InventoryService computes the minimal diff. Retries on network/5xx failures.
   */
  updateCoin(id: string, coin: Partial<CoinRecord>): Observable<void> {
    return this.http
      .put<void>(`${this.baseUrl}/api/coins/${id}`, coin)
      .pipe(retryTransientFailures());
  }

  /** Deletes a coin; retries on network/5xx failures. */
  deleteCoin(id: string): Observable<void> {
    return this.http
      .delete<void>(`${this.baseUrl}/api/coins/${id}`)
      .pipe(retryTransientFailures());
  }

  // Coin images and their original files

  /**
   * Fetches one coin's images: base64 data plus each original file's absolute path
   * on the host (`sourcePath`, null when not recorded). Called lazily when a coin
   * is viewed.
   */
  getCoinImages(coinId: string): Observable<CoinImageRecord[]> {
    return this.http.get<CoinImageRecord[]>(
      `${this.baseUrl}/api/coins/${encodeURIComponent(coinId)}/images`
    );
  }

  /**
   * URL of one coin's main photograph as image bytes, for a grid thumbnail `src`.
   * A URL rather than an Observable so the browser lazy-loads, caches (ETag with
   * `Cache-Control: no-cache`, so changes show at once) and never concatenates
   * images. Use only for coins with `imageCount > 0`; otherwise the endpoint 404s.
   * The id is URL-encoded because coin ids are free text.
   *
   * `revision` is the count of server-confirmed image changes to the coin this
   * session (inventory/coin-thumbnail-revision.ts). A browser never retries a
   * failed image load, and a new photo is shown before its save lands, so a new
   * URL after the save makes the browser fetch it. Revision 0 must stay the bare
   * URL so unchanged coins keep a stable, cacheable URL (see
   * server/routes/coins/thumbnail.ts).
   *
   * @param coinId the coin whose main photograph is wanted
   * @param revision confirmed image-write count; 0 (default) gives the plain URL
   * @returns an absolute, same-origin URL for `src`
   */
  coinThumbnailUrl(coinId: string, revision = 0): string {
    const url = `${this.baseUrl}/api/coins/${encodeURIComponent(coinId)}/thumbnail`;
    return revision > 0 ? `${url}?v=${revision}` : url;
  }

  /**
   * Checks in one request whether original image files still exist; returns a
   * `path -> boolean` map. The server de-duplicates and caps at 500 paths. A POST
   * because long Windows paths are awkward in a query string.
   *
   * @param paths absolute paths to check (max 500)
   */
  checkImagesExist(paths: string[]): Observable<{ results: Record<string, boolean> }> {
    return this.http.post<{ results: Record<string, boolean> }>(
      `${this.baseUrl}/api/images/exists`,
      { paths }
    );
  }

  /**
   * Which original files (`CoinImages.SourcePath`) are already attached to each
   * coin, in one request. The batch image import uses it to skip photos already
   * stored; the browser only holds downscaled `data:` URLs. Carries no image data.
   *
   * @param coinIds coins to ask about (max 500)
   * @returns `{ results: { [coinId]: string[] } }` with an entry for every id; an
   *          empty array means nothing attached
   */
  getCoinImageSourcePaths(coinIds: string[]): Observable<{ results: Record<string, string[]> }> {
    return this.http.post<{ results: Record<string, string[]> }>(
      `${this.baseUrl}/api/coins/image-source-paths`,
      { coinIds }
    );
  }

  /**
   * URL that serves an original full-resolution image through the backend.
   * Browsers silently block navigation from an `http://` page to `file://`, so the
   * server streams the file (`Content-Disposition: inline`) from the same origin.
   * The path is URL-encoded (backslashes, spaces, `&`, `#`).
   *
   * @param sourcePath absolute path of the original file on the host
   * @returns an absolute, same-origin URL for `href`
   */
  imageFileUrl(sourcePath: string): string {
    return `${this.baseUrl}/api/images/file?path=${encodeURIComponent(sourcePath)}`;
  }

  // Denominations

  /** Fetch all available denominations (Quarter, Half Dollar, etc.). */
  getDenominations(): Observable<Denomination[]> {
    return this.http.get<Denomination[]>(`${this.baseUrl}/api/denominations`);
  }

  /** Create a new denomination. */
  createDenomination(d: Partial<Denomination>): Observable<Denomination> {
    return this.http.post<Denomination>(`${this.baseUrl}/api/denominations`, d);
  }

  /** Update an existing denomination. */
  updateDenomination(id: number, d: Partial<Denomination>): Observable<void> {
    return this.http.put<void>(`${this.baseUrl}/api/denominations/${id}`, d);
  }

  /** Delete a denomination. */
  deleteDenomination(id: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/api/denominations/${id}`);
  }

  // Issuers (migration 011, design §4.5a). Used only by the reference-data
  // maintenance screen, which loads them on open, so there is no issuers signal
  // on InventoryService.

  /** Fetches the active issuers with their denomination and coin counts, in picker order. */
  getIssuers(): Observable<IssuerRecord[]> {
    return this.http.get<IssuerRecord[]>(`${this.baseUrl}/api/issuers`);
  }

  /**
   * Creates an issuer, or revives a soft-deleted one with the same name (keeping
   * its id and denominations; see `revived` / `denominationsRestored` in
   * `IssuerCreationResult`). The server answers 409 for a name an active issuer
   * holds and 400 for an ISO code that isn't two letters; both are expected.
   */
  createIssuer(issuer: NewIssuer): Observable<IssuerCreationResult> {
    return this.http.post<IssuerCreationResult>(`${this.baseUrl}/api/issuers`, issuer);
  }

  /** Edits an issuer in place, keeping its id (denominations reference it by id). */
  updateIssuer(id: number, issuer: NewIssuer): Observable<IssuerRecord> {
    return this.http.put<IssuerRecord>(`${this.baseUrl}/api/issuers/${id}`, issuer);
  }

  /**
   * Removes an issuer, cascading to its denominations and their coins' links, in
   * one transaction (soft delete). `Coins.Denomination` text is untouched, so no
   * coin is lost. The response reports what actually happened.
   */
  deleteIssuer(id: number): Observable<IssuerRemovalResult> {
    return this.http.delete<IssuerRemovalResult>(`${this.baseUrl}/api/issuers/${id}`);
  }

  /**
   * Asks which denominations an issuer struck. The app's only outbound request:
   * our server forwards just the name to Wikidata. The issuer form's checkbox
   * must gate this call itself, not the handling of the answer. Never errors:
   * no network, no results and timeouts all return 200 with an `outcome`
   * (see server/routes/lookups/denomination-lookup.ts).
   */
  lookUpDenominations(issuerName: string): Observable<DenominationLookupResult> {
    const name = encodeURIComponent(issuerName);
    return this.http.get<DenominationLookupResult>(`${this.baseUrl}/api/denomination-lookup?name=${name}`);
  }

  /**
   * How many coins use each entry of each reference list, in one request.
   * Counted in SQL so the number shown beside Remove matches what Remove touches.
   */
  getReferenceUsage(): Observable<ReferenceUsageCounts> {
    return this.http.get<ReferenceUsageCounts>(`${this.baseUrl}/api/reference-usage`);
  }

  // Catalogues (Sear, RIC, Hendin, Krause): same shape and soft delete as the
  // other lookup tables.

  /** Fetch the ACTIVE catalogues, in seeded order. */
  getCatalogs(): Observable<CatalogOption[]> {
    return this.http.get<CatalogOption[]>(`${this.baseUrl}/api/catalogs`);
  }

  /** Creates a catalogue the seed didn't include; `name` is required. */
  createCatalog(c: Partial<CatalogOption>): Observable<CatalogOption> {
    return this.http.post<CatalogOption>(`${this.baseUrl}/api/catalogs`, c);
  }

  /** Renames a catalogue or changes its picker position. */
  updateCatalog(id: number, c: Partial<CatalogOption>): Observable<void> {
    return this.http.put<void>(`${this.baseUrl}/api/catalogs/${id}`, c);
  }

  /**
   * Removes a catalogue (soft delete), so attributed coins keep reading
   * "Sear 6819" and the row can be reactivated.
   */
  deleteCatalog(id: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/api/catalogs/${id}`);
  }

  // Mint marks

  /** Fetch all available mint marks (D, S, P, W, etc.). */
  getMintMarks(): Observable<MintMarkOption[]> {
    return this.http.get<MintMarkOption[]>(`${this.baseUrl}/api/mintmarks`);
  }

  /** Create a new mint mark. */
  createMintMark(m: Partial<MintMarkOption>): Observable<MintMarkOption> {
    return this.http.post<MintMarkOption>(`${this.baseUrl}/api/mintmarks`, m);
  }

  /** Update an existing mint mark. */
  updateMintMark(id: number, m: Partial<MintMarkOption>): Observable<void> {
    return this.http.put<void>(`${this.baseUrl}/api/mintmarks/${id}`, m);
  }

  /** Delete a mint mark. */
  deleteMintMark(id: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/api/mintmarks/${id}`);
  }

  // Categories

  /** Fetch all available categories. */
  getCategories(): Observable<string[]> {
    return this.http.get<string[]>(`${this.baseUrl}/api/categories`);
  }

  /** Fetches all canonical metal content values. */
  getMetalContents(): Observable<string[]> {
    return this.http.get<string[]>(`${this.baseUrl}/api/metalcontents`);
  }

  /** Create a new category. */
  createCategory(name: string): Observable<void> {
    return this.http.post<void>(`${this.baseUrl}/api/categories`, { name });
  }

  /** Delete a category. */
  deleteCategory(name: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/api/categories/${name}`);
  }

  // Coin sets

  /** Fetch all available coin sets. */
  getCoinSets(): Observable<string[]> {
    return this.http.get<string[]>(`${this.baseUrl}/api/coin-sets`);
  }

  /** Create a new coin set. */
  createCoinSet(name: string): Observable<void> {
    return this.http.post<void>(`${this.baseUrl}/api/coin-sets`, { name });
  }

  /** Delete a coin set. */
  deleteCoinSet(name: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/api/coin-sets/${name}`);
  }

  // Spot prices

  /** Fetches current spot prices; the backend reads live COMEX/NYMEX futures. */
  fetchSpotPrices(): Observable<SpotPriceResult> {
    return this.http.get<SpotPriceResult>(`${this.baseUrl}/api/spot-prices/fetch`);
  }

  /**
   * Reads the most recently saved spot prices from the SpotPrices history table,
   * so melt values survive a restart without calling the external API.
   * Never 404s: an empty table gives 200 with zero prices and null
   * `source`/`fetchedAt`, so test `fetchedAt` to detect "nothing saved yet".
   */
  getLatestSpotPrices(): Observable<LatestSpotPrices> {
    return this.http.get<LatestSpotPrices>(`${this.baseUrl}/api/spot-prices/latest`);
  }

  /**
   * Saves spot prices. Each call inserts a new history row (POST
   * /api/spot-prices; see server/routes/data/spot-prices.ts), so call only on a
   * deliberate user action. InventoryService.commitSpotPrices() is the only caller.
   *
   * @param prices gold, silver, platinum and copper prices, plus an optional
   *               `source` label (e.g. "COMEX/NYMEX futures via Yahoo Finance", "Manual entry")
   */
  saveSpotPrices(prices: SpotPrices & { source?: string }): Observable<void> {
    return this.http.post<void>(`${this.baseUrl}/api/spot-prices`, prices);
  }

  // Logging

  /** Sends a log entry to the backend (used by LoggingService). */
  postLog(entry: Partial<LogEntry>): Observable<void> {
    return this.http.post<void>(`${this.baseUrl}/api/log`, entry);
  }

  // Health check

  /**
   * Whether the backend is alive, via `GET /api/health` (200 when the server and
   * database are healthy, 503 otherwise). Never errors: emits one boolean, false
   * on timeout (5 s), 503 or network error.
   */
  healthCheck(): Observable<boolean> {
    return this.http.get<{ status: string }>(`${this.baseUrl}/api/health`).pipe(
      timeout(5000),
      map(() => true),
      catchError(() => of(false))
    );
  }

  // App info

  /**
   * The folder the app is installed in on the host machine. Used to prefill the
   * batch image import's base-folder box, since browsers never reveal a picked
   * file's real location (see image-import/source-path.ts): it is a real path on
   * the right machine for the user to edit. Once edited, the user's choice is
   * remembered.
   *
   * Never errors: any failure (including the 5 s timeout) emits '', leaving the box
   * empty, which the import screen handles.
   */
  getAppFolder(): Observable<string> {
    return this.http.get<{ appFolder?: string }>(`${this.baseUrl}/api/app-info`).pipe(
      timeout(5000),
      // An old or proxied backend may omit `appFolder`; never pass undefined to the box.
      map(info => (typeof info?.appFolder === 'string' ? info.appFolder : '')),
      catchError(() => of(''))
    );
  }

  /**
   * The user's Documents folder on the host, the starting value of the image
   * import's folder box. Never errors: any failure emits ''.
   */
  getDocumentsFolder(): Observable<string> {
    return this.http.get<{ documentsFolder?: string }>(`${this.baseUrl}/api/app-info`).pipe(
      timeout(5000),
      map(info => (typeof info?.documentsFolder === 'string' ? info.documentsFolder : '')),
      catchError(() => of(''))
    );
  }

  /*
   * Backup and restore (§16). Unlike `getAppFolder()` and `healthCheck()`, these
   * propagate errors: a swallowed failure could leave the user believing a backup
   * exists, or hide a refused restore. Not wrapped in `retryTransientFailures()`
   * (a retried restore would replace the collection twice).
   */

  /** Where to put a backup and what to call it. Never cached. */
  getBackupSuggestion(): Observable<BackupSuggestion> {
    return this.http.get<BackupSuggestion>(`${this.baseUrl}/api/backup/suggestion`);
  }

  /**
   * The `*.db` files the server can see in a named folder, so the restore box can
   * offer a choice (a browser can't read folders). Read-only (see
   * server/backup/list-db-files.ts). Errors propagate, so a missing folder isn't
   * mistaken for "no backups here".
   */
  listBackupFiles(directory: string): Observable<BackupDirectoryListing> {
    return this.http.get<BackupDirectoryListing>(`${this.baseUrl}/api/backup/files`, {
      params: { directory }
    });
  }

  /** Starts a backup; resolves with the job's opening status (HTTP 202). */
  startBackup(directory: string, fileName: string): Observable<BackupJobStatus> {
    return this.http.post<BackupJobStatus>(`${this.baseUrl}/api/backup/jobs`, {
      directory,
      fileName
    });
  }

  /** How far the backup has got. Polled by BackupRunner. */
  getBackupJob(id: string): Observable<BackupJobStatus> {
    return this.http.get<BackupJobStatus>(
      `${this.baseUrl}/api/backup/jobs/${encodeURIComponent(id)}`
    );
  }

  /** Asks a running backup to stop; it stops at its next batch. */
  cancelBackup(id: string): Observable<{ accepted: boolean }> {
    return this.http.post<{ accepted: boolean }>(
      `${this.baseUrl}/api/backup/jobs/${encodeURIComponent(id)}/cancel`,
      {}
    );
  }

  /**
   * Inspects a backup file without changing anything. Returns 200 even for a file
   * that will be refused, so read `decision.acceptable`, not the status.
   */
  inspectBackup(path: string): Observable<BackupInspection> {
    return this.http.post<BackupInspection>(`${this.baseUrl}/api/restore/inspect`, { path });
  }

  /** Replaces the collection with the backup; the server validates it again first. */
  restoreBackup(path: string): Observable<RestoreResult> {
    return this.http.post<RestoreResult>(`${this.baseUrl}/api/restore`, { path });
  }
}

