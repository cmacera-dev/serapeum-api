import type { NextFunction, Request, Response } from 'express';
import { GenkitError } from 'genkit';
import type { ContextProvider } from 'genkit/context';
import { verifySupabaseJwt } from '../lib/auth.js';
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
 * which returns 401 only when the error is `instanceof` *its own* `GenkitError` — and it never
 * is. `@genkit-ai/express` lists `"default": "./lib/index.js"` *ahead* of `"import"` in its
 * export map, and Node resolves conditions in declaration order, so importing it from ESM
 * still loads the CommonJS build, while `genkit` and `@genkit-ai/core` (which list `"import"`
 * first) load their `.mjs`. The class this code throws is therefore never the class that
 * comparison names, whatever the import syntax. The check silently fails, falls through to the
 * unknown-error branch, and every rejection came back as
 * `500 {"message":"Internal Error","status":"INTERNAL"}` — the server log saying
 * `UNAUTHENTICATED` all the while. That is issue #274; `validateFlowInput.ts` answers the same
 * hazard for input schemas.
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
 * What a flow may learn about its caller: the subject claim, and deliberately nothing else.
 *
 * `sub` is not a conservative guess — it is the whole of what this service reads. The only
 * consumer of flow context anywhere in `src/` is `orchestratorFlow.ts`, which does
 * `getContext()?.['sub']` to label a trace, so publishing more claims would widen the blast
 * radius below without a single reader above.
 */
export interface FlowAuthContext {
  sub?: string;
}

/**
 * Genkit `contextProvider` that validates incoming Supabase JWTs.
 *
 * `requireAuth` has already accepted the token by the time this runs, so in the normal path
 * this only republishes the caller's identity as flow context. It re-verifies rather than
 * trusting a decode because that second check is what keeps a route mounted without
 * `requireAuth` from being wide open; the cost is one signature verification against an
 * in-memory JWKS.
 *
 * **It returns a projection, not the payload, because flow context is exported telemetry.**
 * Genkit copies whatever this resolves to onto the action's span: `action.mjs` shallow-copies
 * `options.context`, replaces only top-level keys literally named `auth` or `secrets` with
 * `"<redacted>"`, and JSON-serialises the rest onto the real OTel span attribute
 * `genkit:metadata:context`. A Supabase payload has neither of those keys, and the redaction is
 * shallow as well as name-keyed — a key called `auth` nested inside `user_metadata` survives
 * verbatim. `src/lib/telemetry.ts` then registers a `BatchSpanProcessor` with no attribute
 * filter, and Genkit appends caller processors untouched, so with both `LANGFUSE_*` keys set
 * every claim in the token left for `cloud.langfuse.com` and stayed there for whatever the
 * project's retention is. That was observed, not inferred: an `InMemorySpanExporter` registered
 * through Genkit's own `enableTelemetry` shows the attribute carrying `email`, `phone` and
 * `user_metadata` verbatim.
 *
 * Returning `{ sub }` fixes it at the one place that decides what leaves, rather than asking a
 * third party's redaction to grow a list it has no reason to grow. The projection is here and
 * not in `verifySupabaseJwt`, which stays a general-purpose verifier that `requireAuth` uses for
 * its throw-or-not behaviour alone.
 */
export const jwtContextProvider: ContextProvider<FlowAuthContext> = async ({ headers }) => {
  const token = extractBearerToken(headers as Record<string, string | undefined>);

  if (!token) {
    throw new GenkitError({
      status: 'UNAUTHENTICATED',
      message: 'Unauthorized: missing or malformed Authorization header.',
    });
  }

  const { sub } = await verifySupabaseJwt(token);

  // A token with no `sub` publishes nothing rather than a key whose value is `undefined`:
  // the attribute above is JSON, and an absent claim should read as absent.
  return sub === undefined ? {} : { sub };
};
