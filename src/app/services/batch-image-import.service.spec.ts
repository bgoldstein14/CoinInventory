import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { BatchImageImportService, MATCH_CHUNK_SIZE } from './batch-image-import.service';
import { ImageMatchingService } from './image-matching.service';
import { ImageDownscaleService } from './image-import/image-downscaler';
import { BatchImageRow, CoinRecord } from '../types/coin.model';

/** The real matcher, a stub downscaler (there is no <canvas> in Node). */
function createService(downscale?: ImageDownscaleService) {
  const injector = Injector.create({
    providers: [
      { provide: ImageMatchingService, useValue: new ImageMatchingService() },
      { provide: ImageDownscaleService, useValue: downscale ?? ({} as ImageDownscaleService) }
    ]
  });
  return runInInjectionContext(injector, () => new BatchImageImportService());
}

function coin(overrides: Partial<CoinRecord>): CoinRecord {
  return {
    id: 'c1', denomination: '', year: '', coinType: '', category: '', country: 'USA',
    grade: '', certCompany: '', certNumber: '', variety: '', mintMark: '',
    composition: '', purchaseDate: '', purchasePrice: 0, currentValue: 0, notes: '',
    imagePaths: [], tags: [], source: 'manual',
    ...overrides
  };
}

function file(name: string, size = 2_500_000): File {
  const f = new File(['x'], name, { type: 'image/jpeg' });
  // File.size is read-only, so redefine it to simulate a big photo.
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

/** A fake encoder that always succeeds, so tests never need a canvas. */
const okEncoder = (f: File) => Promise.resolve({
  dataUrl: `data:image/jpeg;base64,SHRUNK-${f.name}`,
  originalBytes: f.size,
  storedBytes: 250_000
});

describe('BatchImageImportService.buildRows', () => {
  it('matches on file names only - it never reads a single byte', async () => {
    const service = createService();
    const morgan = coin({ id: 'morgan', coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'S' });

    const big = file('1881-S Morgan Dollar - Obverse.jpg', 46 * 1024 * 1024);
    // Spy on every way of getting at the bytes. If matching touched any of
    // them, reading the 4.2 GB share would hang the browser.
    const arrayBuffer = vi.spyOn(big, 'arrayBuffer');
    const slice = vi.spyOn(big, 'slice');
    const text = vi.spyOn(big, 'text');

    const rows = await service.buildRows([big], [morgan]);

    expect(rows).toHaveLength(1);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(slice).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it('starts a confidently matched image selected, and an unmatched one not', async () => {
    const service = createService();
    const merc = coin({ id: 'merc', coinType: 'Mercury', denomination: 'Dime', year: '1945' });

    const rows = await service.buildRows(
      [file('mercury_dime_1945 - Obverse.jpg'), file('Gold Coins.JPG')],
      [merc]
    );

    const matched = rows.find(r => r.fileName.startsWith('mercury'))!;
    expect(matched.selected).toBe(true);
    expect(matched.selectedCoinId).toBe('merc');

    const unmatched = rows.find(r => r.fileName === 'Gold Coins.JPG')!;
    expect(unmatched.selected).toBe(false);
    expect(unmatched.selectedCoinId).toBeNull();
  });

  it('records the side, the variant and the original size on every row', async () => {
    const service = createService();
    const merc = coin({ id: 'merc', coinType: 'Mercury', denomination: 'Dime', year: '1945' });

    const rows = await service.buildRows(
      [file('mercury_dime_1945 - Reverse - Small.jpg', 1234)], [merc]
    );

    expect(rows[0].photo.side).toBe('reverse');
    expect(rows[0].photo.variant).toBe('Small');
    expect(rows[0].photo.isRetake).toBe(true);
    expect(rows[0].sizeBytes).toBe(1234);
  });

  it('creates no thumbnail URLs up front (they are made lazily per coin group)', async () => {
    const service = createService();
    const rows = await service.buildRows([file('a.jpg'), file('b.jpg')], []);
    expect(rows.every(r => r.thumbnailUrl === '')).toBe(true);
  });

  it('matches in chunks and reports progress, so the UI can repaint', async () => {
    const service = createService();
    const files = Array.from({ length: MATCH_CHUNK_SIZE * 2 + 5 }, (_, i) => file(`IMG_${i}.jpg`));
    const seen: number[] = [];

    const rows = await service.buildRows(files, [], done => seen.push(done));

    expect(rows).toHaveLength(files.length);
    expect(seen).toEqual([MATCH_CHUNK_SIZE, MATCH_CHUNK_SIZE * 2, files.length]);
  });
});

describe('BatchImageImportService.groupByCoin', () => {
  it('produces one group per coin with the photos ordered obverse, reverse, label', async () => {
    const service = createService();
    const morgan = coin({ id: 'morgan', coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'S' });

    const rows = await service.buildRows([
      file('1881-S Morgan Dollar - Label.jpg'),
      file('1881-S Morgan Dollar - Reverse.jpg'),
      file('1881-S Morgan Dollar - Obverse.jpg')
    ], [morgan]);

    const groups = service.groupByCoin(rows, () => 'Morgan Dollar 1881-S');

    expect(groups).toHaveLength(1);
    expect(groups[0].coinLabel).toBe('Morgan Dollar 1881-S');
    expect(groups[0].rows.map(r => r.photo.side)).toEqual(['obverse', 'reverse', 'label']);
    expect(groups[0].selectedCount).toBe(3);
  });

  it('leaves unresolved rows out of the groups entirely', async () => {
    const service = createService();
    const rows = await service.buildRows([file('IM000025.JPG')], []);
    expect(service.groupByCoin(rows, () => 'x')).toEqual([]);
  });
});

describe('BatchImageImportService.attachSelected', () => {
  const morgan = coin({ id: 'morgan', coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'S' });

  async function plan() {
    const service = createService();
    const files = [
      file('1881-S Morgan Dollar - Obverse.jpg'),
      file('1881-S Morgan Dollar - Reverse.jpg'),
      file('1881-S Morgan Dollar - Obverse - Small.jpg')
    ];
    const rows = await service.buildRows(files, [morgan]);
    return { service, rows, files: new Map(files.map(f => [f.name, f])) };
  }

  it('writes nothing until it is called - building the plan is read-only', async () => {
    const { rows } = await plan();
    const attach = vi.fn();

    // The plan exists, every row is selected, and yet nothing has been written.
    expect(rows.filter(r => r.selected)).toHaveLength(3);
    expect(attach).not.toHaveBeenCalled();
  });

  it('attaches one merged imagePaths array per coin on confirmation', async () => {
    const { service, rows, files } = await plan();
    const attach = vi.fn();

    const summary = await service.attachSelected(rows, {
      files, inventory: [morgan], attach, encode: okEncoder
    });

    expect(attach).toHaveBeenCalledTimes(1);
    const [coinId, imagePaths] = attach.mock.calls[0];
    expect(coinId).toBe('morgan');
    expect(imagePaths).toHaveLength(3);
    expect(summary.attached).toBe(3);
    expect(summary.coinsTouched).toBe(1);
    expect(summary.failures).toEqual([]);
  });

  it('appends to a coin that already has photos instead of replacing them', async () => {
    const { service, rows, files } = await plan();
    const existing = { ...morgan, imagePaths: ['data:image/jpeg;base64,ALREADY-HERE'] };
    const attach = vi.fn();

    await service.attachSelected(rows, {
      files, inventory: [existing], attach, encode: okEncoder
    });

    const imagePaths = attach.mock.calls[0][1] as string[];
    expect(imagePaths[0]).toBe('data:image/jpeg;base64,ALREADY-HERE');
    expect(imagePaths).toHaveLength(4);
  });

  it('excludes a deselected file from what gets written', async () => {
    const { service, rows, files } = await plan();
    const deselected: BatchImageRow[] = rows.map(r =>
      r.fileName === '1881-S Morgan Dollar - Obverse - Small.jpg' ? { ...r, selected: false } : r
    );
    const attach = vi.fn();

    const summary = await service.attachSelected(deselected, {
      files, inventory: [morgan], attach, encode: okEncoder
    });

    const imagePaths = attach.mock.calls[0][1] as string[];
    expect(imagePaths).toHaveLength(2);
    expect(imagePaths.join('|')).not.toContain('Small');
    expect(summary.attached).toBe(2);
    expect(summary.skipped).toBe(1);
  });

  it('writes nothing at all when every row is deselected', async () => {
    const { service, rows, files } = await plan();
    const attach = vi.fn();

    const summary = await service.attachSelected(
      rows.map(r => ({ ...r, selected: false })),
      { files, inventory: [morgan], attach, encode: okEncoder }
    );

    expect(attach).not.toHaveBeenCalled();
    expect(summary.attached).toBe(0);
    expect(summary.skipped).toBe(3);
  });

  it('keeps going when one file fails, and reports it', async () => {
    const { service, rows, files } = await plan();
    const attach = vi.fn();

    const flaky = (f: File) => f.name.includes('Reverse')
      ? Promise.reject(new Error('Corrupt JPEG marker'))
      : okEncoder(f);

    const summary = await service.attachSelected(rows, {
      files, inventory: [morgan], attach, encode: flaky
    });

    // The two good files still landed.
    expect(summary.attached).toBe(2);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0].fileName).toContain('Reverse');
    expect(summary.failures[0].reason).toBe('Corrupt JPEG marker');
    expect(attach).toHaveBeenCalledTimes(1);
    expect((attach.mock.calls[0][1] as string[])).toHaveLength(2);
  });

  it('reports a lost file handle as a failure rather than throwing', async () => {
    const { service, rows } = await plan();
    const attach = vi.fn();

    const summary = await service.attachSelected(rows, {
      files: new Map(), inventory: [morgan], attach, encode: okEncoder
    });

    expect(summary.attached).toBe(0);
    expect(summary.failures).toHaveLength(3);
    expect(summary.failures[0].reason).toContain('File handle was lost');
    expect(attach).not.toHaveBeenCalled();
  });

  it('reports progress after every file and finishes in the done phase', async () => {
    const { service, rows, files } = await plan();
    const phases: string[] = [];
    const processed: number[] = [];

    await service.attachSelected(rows, {
      files, inventory: [morgan], attach: vi.fn(), encode: okEncoder,
      onProgress: p => { phases.push(p.phase); processed.push(p.processed); }
    });

    expect(processed).toEqual([1, 2, 3, 3]);
    expect(phases.at(-1)).toBe('done');
  });

  it('reports the size win between the originals and what was stored', async () => {
    const { service, rows, files } = await plan();

    const summary = await service.attachSelected(rows, {
      files, inventory: [morgan], attach: vi.fn(), encode: okEncoder
    });

    expect(summary.originalBytes).toBe(3 * 2_500_000);
    expect(summary.storedBytes).toBe(3 * 250_000);
    expect(summary.storedBytes).toBeLessThan(summary.originalBytes);
  });

  it('does not duplicate a photo that is already attached', async () => {
    const { service, rows, files } = await plan();
    const attach = vi.fn();
    // Pretend the obverse was imported on a previous run.
    const existing = {
      ...morgan,
      imagePaths: ['data:image/jpeg;base64,SHRUNK-1881-S Morgan Dollar - Obverse.jpg']
    };

    await service.attachSelected(rows, {
      files, inventory: [existing], attach, encode: okEncoder
    });

    const imagePaths = attach.mock.calls[0][1] as string[];
    expect(new Set(imagePaths).size).toBe(imagePaths.length);
    expect(imagePaths).toHaveLength(3);
  });
});
