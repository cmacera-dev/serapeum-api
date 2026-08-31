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

/**
 * Last-resort error handler.
 *
 * The real error is logged server-side; the client gets a generic message. Leaking an
 * exception's text is how internal paths, driver versions and query fragments end up in
 * someone else's console.
 *
 * The one exception is a malformed JSON body: `express.json()` raises a `SyntaxError` with
 * a `body` property, and telling the caller their JSON was invalid is genuinely useful and
 * gives nothing away.
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

  console.error('Unhandled error:', err);
  res.status(500).json(errorBody('internal_error', 'An unexpected error occurred.'));
}
