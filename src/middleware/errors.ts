/**
 * Terminal handlers for anything the flow routes do not answer themselves.
 *
 * Genkit's `expressHandler` deals with errors raised inside a flow. These cover everything
 * else: an unknown path, a malformed JSON body rejected by `express.json()`, or a throw
 * from middleware. Without them Express falls back to its default handler, which answers
 * with HTML and — outside production — the full stack trace.
 */

import type { NextFunction, Request, Response } from 'express';

/** Shape every non-flow response on this API uses, matching `/health`. */
interface ErrorBody {
  status: 'error';
  error: string;
  message: string;
  timestamp: string;
}

/**
 * Builds that shape. Exported so every handler that answers outside a flow — including
 * `requireAuth`, which rejects before the flow is ever reached — produces the same body.
 */
export function errorBody(error: string, message: string): ErrorBody {
  return { status: 'error', error, message, timestamp: new Date().toISOString() };
}

/** Answers unknown routes as JSON, since every other response on this API is JSON. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json(errorBody('not_found', `No route matches ${req.method} ${req.path}.`));
}

/** Reads a 4xx an error already carries, as Express and body-parser set it. */
function clientErrorStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;

  const candidate = err as { status?: unknown; statusCode?: unknown };
  const status = typeof candidate.status === 'number' ? candidate.status : candidate.statusCode;

  if (typeof status !== 'number' || !Number.isInteger(status)) return undefined;
  return status >= 400 && status <= 499 ? status : undefined;
}

/**
 * Last-resort error handler.
 *
 * The real error is logged server-side; the client gets a generic message. Leaking an
 * exception's text is how internal paths, driver versions and query fragments end up in
 * someone else's console.
 *
 * A malformed JSON body says so, though: `express.json()` raises a `SyntaxError` with a
 * `body` property, and telling the caller their JSON was invalid is genuinely useful and
 * gives nothing away.
 *
 * And an error that already carries a 4xx keeps it. This used to collapse every such error
 * into a 500: a body over the `express.json()` limit raises body-parser's
 * `PayloadTooLargeError` with `status: 413`, and the caller was told the server had broken
 * rather than that their request was too big — the same mistake as #274, one layer up, with
 * the same two costs. The client cannot tell "fix your request" from "retry later", and
 * every oversized body lands in the logs as a server fault.
 */
export function errorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  // Express requires the four-argument shape to recognise this as an error handler, and
  // delegating once headers are sent is the documented way to avoid a double response.
  if (res.headersSent) {
    next(err);
    return;
  }

  const isMalformedJson =
    err instanceof SyntaxError && 'body' in err && (err as { status?: number }).status === 400;

  if (isMalformedJson) {
    res.status(400).json(errorBody('invalid_json', 'Request body is not valid JSON.'));
    return;
  }

  const clientStatus = clientErrorStatus(err);
  if (clientStatus !== undefined) {
    // Still generic: the status is the useful part, and the message is not.
    res.status(clientStatus).json(errorBody('bad_request', 'The request could not be accepted.'));
    return;
  }

  console.error('Unhandled error:', err);
  res.status(500).json(errorBody('internal_error', 'An unexpected error occurred.'));
}
