/**
 * The import session's base-folder box, its live path preview, and recording
 * source paths on confirm.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Observable, of, throwError } from 'rxjs';
import { ApiService } from '../api.service';
import { InventoryService } from '../inventory.service';
import { ImageMatchingService } from '../image-matching.service';
import { BatchImageImportService } from '../batch-image-import.service';
import { ImageDownscaleService } from './image-downscaler';
import { BatchImportSession } from './batch-import-session';
import { saveImportBaseFolder } from './import-base-folder';
import { imageSourcePaths } from '../image-source-paths';
import { StorageService } from '../storage.service';
import { createTestInventoryService } from '../../testing/test-helpers';

/** There is no <canvas> in Node. */
const stubEncoder = (file: File) => Promise.resolve({
  dataUrl: `data:image/jpeg;base64,SHRUNK-${file.name}`,
  originalBytes: file.size,
  storedBytes: 500
});

/** A stand-in for ApiService that answers only `getAppFolder()`. */
function stubApi(appFolder: Observable<string>): ApiService {
  return { getAppFolder: vi.fn(() => appFolder) } as unknown as ApiService;
}

function createSession(storage: StorageService, api?: ApiService) {
  const { inv } = createTestInventoryService();
  const injector = Injector.create({
    providers: [
      { provide: InventoryService, useValue: inv },
      { provide: ImageMatchingService, useClass: ImageMatchingService },
      { provide: ImageDownscaleService, useValue: {} as ImageDownscaleService },
      { provide: BatchImageImportService, useClass: BatchImageImportService }
    ]
  });
  const session = runInInjectionContext(injector, () => new BatchImportSession(
    inv,
    injector.get(ImageMatchingService),
    injector.get(BatchImageImportService),
    storage,
    api
  ));
  session.encoder = stubEncoder;
  return { session, inv };
}

/** A File as a directory picker produces it. */
function pickedFile(name: string, relativePath: string): File {
  const file = new File(['x'], name, { type: 'image/jpeg' });
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
  return file;
}

/** Drives the picker the way the template does. */
function selectFiles(session: BatchImportSession, files: File[]): Promise<void> {
  return session.handleDirectorySelection({ target: { files, value: '' } } as unknown as Event);
}

/** Lets the constructor's fire-and-forget restore finish (several macrotasks). */
const settle = async () => {
  for (let tick = 0; tick < 5; tick++) {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
};

describe('BatchImportSession — base folder', () => {
  let storage: StorageService;

  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    storage = new StorageService();
    imageSourcePaths.clear();
  });

  afterEach(() => imageSourcePaths.clear());

  it('starts empty before the asynchronous restore has finished', () => {
    const { session } = createSession(storage);
    expect(session.folder.value()).toBe('');
  });

  // The app's install folder is never a correct default; see
  // import-base-folder.ts.
  it('stays empty when nothing has been saved, rather than guessing', async () => {
    const { session } = createSession(storage, stubApi(of('D:\\CoinInventory')));
    await settle();

    expect(session.folder.value()).toBe('');
  });

  it('prefers a SAVED folder over the app folder', async () => {
    await saveImportBaseFolder(storage, 'E:\\My Coin Photos');

    const { session } = createSession(storage, stubApi(of('D:\\CoinInventory')));
    await settle();

    expect(session.folder.value()).toBe('E:\\My Coin Photos');
  });

  it('opens with an empty box when the app-info call fails, rather than breaking', async () => {
    const { session } = createSession(
      storage,
      stubApi(throwError(() => new Error('backend unreachable')))
    );
    await settle();

    expect(session.folder.value()).toBe('');
    expect(session.folder.missing()).toBe(true);
  });

  it('persists an edited base folder and reloads it in the next session', async () => {
    const { session } = createSession(storage);
    // Awaited here; fire-and-forget in the app.
    await session.folder.set('D:\\Coins\\Photos');

    // A brand new session, as if the modal had been closed and reopened.
    const { session: reopened } = createSession(storage);
    await reopened.folder.restore();

    expect(reopened.folder.value()).toBe('D:\\Coins\\Photos');
  });

  it('restores a previously saved folder on construction', async () => {
    await saveImportBaseFolder(storage, '\\\\nas\\Coins');

    const { session } = createSession(storage);
    await settle();

    expect(session.folder.value()).toBe('\\\\nas\\Coins');
  });

  it('shows a live example built from the first selected file', async () => {
    const { session } = createSession(storage);
    await settle();

    // Nothing selected yet, so nothing to preview.
    expect(session.folder.preview()).toBe(null);

    session.folder.set('D:\\Coin Pictures');
    await selectFiles(session, [pickedFile('a.jpg', 'Business Strikes/a.jpg')]);

    expect(session.folder.preview())
      .toBe('D:\\Coin Pictures\\Business Strikes\\a.jpg');
  });

  it('updates the example as the base folder is edited', async () => {
    const { session } = createSession(storage);
    await selectFiles(session, [pickedFile('a.jpg', 'Proofs/a.jpg')]);

    session.folder.set('C:\\Elsewhere');
    expect(session.folder.preview()).toBe('C:\\Elsewhere\\Proofs\\a.jpg');
  });

  it('flags an empty base folder, because nothing can then be recorded', async () => {
    const { session } = createSession(storage);
    await settle();

    expect(session.folder.missing()).toBe(true);

    session.folder.set('D:\\Coin Pictures');
    expect(session.folder.missing()).toBe(false);

    // Whitespace only is still missing.
    session.folder.set('  ');
    expect(session.folder.missing()).toBe(true);
  });

  it('records each imported image\'s source path on confirm', async () => {
    const { session, inv } = createSession(storage);
    await settle();

    session.folder.set('D:\\Coin Pictures');

    // A coin the filename matcher will recognise.
    inv.inventory.set([{
      id: 'coin-1', denomination: 'Dollar', year: '1921', coinType: 'Morgan',
      category: 'Silver', country: 'United States', grade: 'MS64', certCompany: '',
      certNumber: '', variety: '', mintMark: '', composition: '',
      purchaseDate: '', purchasePrice: 0, currentValue: 0, notes: '',
      imagePaths: [], source: 'manual'
    }]);

    await selectFiles(session, [
      pickedFile('1921 Morgan Dollar - Obverse.jpg', 'Business Strikes/1921 Morgan Dollar - Obverse.jpg')
    ]);

    // Guard against asserting nothing.
    expect(session.attachCount()).toBe(1);

    await session.applyConfirmedMatches();

    const dataUrl = 'data:image/jpeg;base64,SHRUNK-1921 Morgan Dollar - Obverse.jpg';
    expect(imageSourcePaths.pathFor(dataUrl)).toBe(
      'D:\\Coin Pictures\\Business Strikes\\1921 Morgan Dollar - Obverse.jpg'
    );
    // Displayed images are still plain data URLs.
    expect(inv.inventory()[0].imagePaths).toEqual([dataUrl]);
  });
});
