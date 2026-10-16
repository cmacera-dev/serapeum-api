/**
 * One-line, credential-free summaries of a rejected upstream call, for logging.
 *
 * The flows used to log the error object itself — `inspect(error, { depth: null })`, or
 * `console.error('SearchMedia failed:', reason)`, which inspects at the default depth. Both
 * print a provider key in clear text, because the tools pass `api_key` / `key` as axios
 * params and keep the `AxiosError` as `Error.cause`:
 *
 *   - at full depth, `cause.config.params` holds the key as its own enumerable property;
 *   - at the default depth it still escapes through primitive own properties of
 *     `cause.request` — `_currentUrl` on follow-redirects' request for a network error,
 *     `_header` and `path` on the native `ClientRequest` for a status error — each the full
 *     request line with the query string.
 *
 * `AxiosError.toJSON()` can redact, but `util.inspect` never calls it, and moving the
 * credential into an `Authorization` header would not help either: `_header` prints the
 * request headers too. The only thing that holds is to never hand the error object to a
 * formatter. So this walks the `cause` chain and keeps message, `name`, `code` and HTTP
 * status — enough to tell a 401 from a timeout from a bad gateway, which is what the logs
 * were being read for.
 */

/** Depth guard: `cause` chains are short in practice, and a cycle must not hang a log call. */
const MAX_CAUSE_DEPTH = 5;

interface ErrorLike {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  status?: unknown;
  cause?: unknown;
  response?: { status?: unknown };
}

function describeOne(error: unknown): string {
  if (typeof error !== 'object' || error === null) return String(error);

  const candidate = error as ErrorLike;
  const name = typeof candidate.name === 'string' ? candidate.name : 'Error';
  const message = typeof candidate.message === 'string' ? candidate.message : '';

  const details: string[] = [];
  if (typeof candidate.code === 'string') details.push(`code=${candidate.code}`);

  const status =
    typeof candidate.response?.status === 'number'
      ? candidate.response.status
      : typeof candidate.status === 'number'
        ? candidate.status
        : undefined;
  if (status !== undefined) details.push(`status=${status}`);

  const head = message === '' ? name : `${name}: ${message}`;
  return details.length === 0 ? head : `${head} (${details.join(', ')})`;
}

/**
 * Renders an error and its `cause` chain as a single line, with no object graph in it.
 *
 * Use this anywhere a rejected upstream call is logged. Never log the error object.
 */
export function summarizeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;

  for (
    let depth = 0;
    depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null;
    depth++
  ) {
    parts.push(describeOne(current));

    const next = (current as ErrorLike).cause;
    if (next === current) break;
    current = next;
  }

  return parts.join(' <- caused by ');
}
