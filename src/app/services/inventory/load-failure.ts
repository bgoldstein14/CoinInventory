 /*
  * Turns a failed coin-list load into a message that separates "my data is
  * broken" from "the app had a problem showing it". The server classifies its
  * failures into stages in the response body (server/routes/failure-report.ts);
  * e.g. the database may return every coin while `res.json()` fails, which must
  * not be reported as a database connection failure.
  *
  * The headline names what failed; the second sentence says the data is safe
  * only when that is known; the technical line ("RangeError: Invalid string
  * length in GET /api/coins") is kept separately in `detail`. "Unknown" is never
  * rounded up to "database down". Pure, so load-failure.spec.ts covers each case.
  */

import { describeHttpError, isHttpErrorResponse } from '../http-utils';

/**
 * Which part of the request failed. 'unknown' must stay reachable: an older
 * backend, a proxy's 500 page or a local throw say nothing about the database.
 */
export type LoadFailureStage = 'connection' | 'database' | 'delivery' | 'unknown';

export interface LoadFailure {
  stage: LoadFailureStage;
  /** Banner heading: a few words naming the kind of problem. */
  title: string;
  /** Short form for the status bar. */
  statusLabel: string;
  /** The sentence the user reads; never empty. */
  message: string;
  /**
   * True only when the server reported it had already read the data. False means
   * "unknown", never "damaged".
   */
  dataSafe: boolean;
  /** One technical line, or null. */
  detail: string | null;
}

/** Stage names the server may use; anything else is unknown. */
const KNOWN_STAGES = new Set(['connection', 'database', 'delivery']);

/** Body shape sent by routes/db-error-response.ts; all fields optional. */
interface ServerErrorBody {
  error?: unknown;
  stage?: unknown;
  detail?: unknown;
}

/** The parsed `{ error, stage, detail }` body of an HttpErrorResponse. */
function serverBody(error: unknown): ServerErrorBody {
  if (!isHttpErrorResponse(error)) return {};
  const body = (error as { error?: unknown }).error;
  if (typeof body !== 'object' || body === null) return {};
  return body as ServerErrorBody;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Which stage a failed coin fetch belongs to. The server's answer wins (only it
 * knows whether the rows were read). Without a body:
 *   status 0    the request never reached a server
 *   status 503  the agreed code for "database unreachable"
 * Anything else is 'unknown'.
 */
function stageOf(error: unknown): LoadFailureStage {
  const stage = serverBody(error).stage;
  if (typeof stage === 'string' && KNOWN_STAGES.has(stage)) {
    return stage as LoadFailureStage;
  }

  if (isHttpErrorResponse(error)) {
    if (error.status === 0) return 'connection';
    if (error.status === 503) return 'connection';
  }

  return 'unknown';
}

/** Wording for a request that never reached a server. */
const NO_SERVER_MESSAGE =
  'Cannot reach the backend server. Check that it is running, then press Retry connection.';

/** Wording for a server that answered "the database is unreachable". */
const NO_DATABASE_MESSAGE =
  'Cannot connect to the database. Check that it is running, then press Retry connection.';

/** Turns a `getCoins()` rejection into an actionable message, claiming nothing the error doesn't support. */
export function describeLoadFailure(error: unknown): LoadFailure {
  const stage = stageOf(error);
  const body = serverBody(error);

  // The server's own sentence when sent (for a delivery failure, already the
  // right headline and reassurance).
  const serverMessage = stringOrNull(body.error);

  // The technical line: the server's (names the route and exception) if present,
  // else the caught error reduced to one line.
  const detail = stringOrNull(body.detail) ?? stringOrNull(describeHttpError(error));

  if (stage === 'delivery') {
    return {
      stage,
      title: 'Your coins could not be displayed',
      statusLabel: 'Display problem — data is safe',
      message:
        serverMessage ??
        'The coin list could not be sent to the screen. Your data is safe and the database is working — the problem is in sending it, not reading it.',
      // The only branch that sets this: stage 'delivery' means the server had the data.
      dataSafe: true,
      detail,
    };
  }

  if (stage === 'connection') {
    const neverReached = isHttpErrorResponse(error) && error.status === 0;
    return {
      stage,
      title: 'Database unavailable',
      statusLabel: 'Database unavailable',
      message: neverReached ? NO_SERVER_MESSAGE : NO_DATABASE_MESSAGE,
      // The database was never reached, so nothing is known about the data.
      dataSafe: false,
      detail,
    };
  }

  if (stage === 'database') {
    return {
      stage,
      title: 'The database reported a problem',
      statusLabel: 'Database error',
      message:
        serverMessage ??
        'The database could not complete the request. Your collection has not been changed.',
      dataSafe: false,
      detail,
    };
  }

  return {
    stage: 'unknown',
    title: 'Your collection could not be loaded',
    statusLabel: 'Could not load',
    // Says nothing about why; the detail line has the evidence.
    message:
      serverMessage ?? 'The coin list could not be loaded. Press Retry connection to try again.',
    dataSafe: false,
    detail,
  };
}
