import type { NextFunction, Request, Response } from 'express';
import { GenkitError } from 'genkit';
import type { ContextProvider } from 'genkit/context';
import { verifySupabaseJwt, type JWTPayload } from '../lib/auth.js';
import { errorBody } from './errors.js';

/**
 * Extracts the Bearer token from the Authorization header.
 * Returns `null` if the header is absent or malformed.
 */
function extractBearerToken(headers: Record<string, string | undefined>): string | null {
  const authHeader = headers['authorization'];
  if (!authHeader) return null;

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer') return null;

  return parts[1] ?? null;
}

/**
 * Express gate that answers authentication failures itself, before Genkit sees the request.
 *
 * It has to, because `expressHandler` cannot. Genkit picks the status with `getHttpStatus(e)`,
 * which returns 401 only when the error is `instanceof` *its own* `GenkitError`. Genkit ships
 * a dual build (`lib/index.mjs` for `import`, `lib/index.js` for `require`), so the class this
 * ESM code throws is a different object from the one CommonJS `@genkit-ai/express` compares
 * against. The check silently fails, falls through to the unknown-error branch, and every
 * rejection came back as `500 {"message":"Internal Error","status":"INTERNAL"}` — the server
 * log saying `UNAUTHENTICATED` all the while. That is issue #274.
 *
 * Verifying here fixes it at the layer that owns HTTP status codes anyway: the answer comes
 * back in this API's own JSON shape, and the fix does not depend on Genkit internals that a
 * future release could rearrange.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = extractBearerToken(req.headers as Record<string, string | undefined>);

  if (!token) {
    res.status(401).json(errorBody('unauthorized', 'Missing or malformed Authorization header.'));
    return;
  }

  try {
    await verifySupabaseJwt(token);
    next();
  } catch (err) {
    // Deliberately not logged: a rejected token is an expected client error, and counting it
    // alongside real faults is precisely the monitoring problem #274 describes. Anything else
    // — a missing SUPABASE_URL, a JWKS fetch failure — is a genuine fault, so it goes to the
    // terminal handler, which logs it and answers 500.
    if (err instanceof GenkitError && err.status === 'UNAUTHENTICATED') {
      res.status(401).json(errorBody('unauthorized', 'Invalid or expired token.'));
      return;
    }
    next(err);
  }
}

/**
 * Genkit `contextProvider` that validates incoming Supabase JWTs.
 *
 * `requireAuth` has already accepted the token by the time this runs, so in the normal path
 * this only rebuilds the payload as flow context — available via `getFlowContext()` if a flow
 * ever needs the caller's identity. It re-verifies rather than trusting a decode because that
 * second check is what keeps a route mounted without `requireAuth` from being wide open; the
 * cost is one signature verification against an in-memory JWKS.
 */
export const jwtContextProvider: ContextProvider<JWTPayload> = async ({ headers }) => {
  const token = extractBearerToken(headers as Record<string, string | undefined>);

  if (!token) {
    throw new GenkitError({
      status: 'UNAUTHENTICATED',
      message: 'Unauthorized: missing or malformed Authorization header.',
    });
  }

  return verifySupabaseJwt(token);
};
