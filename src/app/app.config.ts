import { ApplicationConfig, ErrorHandler, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';

import { GlobalErrorHandler } from './services/global-error-handler';

/*
 * No router: every screen is a modal or panel owned by the shell, and
 * provideRouter([]) would add the routing package to the bundle for nothing.
 * `@angular/router` is still a dependency if routes are ever needed.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(),
    // Shows a notification for unhandled errors.
    { provide: ErrorHandler, useClass: GlobalErrorHandler }
  ]
};
