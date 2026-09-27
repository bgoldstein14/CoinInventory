/**
 * Tests for the import SESSION's half of the path feature: the base-folder box,
 * the live example that stops a wrong folder from being used on 1,700 rows,
 * and the fact that confirming an import really does record the paths.
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

/**
 * A stand-in for ApiService that answers only `getAppFolder()`.
 *
 * That is the only method the session uses it for — asking the backend where
 * the app is installed, so a first-time user's base-folder box starts from a
 * real host path instead of blank. Everything else on ApiService would drag
 * HttpClient (and therefore Angular's XHR backend) into this spec.
 */
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

/**
 * Lets the constructor's fire-and-forget restore finish.
 *
 * Several macrotasks rather than one, because restoring now has two async steps
 * in sequence: read the saved preference out of IndexedDB, and only if that
 * comes back empty, ask the backend for the app's folder. One tick was enough
 * when there was only the storage read.
 */
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
    // Both sources of a starting value are async (IndexedDB, then HTTP), so the
    // box is briefly empty. Nothing can be imported in that window.
    const { session } = createSession(storage);
    expect(session.folder.value()).toBe('');
  });

  it('prefills the APP\'s own folder when nothing has been saved yet', async () => {
    // The requirement: "should always start out from the app folder". It is not
    // where the photos are -- the modal's hint text says so plainly -- but it is
    // a real path on the host with a drive letter that host really has, which is
    // something no hardcoded guess could offer.
    const { session } = createSession(storage, stubApi(of('D:\\CoinInventory')));
    await settle();

    expect(session.folder.value()).toBe('D:\\CoinInventory');
  });

  it('prefers a SAVED folder over the app folder', async () => {
    // The other half: "then memorize subsequent choices as the next base
    // folder". The saved value must win, or the user's setting would be reset
    // to the program folder on every import.
    await saveImportBaseFolder(storage, 'E:\\My Coin Photos');

    const { session } = createSession(storage, stubApi(of('D:\\CoinInventory')));
    await settle();

    expect(session.folder.value()).toBe('E:\\My Coin Photos');
  });

  it('opens with an empty box when the app-info call fails, rather than breaking', async () => {
    // A failing endpoint (backend not rebuilt, server down) must not stop the
    // import screen from working. Empty is a state the screen already explains.
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
    // Awaited so the IndexedDB write has definitely landed before we read it
    // back; in the app this is deliberately fire-and-forget.
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

    // The base folder starts EMPTY (nothing is prefilled any more -- see
    // source-path.ts), so the test supplies the host path the way the user
    // would. A drive letter, because the host keeps the photos on a local drive.
    session.folder.set('D:\\Coin Pictures');
    await selectFiles(session, [pickedFile('a.jpg', 'Business Strikes/a.jpg')]);

    // This is the guard rail: the user sees the finished path BEFORE importing.
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

    // With no saved preference the box starts empty and the warning is showing
    // from the outset. That is the point of not prefilling a guess: the user is
    // told immediately, rather than discovering it after ~1,700 rows have been
    // stamped with a location that does not exist on the host.
    expect(session.folder.missing()).toBe(true);

    session.folder.set('D:\\Coin Pictures');
    expect(session.folder.missing()).toBe(false);

    // Whitespace only is still "missing" -- a path of spaces records nothing.
    session.folder.set('  ');
    expect(session.folder.missing()).toBe(true);
  });

  it('records each imported image\'s source path on confirm', async () => {
    const { session, inv } = createSession(storage);
    await settle();

    // Supply the host folder explicitly -- nothing is prefilled any more.
    session.folder.set('D:\\Coin Pictures');

    // A coin the filename matcher will recognise.
    inv.inventory.set([{
      id: 'coin-1', denomination: 'Dollar', year: '1921', coinType: 'Morgan',
      category: 'Silver', country: 'United States', grade: 'MS64', certCompany: '',
      certNumber: '', variety: '', mintMark: '', composition: '',
      purchaseDate: '', purchasePrice: 0, currentValue: 0, notes: '',
      imagePaths: [], tags: [], source: 'manual'
    }]);

    await selectFiles(session, [
      pickedFile('1921 Morgan Dollar - Obverse.jpg', 'Business Strikes/1921 Morgan Dollar - Obverse.jpg')
    ]);

    // Only proceed if the matcher actually placed the file; otherwise this test
    // would silently assert nothing.
    expect(session.attachCount()).toBe(1);

    await session.applyConfirmedMatches();

    const dataUrl = 'data:image/jpeg;base64,SHRUNK-1921 Morgan Dollar - Obverse.jpg';
    expect(imageSourcePaths.pathFor(dataUrl)).toBe(
      'D:\\Coin Pictures\\Business Strikes\\1921 Morgan Dollar - Obverse.jpg'
    );
    // And the coin's displayed images are still plain data URLs.
    expect(inv.inventory()[0].imagePaths).toEqual([dataUrl]);
  });
});
