/**
 * routes/failure-report.ts — telling three kinds of failure apart.
 *
 * A route catch block that reports every error as "failed to retrieve" lies
 * about the common case where the database handed over every row and then
 * `res.json()` threw (see routes/coins/list-query.ts). The server already
 * knows better — db/errors.ts can tell a dead connection from a bad query —
 * and this module is where that knowledge is turned into what the user is
 * told.
 *
 * THE THREE STAGES
 *   'connection'  We never reached the database. We know nothing about the
 *                 data — not that it is fine, not that it is broken.
 *   'database'    The database answered, and the answer was an error. The
 *                 route's own fallback message describes it.
 *   'delivery'    The rows came OUT of the database and something failed
 *                 afterwards. This is the ONLY stage where we can honestly
 *                 promise the user that their data is intact, because we
 *                 have just had it in our hands.
 *
 * A PURE MODULE, for the same reason db/errors.ts is: the decision "which of
 * three things do we tell the user" must never be wrong, and a pure function
 * of an error plus a flag is the easiest thing in the backend to test
 * exhaustively. Nothing here touches Express, the pool, or the log.
 *
 * The project rule it extends from numbers to STATUS: never state what you do
 * not know. (Compare pm-reference.ts — a visible blank beats a silently wrong
 * number — and computeMeltValue returning null rather than $0.00.)
 */

import { isConnectionError } from '../db';

/** Which part of the request failed. See the three-stage note above. */
export type FailureStage = 'connection' | 'database' | 'delivery';

/**
 * Everything the user and the log need about one failure.
 *
 * `message` and `reassurance` are kept APART rather than pre-joined because
 * the reassurance is the sentence we are only sometimes entitled to say.
 * Splicing it into the message would make it far too easy for a future edit
 * to leak "your data is safe" onto a failure where nobody knows that.
 */
export interface FailureReport {
  stage: FailureStage;
  /** Plain-language headline: what failed, in words a non-technical user reads. */
  message: string;
  /** Second sentence. NON-NULL ONLY FOR 'delivery'. Null means "we do not know". */
  reassurance: string | null;
  /** One short technical line, e.g. 'RangeError: Invalid string length in GET /api/coins'. */
  detail: string;
}

/**
 * The wording for an unreachable database. routes/db-error-response.spec.ts
 * pins the word "unreachable".
 */
const UNREACHABLE_MESSAGE = 'The database is currently unreachable. Please try again in a moment.';

/**
 * The sentence the whole exercise is for. It answers the only question a
 * non-technical user actually has — "is my collection broken?" — before
 * saying anything about what went wrong.
 */
const DELIVERY_REASSURANCE =
  'Your data is safe and the database is working — the problem is in sending it, not reading it.';

/**
 * Error messages that mean "JSON.stringify could not produce a string".
 *
 * Deliberately narrow, for the same reason isConnectionError() is: a FALSE
 * POSITIVE here is the original bug with its sign flipped. It would tell the
 * user "your data is safe and the database is working" at the exact moment
 * the database was telling us it is not. When in doubt, this returns false
 * and the error is reported as a database failure.
 */
const SERIALISATION_MESSAGE_PATTERN =
  /invalid string length|converting circular structure to json|do not know how to serialize/i;

/**
 * Node's own code for "the string you asked for exceeds the maximum length".
 * JSON.stringify throws a bare RangeError with no code, but some paths
 * (Buffer#toString, for one) set this instead — hence both checks.
 */
const STRING_TOO_LONG_CODE = 'ERR_STRING_TOO_LONG';

/**
 * Does this error mean "the data was fine, we just could not turn it into a
 * response"?
 *
 * This is the SNIFFING path, and it is the backstop rather than the main
 * mechanism. The main mechanism is structural: sendJson() knows it is in the
 * sending step because that is all it wraps, and passes `retrieved: true`.
 * This function exists so that a route which has NOT been split that way
 * still reports honestly instead of blaming the database.
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
 * Sort one error into its stage.
 *
 * ORDER MATTERS, and the first rule is the important one:
 *
 *   `retrieved: true` wins over everything, including isConnectionError().
 *   "The rows came out of the database" is a FACT, established before the
 *   error happened, and a connection blip a moment later cannot undo it.
 *   Letting isConnectionError() override it resurrects the original lie in a
 *   subtler form: "cannot connect to database", printed immediately after the
 *   database handed over every row.
 *
 * @param err     - the caught error
 * @param options - `retrieved` is set by callers that KNOW the data was
 *                  already in hand when the error happened (sendJson).
 */
export function failureStageFor(err: unknown, options?: { retrieved?: boolean }): FailureStage {
  if (options?.retrieved) return 'delivery';
  if (isSerialisationFailure(err)) return 'delivery';
  if (isConnectionError(err)) return 'connection';
  return 'database';
}

/**
 * The one technical line: class, message and route.
 *
 * Kept as its own field rather than appended to the sentence the user reads:
 * the detail must be AVAILABLE but NOT SHOUTED. "RangeError: Invalid string
 * length" is exactly what a non-technical user cannot act on and exactly what
 * whoever reads the log needs first.
 */
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
  /**
   * What the user was waiting for, as a noun phrase: 'coin list', 'coin',
   * 'spot price list'. Used only by the delivery wording, which has to name
   * the thing — "the response could not be sent" means nothing to anyone.
   */
  subject: string;
  /** The route's own message, used when the database itself reported a fault. */
  fallbackMessage: string;
  /** True when the data was already retrieved before the error happened. */
  retrieved?: boolean;
}

/**
 * Build the whole report: stage, what to say, what we are entitled to
 * promise, and the technical line.
 */
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

/**
 * The single sentence a client that only reads `{ error }` should see.
 *
 * Old clients (and `describeHttpError()` in the Angular app) look at one
 * field. Joining the two sentences here means they get the reassurance for
 * free, without the server having to guess which fields the caller parses.
 */
export function spokenMessage(report: FailureReport): string {
  return report.reassurance ? `${report.message} ${report.reassurance}` : report.message;
}
