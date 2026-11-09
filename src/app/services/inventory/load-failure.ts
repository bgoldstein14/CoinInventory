 /*
 * load-failure.ts — "my data is broken" vs "the app could not show it".
 *
 * WHAT THIS FILE PREVENTS
 *
 * One failure path with one message that names the database produces logs
 * like this:
 *
 *     [INFO]  Retrieved 105 coins
 *     [ERROR] GET /api/coins error | Invalid string length
 *     [ERROR] [frontend] Failed to connect to database | 500 Internal Server Error
 *
 * The database was fine; it had just handed over all 105 coins. `res.json()`
 * was what failed — and the only thing on screen sent the user hunting a
 * connection problem that did not exist.
 *
 * The server now classifies its own failures into three stages and says so
 * in the response body (server/routes/failure-report.ts). This module is
 * what the client does with that, and the requirement it serves is blunt:
 *
 *   A NON-TECHNICAL USER MUST BE ABLE TO TELL "MY DATA IS BROKEN" FROM
 *   "THE APP HAD A PROBLEM SHOWING IT".
 *
 * So the headline names what failed, the second sentence says what is safe —
 * but ONLY when that is actually known — and the technical line
 * ("RangeError: Invalid string length in GET /api/coins") is carried in its
 * own field, available to anyone who wants it and shouted at nobody.
 *
 * WHY A PURE MODULE
 *
 * The suite runs under Node with no jsdom, so a decision taken inside a
 * template or a service method cannot be asserted on. This function is a
 * plain value-in, value-out mapping, which load-failure.spec.ts covers case
 * by case; ConnectionManager just stores what it returns.
 *
 * It is the same rule the rest of the app already follows — pm-reference.ts's
 * "a visible blank beats a silently wrong number" and `computeMeltValue`
 * returning null rather than $0.00 — applied to STATUS. When we do not know,
 * we say we do not know. We never round "unknown" up to "database down".
  */

import { describeHttpError, isHttpErrorResponse } from '../http-utils';

/**
 * Which part of the request failed, as far as the client can tell.
 *
 * 'unknown' is a real, useful answer and must stay reachable: an older
 * backend, a reverse proxy's own 500 page, or a local throw all produce a
 * failure that says nothing about the database. Quietly rounding those to
 * 'connection' is exactly the bug this file exists to stop.
 */
export type LoadFailureStage = 'connection' | 'database' | 'delivery' | 'unknown';

export interface LoadFailure {
  stage: LoadFailureStage;
  /** Banner heading — three or four words, naming the kind of problem. */
  title: string;
  /** Short form for the status bar, where there is no room for a sentence. */
  statusLabel: string;
  /** The sentence the user reads. Never empty. */
  message: string;
  /**
   * TRUE ONLY WHEN WE POSITIVELY KNOW THE STORED DATA IS INTACT — i.e. the
   * server told us it had already read it. False means "we do not know",
   * never "it is damaged".
   */
  dataSafe: boolean;
  /** One technical line, for the person who wants it. Null if there is none. */
  detail: string | null;
}

/** The stage names the server is allowed to use. Anything else is unknown. */
const KNOWN_STAGES = new Set(['connection', 'database', 'delivery']);

/** The body shape routes/db-error-response.ts sends. All fields optional. */
interface ServerErrorBody {
  error?: unknown;
  stage?: unknown;
  detail?: unknown;
}

/** Pull the parsed `{ error, stage, detail }` body off an HttpErrorResponse. */
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
 * Work out which stage a failed coin fetch belongs to.
 *
 * The server's own answer wins, because it is the only party that knows
 * whether the rows came out of the database. The status-code fallbacks exist
 * for the cases where there is no body to read:
 *
 *   status 0   — the request never reached a server at all
 *   status 503 — the agreed code for "database unreachable"
 *
 * Everything else with no stage is 'unknown', on purpose.
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

/**
 * Turn whatever `getCoins()` rejected with into something a person can act
 * on, without claiming anything the error does not support.
 */
export function describeLoadFailure(error: unknown): LoadFailure {
  const stage = stageOf(error);
  const body = serverBody(error);

  // The server's own sentence, when it sent one. For a delivery failure this
  // is already the right words — headline plus reassurance — written by the
  // only party that knew the rows had been read.
  const serverMessage = stringOrNull(body.error);

  // The technical line. Prefer the server's (it names the route and the real
  // exception class); otherwise reduce whatever we caught to one line.
  const detail = stringOrNull(body.detail) ?? stringOrNull(describeHttpError(error));

  if (stage === 'delivery') {
    return {
      stage,
      title: 'Your coins could not be displayed',
      statusLabel: 'Display problem — data is safe',
      message:
        serverMessage ??
        'The coin list could not be sent to the screen. Your data is safe and the database is working — the problem is in sending it, not reading it.',
      // The ONLY branch that may set this. The server set stage 'delivery'
      // precisely because it had the data in its hands when it failed.
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
      // We never got to the database, so we know nothing about the data —
      // not that it is fine, not that it is damaged.
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
    // Deliberately says nothing about WHY. We do not know, and the detail
    // line below is where the evidence lives.
    message:
      serverMessage ?? 'The coin list could not be loaded. Press Retry connection to try again.',
    dataSafe: false,
    detail,
  };
}
