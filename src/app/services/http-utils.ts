/**
 * Small, dependency-free HTTP helpers shared by ApiService and LoggingService.
 *
 * WHY THIS FILE EXISTS (and why it is separate from api.service.ts):
 * Importing anything from `api.service.ts` pulls the whole `ApiService` class
 * into the module graph, and that class injects `HttpClient`, which in turn
 * drags Angular's `BrowserXhr` backend in. In unit tests that do not bootstrap
 * the JIT compiler, merely importing that chain fails with
 * "The service 'BrowserXhr' needs to be compiled using the JIT compiler".
 *
 * These helpers have no Angular dependency-injection involvement at all, so
 * any service can import them safely. `api.service.ts` re-exports them for
 * backwards compatibility with existing imports and tests.
 */
import type { HttpErrorResponse } from '@angular/common/http';
import { MonoTypeOperatorFunction, retry, timer } from 'rxjs';

/**
 * Is this thing an Angular `HttpErrorResponse`?
 *
 * Checked structurally (does it have a numeric `status`?) rather than with
 * `instanceof`, so that we don't have to import the class as a runtime value.
 */
export function isHttpErrorResponse(error: unknown): error is HttpErrorResponse {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number'
  );
}

/**
 * Turn an unknown thrown value into a short, human-readable one-line message.
 *
 * WHY THIS EXISTS: Angular rejects failed HTTP calls with an `HttpErrorResponse`
 * object. Doing `JSON.stringify(httpErrorResponse)` produces a giant, mostly
 * useless blob (it contains the whole request/response plumbing) which then
 * ends up in `server/logs/app.log`. This helper pulls out only the three things
 * that actually help you debug: the HTTP status code, the status text, and the
 * server's own `{ error: '...' }` message if it sent one.
 *
 * @param error - Anything caught in a `catch` block or an RxJS error callback
 * @returns A compact string such as `500 Internal Server Error: coin not found`
 */
export function describeHttpError(error: unknown): string {
  // Case 1: a real Angular HTTP error (the common case for API failures).
  if (isHttpErrorResponse(error)) {
    // `error.error` is the parsed response body. Our Express backend sends
    // `{ error: 'some message' }`, so prefer that when it exists.
    const body = error.error as { error?: string } | string | null | undefined;
    const serverMessage =
      typeof body === 'string' ? body : (body?.error ?? undefined);

    // status 0 means the request never reached the server at all
    // (server down, DNS failure, CORS block, offline browser).
    if (error.status === 0) {
      return 'Network error — the backend server did not respond';
    }

    const base = `${error.status} ${error.statusText || 'Error'}`;
    return serverMessage ? `${base}: ${serverMessage}` : base;
  }

  // Case 2: a normal JavaScript Error.
  if (error instanceof Error) {
    return error.message;
  }

  // Case 3: something else entirely (a string, a number, a plain object...).
  // Only here do we fall back to stringifying, and we guard against cycles.
  try {
    return typeof error === 'string' ? error : JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Decide whether a failed request is worth retrying.
 *
 * Retry ONLY for problems that might fix themselves on their own:
 *   - status 0   -> never reached the server (it was restarting, network blip)
 *   - status 408 -> request timeout
 *   - status 429 -> rate limited
 *   - status 5xx -> server-side failure, including 503 Service Unavailable
 *
 * Do NOT retry 4xx errors like 400 (bad payload), 404 (no such coin) or
 * 409 (conflict): those are deterministic. Sending the exact same request
 * again will fail in exactly the same way, so retrying just wastes time
 * and spams the log.
 */
export function isRetryableError(error: unknown): boolean {
  if (!isHttpErrorResponse(error)) {
    // Not an HTTP error (e.g. a timeout from the `timeout()` operator).
    // Treat it as transient — worth one more go.
    return true;
  }
  const status = error.status;
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

/** How many times a failed write is retried before we give up. */
const RETRY_ATTEMPTS = 2;

/** Delay before the first retry, in milliseconds. Doubles each attempt. */
const RETRY_BASE_DELAY_MS = 500;

/**
 * An RxJS operator that retries a failing request a bounded number of times
 * with exponential backoff (500ms, then 1000ms).
 *
 * HOW TO READ THIS (Angular/RxJS primer):
 *   `.pipe(op)` runs the observable's values/errors through `op`.
 *   `retry({ count, delay })` re-subscribes (i.e. re-sends the HTTP request)
 *   when the source errors. The `delay` callback decides *how long* to wait —
 *   returning `timer(ms)` waits, throwing gives up immediately.
 *
 * @returns An operator you can drop into any `.pipe(...)`
 */
export function retryTransientFailures<T>(): MonoTypeOperatorFunction<T> {
  return retry<T>({
    count: RETRY_ATTEMPTS,
    delay: (error, retryIndex) => {
      // Deterministic failure (400/404/409...) — rethrow so the caller sees it
      // right away instead of waiting through pointless retries.
      if (!isRetryableError(error)) {
        throw error;
      }
      // retryIndex is 1 for the first retry, 2 for the second, ...
      // 500ms, then 1000ms.
      const waitMs = RETRY_BASE_DELAY_MS * Math.pow(2, retryIndex - 1);
      return timer(waitMs);
    }
  });
}

/**
 * Work out which server to talk to.
 *
 * Two situations exist for this app:
 *
 *  1. PRODUCTION-ish: the Express backend (port 3000) also serves the built
 *     Angular files. The browser is already on `http://localhost:3000`, so the
 *     API lives at the *same* origin. Using `window.location.origin` also means
 *     it keeps working if you reach the machine by its network name or IP
 *     (e.g. `http://my-pc:3000`) instead of `localhost`.
 *
 *  2. DEVELOPMENT: `ng serve` hosts the UI on port 4200, but the API is still
 *     on port 3000. In that case the origin is the WRONG answer, so we hardcode
 *     the dev backend.
 *
 * We deliberately avoid Angular's `environment.ts` file scaffolding here —
 * this single function is easier to follow and needs no build configuration.
 */
export function resolveApiBaseUrl(): string {
  // The backend's address while running `ng serve`, and the safe fallback for
  // non-browser contexts (unit tests run in Node, where `window` is undefined).
  const developmentBackend = 'http://localhost:3000';

  if (typeof window === 'undefined' || !window.location) {
    return developmentBackend;
  }

  const { origin, port, protocol } = window.location;

  // `file://` pages have an origin of "null" — no server to talk to.
  if (!origin || origin === 'null' || protocol === 'file:') {
    return developmentBackend;
  }

  // Port 4200 is the Angular dev server; the API is elsewhere.
  if (port === '4200') {
    return developmentBackend;
  }

  // Otherwise the page was served by the Express backend: use the same origin.
  return origin;
}
