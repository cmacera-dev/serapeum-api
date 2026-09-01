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

    // Only map known jose JWT validation errors to UNAUTHENTICATED.
    // Infrastructure/network errors from createRemoteJWKSet will bubble up as 500s.
    if (
      err instanceof joseErrors.JWTClaimValidationFailed ||
      err instanceof joseErrors.JWTExpired ||
      err instanceof joseErrors.JWTInvalid ||
      err instanceof joseErrors.JWSSignatureVerificationFailed ||
      err instanceof joseErrors.JWSInvalid ||
      (err instanceof Error && err.name.startsWith('JWT')) ||
      (err instanceof Error && err.name.startsWith('JWS'))
    ) {
      throw new GenkitError({
        status: 'UNAUTHENTICATED',
        message: `Unauthorized: ${err.message}`, // Preserve the underlying jose reason
      });
    }

    // Unrecognized errors (e.g. network failures for JWKS) propagate outward
    throw err;
  }
}

// Re-export JWTPayload so callers don't need to import jose directly.
export type { JWTPayload };
