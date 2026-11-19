/**
 * Classifies a route failure into one of three stages, so the user is told
 * only what is actually known:
 *
 *   'connection'  never reached the database; nothing is known about the data
 *   'database'    the database returned an error; the route's message applies
 *   'delivery'    rows were retrieved and something failed afterwards (e.g.
 *                 res.json() threw); the only case where we can say the data
 *                 is intact
 *
 * Pure functions, so the decision can be tested exhaustively.
 */

import { isConnectionError } from '../db';

/** Which part of the request failed. */
export type FailureStage = 'connection' | 'database' | 'delivery';

/**
 * Everything the user and the log need about one failure. `reassurance` is
 * separate from `message` so "your data is safe" can't leak onto failures
 * where that isn't known.
 */
export interface FailureReport {
  stage: FailureStage;
  /** Plain-language headline: what failed, in words a non-technical user reads. */
  message: string;
  /** Second sentence; non-null only for 'delivery'. */
  reassurance: string | null;
  /** One short technical line, e.g. 'RangeError: Invalid string length in GET /api/coins'. */
  detail: string;
}

/** Wording for an unreachable database ("unreachable" is pinned by a spec). */
const UNREACHABLE_MESSAGE = 'The database is currently unreachable. Please try again in a moment.';

/** Answers "is my collection broken?" first. */
const DELIVERY_REASSURANCE =
  'Your data is safe and the database is working — the problem is in sending it, not reading it.';

/**
 * Messages meaning JSON.stringify couldn't produce a string. Kept narrow: a
 * false positive would tell the user their data is safe when the database
 * failed.
 */
const SERIALISATION_MESSAGE_PATTERN =
  /invalid string length|converting circular structure to json|do not know how to serialize/i;

/** Node's code for an over-long string; JSON.stringify throws a bare RangeError, other paths set this. */
const STRING_TOO_LONG_CODE = 'ERR_STRING_TOO_LONG';

/**
 * Does this error mean the data was fine but couldn't be serialized? A
 * fallback for routes not using sendJson(), which passes `retrieved: true`.
 */
export function isSerialisationFailure(err: unknown): boolean {
  if (err === null || err === undefined) return false;

  const code = (err as { code?: unknown }).code;
  if (code === STRING_TOO_LONG_CODE) return true;

  const message =
    err instanceof Error ? err.message : typeof err === 'string' ? err : '';

  return message !== '' && SERIALISATION_MESSAGE_PATTERN.test(message);
}

/**
 * Sorts one error into its stage. `retrieved: true` wins over everything,
 * including isConnectionError(): a later connection blip doesn't change the
 * fact the rows were retrieved.
 *
 * @param err     - the caught error
 * @param options - `retrieved` is set by callers that know the data was
 *                  already in hand (sendJson).
 */
export function failureStageFor(err: unknown, options?: { retrieved?: boolean }): FailureStage {
  if (options?.retrieved) return 'delivery';
  if (isSerialisationFailure(err)) return 'delivery';
  if (isConnectionError(err)) return 'connection';
  return 'database';
}

/** One technical line (class, message, route), kept separate from the user-facing sentence. */
export function technicalDetail(err: unknown, context: string): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message} in ${context}`;
  }
  if (typeof err === 'string') {
    return `${err} in ${context}`;
  }
  return `${String(err)} in ${context}`;
}

/** What a route knows about the failure it is reporting. */
export interface FailureContext {
  /** Route label for the log and the detail line, e.g. 'GET /api/coins'. */
  context: string;
  /** What the user was waiting for, e.g. 'coin list'; used in the delivery wording. */
  subject: string;
  /** The route's own message, used when the database itself reported a fault. */
  fallbackMessage: string;
  /** True when the data was already retrieved before the error happened. */
  retrieved?: boolean;
}

/** Builds the full report: stage, message, reassurance and technical line. */
export function buildFailureReport(err: unknown, ctx: FailureContext): FailureReport {
  const stage = failureStageFor(err, { retrieved: ctx.retrieved });
  const detail = technicalDetail(err, ctx.context);

  if (stage === 'delivery') {
    return {
      stage,
      message: `The ${ctx.subject} could not be sent to the screen.`,
      reassurance: DELIVERY_REASSURANCE,
      detail,
    };
  }

  if (stage === 'connection') {
    return { stage, message: UNREACHABLE_MESSAGE, reassurance: null, detail };
  }

  return { stage, message: ctx.fallbackMessage, reassurance: null, detail };
}

/** The single sentence for clients that only read `{ error }` (message plus reassurance). */
export function spokenMessage(report: FailureReport): string {
  return report.reassurance ? `${report.message} ${report.reassurance}` : report.message;
}
