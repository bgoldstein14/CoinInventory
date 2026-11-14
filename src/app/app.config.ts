import { ApplicationConfig, ErrorHandler, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';

import { GlobalErrorHandler } from './services/global-error-handler';

/*
 * NO ROUTER HERE, ON PURPOSE.
 *
 * This app has never had a route. `app.routes.ts` exported an empty array,
 * there is no <router-outlet> in any template and nothing injects Router or
 * ActivatedRoute; every screen is a modal or a panel owned by the shell.
 * `provideRouter([])` was still pulling the whole routing package into the
 * initial bundle to serve it: 79 kB raw, 19 kB over the wire, to route
 * nowhere.
 *
 * `app.routes.ts` went with it: it held `export const routes: Routes = []`
 * and nothing else, and leaving it behind unreferenced made the build warn
 * that it was compiling a file no entry point reaches. The day this app
 * wants a real screen with a URL, it comes back as two lines here:
 *
 *   import { provideRouter } from '@angular/router';
 *   ...  provideRouter([ your routes here ]),
 *
 * `@angular/router` is still a dependency, so that is an edit to this file
 * and nothing else — no install, and no other change anywhere.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(),
    // Global error handler catches unhandled errors and shows a notification
    { provide: ErrorHandler, useClass: GlobalErrorHandler }
  ]
};
