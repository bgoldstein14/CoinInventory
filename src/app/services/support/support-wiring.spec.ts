/**
 * support-wiring.spec.ts — the three joins that make the feature reachable.
 *
 * ---- WHY THESE ARE WORTH A TEST ----
 * Every one of them is the kind of thing that is "obviously done" and
 * silently is not. This codebase already has the scar: the batch image
 * import had a modal, a visibility signal and an open/close pair, and
 * nothing ever called openImageImportModal() — so the whole feature was
 * unreachable from the UI and nobody noticed. App.handleImportSelection
 * carries a comment about it.
 *
 *   1. errors the user saw are actually recorded, or the report's "recent
 *      errors" section is permanently empty;
 *   2. the toolbar emits a request, or there is no way in;
 *   3. the shell listens, or the button does nothing.
 */

import 'fake-indexeddb/auto';
import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { describe, it, expect, vi } from 'vitest';

import { App } from '../../app';
import { AppToolbar } from '../../components/app-toolbar/app-toolbar';
import { CsvService } from '../csv.service';
import { GlobalErrorHandler } from '../global-error-handler';
import { LoggingService } from '../logging.service';
import { NotificationService } from '../notification.service';
import { RecentErrorsService } from './recent-errors.service';
import { createTestInventoryService } from '../../testing/test-helpers';

// ---- 1. Errors reach the buffer ----

describe('GlobalErrorHandler feeds the recent-errors buffer', () => {
  function createHandler() {
    const recent = new RecentErrorsService();
    const logging = { error: vi.fn() } as unknown as LoggingService;
    const notifications = { showError: vi.fn() } as unknown as NotificationService;

    const injector = Injector.create({
      providers: [
        { provide: LoggingService, useValue: logging },
        { provide: NotificationService, useValue: notifications },
        { provide: RecentErrorsService, useValue: recent }
      ]
    });

    return {
      handler: runInInjectionContext(injector, () => new GlobalErrorHandler()),
      recent,
      logging,
      notifications
    };
  }

  it('records the error the user saw', () => {
    const { handler, recent } = createHandler();

    handler.handleError(new Error('saving the coin failed'));

    expect(recent.snapshot().map(e => e.message)).toEqual(['saving the coin failed']);
  });

  it('keeps the existing logging and toast behaviour', () => {
    const { handler, logging, notifications } = createHandler();

    handler.handleError(new Error('boom'));

    expect(logging.error).toHaveBeenCalled();
    expect(notifications.showError).toHaveBeenCalledWith('boom');
  });

  it('records a non-Error throw too', () => {
    const { handler, recent } = createHandler();
    handler.handleError('something odd');
    expect(recent.snapshot()).toHaveLength(1);
  });
});

// ---- 2. The toolbar offers a way in ----

describe('AppToolbar', () => {
  it('emits a help request', () => {
    // `input.required()` in a field initializer needs an injection context,
    // so the toolbar cannot simply be `new`-ed the way a plain class can.
    const toolbar = runInInjectionContext(Injector.create({ providers: [] }), () => new AppToolbar());
    const spy = vi.fn();
    toolbar.helpRequested.subscribe(spy);

    toolbar['requestHelp']();

    expect(spy).toHaveBeenCalled();
  });
});

// ---- 3. The shell listens ----

describe('the App shell', () => {
  function createApp(): App {
    const { inv, storage } = createTestInventoryService();
    return new App(storage, inv, new CsvService());
  }

  it('starts with the support dialog closed', () => {
    expect(createApp()['showSupportModal']()).toBe(false);
  });

  it('opens it', () => {
    const app = createApp();
    app['openSupportModal']();
    expect(app['showSupportModal']()).toBe(true);
  });

  it('closes it again', () => {
    const app = createApp();
    app['openSupportModal']();
    app['closeSupportModal']();
    expect(app['showSupportModal']()).toBe(false);
  });
});
