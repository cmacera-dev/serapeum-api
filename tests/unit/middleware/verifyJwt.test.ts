import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GenkitError } from 'genkit';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import nock from 'nock';
import { jwtContextProvider } from '../../../src/middleware/verifyJwt.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_URL = 'https://abc123xyz.supabase.co';
const TEST_ISSUER = `${TEST_URL}/auth/v1`;
const JWKS_PATH = '/auth/v1/.well-known/jwks.json';

// Typed as CryptoKey, matching tests/integration/http/auth.test.ts. These were `any` with a
// comment about jose KeyLike, which no longer applies: generateKeyPair resolves to CryptoKey, and
// eslint rejects the `any` as soon as anything else in this file is staged.
let privateKey: CryptoKey;
let publicKeyJWK: Record<string, unknown>;

/**
 * Generates a test RSA key pair for signing and JWKS mocking.
 */
async function ensureKeys(): Promise<void> {
  if (privateKey) return;
  const { privateKey: priv, publicKey: pub } = await generateKeyPair('RS256', {
    extractable: true,
  });
  privateKey = priv as CryptoKey;
  publicKeyJWK = (await exportJWK(pub)) as Record<string, unknown>;
  publicKeyJWK['kid'] = 'test-kid';
  publicKeyJWK['alg'] = 'RS256';
  publicKeyJWK['use'] = 'sig';
}

/**
 * Creates a signed RS256 JWT using the test private key.
 * Defaults to a 1-hour expiry so it is valid by default.
 */
async function signToken(
  payload: Record<string, unknown> = { sub: 'user-test-id' },
  expiresIn = '1h'
): Promise<string> {
  await ensureKeys();
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
    .setAudience('authenticated')
    .setIssuer(TEST_ISSUER)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(privateKey);
}

/**
 * Builds a fake contextProvider argument as Genkit would provide it.
 */
function makeContext(authHeader?: string): {
  method: 'POST';
  headers: Record<string, string>;
  input: unknown;
} {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (authHeader !== undefined) {
    headers['authorization'] = authHeader;
  }
  return { method: 'POST', headers, input: {} };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('jwtContextProvider', () => {
  beforeEach(async () => {
    await ensureKeys();
    vi.stubEnv('SUPABASE_URL', TEST_URL);

    // Disable real network calls for tests
    nock.disableNetConnect();

    // Mock the JWKS endpoint
    nock(TEST_URL)
      .get(JWKS_PATH)
      .reply(200, {
        keys: [publicKeyJWK],
      })
      .persist();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it('throws UNAUTHENTICATED when there is no Authorization header', async () => {
    const result = jwtContextProvider(makeContext());
    await expect(result).rejects.toBeInstanceOf(GenkitError);
    await expect(result).rejects.toMatchObject({
      status: 'UNAUTHENTICATED',
    });
  });

  it('throws UNAUTHENTICATED when the Authorization scheme is not Bearer', async () => {
    const result = jwtContextProvider(makeContext('Basic dXNlcjpwYXNz'));
    await expect(result).rejects.toBeInstanceOf(GenkitError);
    await expect(result).rejects.toMatchObject({
      status: 'UNAUTHENTICATED',
    });
  });

  it('throws UNAUTHENTICATED when the token has an invalid signature', async () => {
    // Sign with a *different* key
    const { privateKey: wrongKey } = await generateKeyPair('RS256');
    const badToken = await new SignJWT({ sub: 'attacker' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setAudience('authenticated')
      .setIssuer(TEST_ISSUER)
      .setExpirationTime('1h')
      .sign(wrongKey);

    const result = jwtContextProvider(makeContext(`Bearer ${badToken}`));
    await expect(result).rejects.toBeInstanceOf(GenkitError);
    await expect(result).rejects.toMatchObject({
      status: 'UNAUTHENTICATED',
    });
  });

  it('throws UNAUTHENTICATED when the token is expired', async () => {
    const expiredToken = await signToken({ sub: 'user-id' }, '-1s');

    const result = jwtContextProvider(makeContext(`Bearer ${expiredToken}`));
    await expect(result).rejects.toBeInstanceOf(GenkitError);
    await expect(result).rejects.toMatchObject({
      status: 'UNAUTHENTICATED',
    });
  });

  it('publishes the sub claim when the token is valid', async () => {
    const token = await signToken({ sub: 'user-123' });

    const context = await jwtContextProvider(makeContext(`Bearer ${token}`));

    expect(context).toEqual({ sub: 'user-123' });
  });

  /**
   * Flow context is exported telemetry, not a scratch object. Genkit shallow-copies whatever the
   * provider resolves to onto the span attribute `genkit:metadata:context`, redacting only
   * top-level keys literally named `auth` or `secrets` — so anything published here reaches
   * Langfuse verbatim whenever both LANGFUSE_* keys are set. `toEqual` rather than `toMatchObject`
   * is the whole point of these: the claim is about what is ABSENT, and `toMatchObject` would
   * pass while every one of these fields leaked.
   */
  it('publishes no claim other than sub, whatever else the token carries', async () => {
    const token = await signToken({
      sub: 'user-123',
      email: 'test@example.com',
      phone: '+10000000000',
      user_metadata: { full_name: 'Test Person' },
      app_metadata: { provider: 'email' },
      session_id: 'session-abc',
    });

    const context = await jwtContextProvider(makeContext(`Bearer ${token}`));

    expect(context).toEqual({ sub: 'user-123' });
    expect(Object.keys(context)).toEqual(['sub']);
  });

  it('redacts nothing by name, because it publishes nothing by default', async () => {
    // Genkit's own redaction is name-keyed AND shallow: a key called `auth` nested inside
    // another claim survives it. The projection makes that irrelevant rather than relying on it.
    const token = await signToken({
      sub: 'user-123',
      user_metadata: { auth: 'nested-marker', secrets: 'nested-marker' },
    });

    const context = await jwtContextProvider(makeContext(`Bearer ${token}`));

    expect(JSON.stringify(context)).not.toContain('nested-marker');
  });

  it('publishes an empty context when the token carries no sub', async () => {
    // Supabase always issues one, so this is about not writing a key whose value is `undefined`
    // into an attribute that is serialised as JSON.
    const token = await signToken({ email: 'test@example.com' });

    const context = await jwtContextProvider(makeContext(`Bearer ${token}`));

    expect(context).toEqual({});
  });
});
