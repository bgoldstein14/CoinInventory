/**
 * Tests for CoinImagePathsService: one existence request per coin, no requests
 * when re-selecting a coin, and an unreachable backend leaves existence unknown.
 */
import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { ApiService } from './api.service';
import { LoggingService } from './logging.service';
import { CoinImagePathsService } from './coin-image-paths.service';
import { imageSourcePaths } from './image-source-paths';
import { CoinImageRecord } from '../types/coin-image.model';

const OBVERSE = 'C:\\Pics\\obverse.jpg';
const REVERSE = 'C:\\Pics\\reverse.jpg';
const LABEL = 'C:\\Pics\\label.jpg';

/** Three images for one coin: two present, one that has since been deleted. */
function threeImages(): CoinImageRecord[] {
  return [
    { imageId: 1, imageData: 'data:image/jpeg;base64,AAA', sourcePath: OBVERSE, sortOrder: 0 },
    { imageId: 2, imageData: 'data:image/jpeg;base64,BBB', sourcePath: REVERSE, sortOrder: 1 },
    { imageId: 3, imageData: 'data:image/jpeg;base64,CCC', sourcePath: LABEL, sortOrder: 2 }
  ];
}

/** Stubbed HTTP: `images` is the GET result, `exists` the POST result; either may error. */
function createService(options: {
  images?: unknown;
  exists?: unknown;
} = {}) {
  const getCoinImages = vi.fn(() => (options.images ?? of(threeImages())) as never);
  const checkImagesExist = vi.fn(() => (
    options.exists ?? of({ results: { [OBVERSE]: true, [REVERSE]: true, [LABEL]: false } })
  ) as never);

  const api = {
    getCoinImages,
    checkImagesExist,
    imageFileUrl: (path: string) => `http://localhost:3000/api/images/file?path=${encodeURIComponent(path)}`
  } as unknown as ApiService;

  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as LoggingService;

  const injector = Injector.create({
    providers: [
      { provide: ApiService, useValue: api },
      { provide: LoggingService, useValue: logger }
    ]
  });

  const service = runInInjectionContext(injector, () => new CoinImagePathsService());
  return { service, getCoinImages, checkImagesExist, logger };
}

/** Lets the two chained awaits inside `load()` settle. */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('CoinImagePathsService', () => {
  beforeEach(() => {
    // Module-level singleton: clear it between tests.
    imageSourcePaths.clear();
  });

  it('issues exactly ONE existence request for a coin with several images', async () => {
    const { service, getCoinImages, checkImagesExist } = createService();

    service.ensureLoaded('coin-1');
    await settle();

    expect(getCoinImages).toHaveBeenCalledTimes(1);
    // Three photos, one POST.
    expect(checkImagesExist).toHaveBeenCalledTimes(1);
    expect(checkImagesExist).toHaveBeenCalledWith([OBVERSE, REVERSE, LABEL]);
  });

  it('de-duplicates paths within the one request', async () => {
    // The same file can be the source of two image rows; check it once.
    const duplicated: CoinImageRecord[] = [
      { imageId: 1, imageData: 'data:a', sourcePath: OBVERSE, sortOrder: 0 },
      { imageId: 2, imageData: 'data:b', sourcePath: OBVERSE, sortOrder: 1 }
    ];
    const { service, checkImagesExist } = createService({ images: of(duplicated) });

    service.ensureLoaded('coin-1');
    await settle();

    expect(checkImagesExist).toHaveBeenCalledWith([OBVERSE]);
  });

  it('caches results so re-selecting the same coin issues no requests', async () => {
    const { service, getCoinImages, checkImagesExist } = createService();

    service.ensureLoaded('coin-1');
    await settle();
    service.ensureLoaded('coin-1');
    service.ensureLoaded('coin-1');
    await settle();

    expect(getCoinImages).toHaveBeenCalledTimes(1);
    expect(checkImagesExist).toHaveBeenCalledTimes(1);
    expect(service.existenceOf(OBVERSE)).toBe('present');
    expect(service.existenceOf(LABEL)).toBe('missing');
  });

  it('does not fire twice when two components ask at the same moment', async () => {
    // The detail panel and gallery can both mount in the same tick.
    const { service, getCoinImages } = createService();

    service.ensureLoaded('coin-1');
    service.ensureLoaded('coin-1');
    await settle();

    expect(getCoinImages).toHaveBeenCalledTimes(1);
  });

  it('records the paths it learns, so a present file becomes a link', async () => {
    const { service } = createService();

    service.ensureLoaded('coin-1');
    await settle();

    const view = service.viewFor('data:image/jpeg;base64,AAA');
    expect(view.hasPath).toBe(true);
    expect(view.isLink).toBe(true);
    expect(view.fileUrl).toBe(
      'http://localhost:3000/api/images/file?path=C%3A%5CPics%5Cobverse.jpg'
    );
  });

  it('renders a missing file as non-clickable text that still shows the path', async () => {
    const { service } = createService();

    service.ensureLoaded('coin-1');
    await settle();

    const view = service.viewFor('data:image/jpeg;base64,CCC');
    expect(view.existence).toBe('missing');
    expect(view.isLink).toBe(false);
    expect(view.fileUrl).toBe(null);
    expect(view.displayPath).toBe(LABEL);
  });

  it('leaves existence UNKNOWN when the existence check cannot be reached', async () => {
    const { service, logger } = createService({
      exists: throwError(() => ({ status: 0, statusText: '', error: null }))
    });

    service.ensureLoaded('coin-1');
    await settle();

    // Unknown, not 'missing': the server could not be asked.
    expect(service.existenceOf(OBVERSE)).toBe('unknown');
    expect(service.existenceOf(LABEL)).toBe('unknown');

    // The path was still learned from the GET, so it shows as plain text.
    const view = service.viewFor('data:image/jpeg;base64,AAA');
    expect(view.hasPath).toBe(true);
    expect(view.existence).toBe('unknown');
    expect(view.isLink).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('leaves everything unknown when the whole image fetch fails, and retries later', async () => {
    const { service, getCoinImages } = createService({
      images: throwError(() => ({ status: 0, statusText: '', error: null }))
    });

    service.ensureLoaded('coin-1');
    await settle();

    expect(service.viewFor('data:image/jpeg;base64,AAA').hasPath).toBe(false);

    // The failure is not cached; a later attempt retries.
    service.ensureLoaded('coin-1');
    await settle();
    expect(getCoinImages).toHaveBeenCalledTimes(2);
  });

  it('skips the existence check entirely when no image has a path', async () => {
    const noPaths: CoinImageRecord[] = [
      { imageId: 1, imageData: 'data:a', sourcePath: null, sortOrder: 0 }
    ];
    const { service, checkImagesExist } = createService({ images: of(noPaths) });

    service.ensureLoaded('coin-1');
    await settle();

    expect(checkImagesExist).not.toHaveBeenCalled();
    expect(service.viewFor('data:a').hasPath).toBe(false);
  });

  it('does nothing at all for a null coin id', () => {
    const { service, getCoinImages } = createService();
    service.ensureLoaded(null);
    service.ensureLoaded(undefined);
    expect(getCoinImages).not.toHaveBeenCalled();
  });

  it('reports whether any of a coin\'s photos have a recorded path', async () => {
    const { service } = createService();
    const images = ['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,ZZZ'];

    expect(service.anyPathRecorded(images)).toBe(false);

    service.ensureLoaded('coin-1');
    await settle();

    expect(service.anyPathRecorded(images)).toBe(true);
    expect(service.anyPathRecorded(['data:nothing-known'])).toBe(false);
  });
});
