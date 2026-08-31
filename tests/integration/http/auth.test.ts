import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import nock from 'nock';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../../../src/app.js';

/**
 * HTTP-level coverage for the authentication gate.
 *
 * The unit tests around `jwtContextProvider` assert that it *throws* `UNAUTHENTICATED`, and it
 * always did — yet the API answered `500 INTERNAL` to every rejected token (#274). Nothing
 * asserted what came back over the wire, so the gap between the two went unnoticed until
 * someone curled the container by hand. These tests close that gap: they drive a real socket
 * and assert the status code and the body, never the thrown error.
 */

const TEST_URL = 'https://abc123xyz.supabase.co';
const TEST_ISSUER = `${TEST_URL}/auth/v1`;
const JWKS_PATH = '/auth/v1/.well-known/jwks.json';

// One route of each kind: they share `requireAuth`, but they do not share a rate limiter,
// and mounting order is the sort of thing that breaks silently.
const PROTECTED_ROUTES = ['/searchMedia', '/orchestratorFlow'] as const;

let privateKey: CryptoKey;
let publicKeyJWK: Record<string, unknown>;
let server: Server;
let baseUrl: string;

async function signToken(
  payload: Record<string, unknown> = { sub: 'user-test-id' },
  expiresIn = '1h',
  key: CryptoKey = privateKey
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
    .setAudience('authenticated')
    .setIssuer(TEST_ISSUER)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
}

/** POSTs to the running app, optionally with an Authorization header. */
async function post(path: string, authHeader?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (authHeader !== undefined) headers['authorization'] = authHeader;
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ data: { query: 'anything', language: 'en' } }),
  });
}

beforeAll(async () => {
  const { privateKey: priv, publicKey: pub } = await generateKeyPair('RS256', {
    extractable: true,
  });
  privateKey = priv as CryptoKey;
  publicKeyJWK = (await exportJWK(pub)) as Record<string, unknown>;
  publicKeyJWK['kid'] = 'test-kid';
  publicKeyJWK['alg'] = 'RS256';
  publicKeyJWK['use'] = 'sig';

  const app = createApp('*');
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', TEST_URL);
  // The app under test is reached over a real socket, so localhost has to stay reachable
  // while every outbound call is blocked.
  nock.disableNetConnect();
  nock.enableNetConnect('127.0.0.1');
  nock(TEST_URL)
    .get(JWKS_PATH)
    .reply(200, { keys: [publicKeyJWK] })
    .persist();
});

afterEach(() => {
  vi.unstubAllEnvs();
  nock.cleanAll();
  nock.enableNetConnect();
});

describe.each(PROTECTED_ROUTES)('POST %s', (route) => {
  it('answers 401 when the Authorization header is missing', async () => {
    const res = await post(route);
    expect(res.status).toBe(401);
  });

  it('answers 401 when the scheme is not Bearer', async () => {
    const res = await post(route, 'Basic dXNlcjpwYXNz');
    expect(res.status).toBe(401);
  });

  it('answers 401 when the token is not a JWT at all', async () => {
    const res = await post(route, 'Bearer zzz');
    expect(res.status).toBe(401);
  });

  it('answers 401 when the signature does not verify', async () => {
    const { privateKey: wrongKey } = await generateKeyPair('RS256', { extractable: true });
    const forged = await signToken({ sub: 'attacker' }, '1h', wrongKey as CryptoKey);
    const res = await post(route, `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  it('answers 401 when the token has expired', async () => {
    const expired = await signToken({ sub: 'user-id' }, '-1s');
    const res = await post(route, `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  it('lets a valid token through the gate', async () => {
    const token = await signToken({ sub: 'user-123', email: 'test@example.com' });
    const res = await post(route, `Bearer ${token}`);

    // What happens downstream depends on flows that are mocked here, so this asserts only
    // that authentication is not what stopped the request.
    expect(res.status).not.toBe(401);
    const bodyText = await res.text();
    expect(bodyText).not.toContain('unauthorized');
  });
});

describe('rejection body', () => {
  it('uses this API’s error shape, not Genkit’s INTERNAL envelope', async () => {
    const res = await post('/searchMedia');

    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toMatchObject({
      status: 'error',
      error: 'unauthorized',
      message: expect.any(String),
      timestamp: expect.any(String),
    });
  });

  it('never reports an authentication failure as a server fault', async () => {
    // The exact regression in #274: a rejected token came back as 500 INTERNAL, which made the
    // client retry with backoff instead of refreshing the session.
    const res = await post('/searchMedia', 'Bearer zzz');

    expect(res.status).not.toBe(500);
    expect(await res.text()).not.toContain('INTERNAL');
  });
});
