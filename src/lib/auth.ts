import { GenkitError } from 'genkit';
import { jwtVerify, createRemoteJWKSet, errors as joseErrors, type JWTPayload } from 'jose';

// Cache for remote JWKS instances to avoid recreating and fetching on every call
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwksForIssuer(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksCache.get(issuer);
  if (!jwks) {
    const jwksUrl = new URL(`${issuer}/.well-known/jwks.json`);
    jwks = createRemoteJWKSet(jwksUrl);
    jwksCache.set(issuer, jwks);
  }
  return jwks;
}

/**
 * Cryptographically verifies a Supabase JWT.
 * Now strictly supports asymmetric keys (ES256/RS256) via the public JWKS endpoint.
 *
 * @param token - Raw JWT string (without the "Bearer " prefix).
 * @returns The verified JWT payload.
 * @throws {GenkitError} with status UNAUTHENTICATED (→ HTTP 401) if the token
 *   is missing, invalid, expired, or has a bad signature.
 */
export async function verifySupabaseJwt(token: string): Promise<JWTPayload> {
  const supabaseUrl = process.env['SUPABASE_URL'];

  if (!supabaseUrl) {
    throw new GenkitError({
      status: 'INTERNAL',
      message: 'Server misconfiguration: SUPABASE_URL is not set.',
    });
  }

  const issuer = `${supabaseUrl}/auth/v1`;

  try {
    const JWKS = getJwksForIssuer(issuer);

    const result = await jwtVerify(token, JWKS, {
      audience: 'authenticated',
      issuer,
      algorithms: ['RS256', 'ES256'], // Explicitly allow only asymmetric algorithms
    });

    return result.payload;
  } catch (err) {
    if (err instanceof GenkitError) {
      throw err;
    }

    // Classify on jose's taxonomy, not on class names. Every error jose raises about the
    // *token* is a client error, so the default is UNAUTHENTICATED; the only genuine faults
    // are the two infrastructural JWKS failures, which must keep reaching the terminal
    // handler as 500s. An allowlist of names cannot hold this line: `JOSEAlgNotAllowed`
    // (header `alg`), `JOSENotSupported` (header `crit`) and `JWKSNoMatchingKey` (header
    // `kid`) are all chosen by an unauthenticated caller, start with neither 'JWT' nor 'JWS',
    // and so escaped unmapped and came back as 500 — #274 again, by a different route. The
    // three header cases in tests/integration/http/auth.test.ts pin this.
    const isJwksInfrastructureFault =
      err instanceof joseErrors.JWKSTimeout || err instanceof joseErrors.JWKSInvalid;

    if (err instanceof joseErrors.JOSEError && !isJwksInfrastructureFault) {
      throw new GenkitError({
        status: 'UNAUTHENTICATED',
        message: `Unauthorized: ${err.message}`, // Preserve the underlying jose reason
      });
    }

    // Everything else — a JWKS fetch failure, a malformed key set, a network error — is a
    // genuine server fault and propagates outward
    throw err;
  }
}

// Re-export JWTPayload so callers don't need to import jose directly.
export type { JWTPayload };
