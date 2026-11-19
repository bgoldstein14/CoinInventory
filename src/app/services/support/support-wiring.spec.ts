/**
 * Checks the wiring that makes "Report a problem" reachable:
 *   1. errors the user saw are recorded in the recent-errors buffer;
 *   2. the toolbar emits a request;
 *   3. the app shell handles it.
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

// 1. Errors reach the buffer

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

// 2. The toolbar offers a way in

describe('AppToolbar', () => {
  it('emits a help request', () => {
    // `input.required()` field initializers need an injection context.
    const toolbar = runInInjectionContext(Injector.create({ providers: [] }), () => new AppToolbar());
    const spy = vi.fn();
    toolbar.helpRequested.subscribe(spy);

    toolbar['requestHelp']();

    expect(spy).toHaveBeenCalled();
  });
});

// 3. The shell listens

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
