/**
 * Dependency-free HTTP helpers shared by ApiService and LoggingService.
 * Kept apart from api.service.ts so importing them doesn't pull in HttpClient,
 * which fails in unit tests without the JIT compiler. api.service.ts re-exports them.
 */
import type { HttpErrorResponse } from '@angular/common/http';
import { MonoTypeOperatorFunction, retry, timer } from 'rxjs';

/** Structural check (numeric `status`) so the class needn't be imported at runtime. */
export function isHttpErrorResponse(error: unknown): error is HttpErrorResponse {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number'
  );
}

/**
 * Turns a thrown value into a short one-line message, e.g.
 * `500 Internal Server Error: coin not found`. Avoids logging the whole
 * serialized HttpErrorResponse.
 */
export function describeHttpError(error: unknown): string {
  if (isHttpErrorResponse(error)) {
    // The backend sends `{ error: 'message' }`; prefer that when present.
    const body = error.error as { error?: string } | string | null | undefined;
    const serverMessage =
      typeof body === 'string' ? body : (body?.error ?? undefined);

    // Status 0: the request never reached the server (down, offline, CORS).
    if (error.status === 0) {
      return 'Network error — the backend server did not respond';
    }

    const base = `${error.status} ${error.statusText || 'Error'}`;
    return serverMessage ? `${base}: ${serverMessage}` : base;
  }

  if (error instanceof Error) {
    return error.message;
  }

  // Anything else: stringify, guarding against cycles.
  try {
    return typeof error === 'string' ? error : JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Retry only transient failures: status 0, 408, 429 and 5xx. Other 4xx errors
 * are deterministic and would fail the same way again.
 */
export function isRetryableError(error: unknown): boolean {
  if (!isHttpErrorResponse(error)) {
    // Not an HTTP error (e.g. from the `timeout()` operator): treat as transient.
    return true;
  }
  const status = error.status;
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

/** How many times a failed write is retried before we give up. */
const RETRY_ATTEMPTS = 2;

/** Delay before the first retry, in ms; doubles each attempt. */
const RETRY_BASE_DELAY_MS = 500;

/** RxJS operator that retries transient failures with exponential backoff (500ms, 1000ms). */
export function retryTransientFailures<T>(): MonoTypeOperatorFunction<T> {
  return retry<T>({
    count: RETRY_ATTEMPTS,
    delay: (error, retryIndex) => {
      if (!isRetryableError(error)) {
        throw error;
      }
      // retryIndex starts at 1.
      const waitMs = RETRY_BASE_DELAY_MS * Math.pow(2, retryIndex - 1);
      return timer(waitMs);
    }
  });
}

/**
 * Base URL of the API. When the Express backend serves the app, use the page's
 * own origin (works by hostname or IP too). Under `ng serve` (port 4200), or
 * outside a browser, use the dev backend on port 3000.
 */
export function resolveApiBaseUrl(): string {
  // Also the fallback outside a browser (unit tests run in Node).
  const developmentBackend = 'http://localhost:3000';

  if (typeof window === 'undefined' || !window.location) {
    return developmentBackend;
  }

  const { origin, port, protocol } = window.location;

  // `file://` pages have origin "null".
  if (!origin || origin === 'null' || protocol === 'file:') {
    return developmentBackend;
  }

  if (port === '4200') {
    return developmentBackend;
  }

  return origin;
}
