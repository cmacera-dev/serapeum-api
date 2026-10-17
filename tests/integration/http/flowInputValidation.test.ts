import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import nock from 'nock';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../../../src/app.js';

/**
 * HTTP-level coverage for the input-schema gate.
 *
 * Every flow route used to answer a body its schema refused with
 * `500 {"message":"Internal Error","status":"INTERNAL"}`, and log it as a fault — the second
 * half of #274, reached one layer deeper than authentication. The unit tests around these
 * schemas were green throughout, because what they assert is the schema, never the status
 * code that came back. So these drive a real socket.
 *
 * What this file CANNOT assert is the other half of the invariant: that a genuine fault still
 * answers 500 and still gets logged. That needs a flow body to actually run, and under vitest
 * `ai.defineFlow` is mocked down to the implementation function with no `run`, so Genkit
 * cannot dispatch at all. `tests/e2e/flowInputValidation.ts` covers it under plain tsx.
 */

const TEST_URL = 'https://abc123xyz.supabase.co';
const TEST_ISSUER = `${TEST_URL}/auth/v1`;
const JWKS_PATH = '/auth/v1/.well-known/jwks.json';

/**
 * One body per route that the route's own schema rejects, and the field the 400 must name.
 * All nine are listed on purpose: the defect was uniform across them, and a route mounted
 * without the gate is exactly the regression this is here to catch.
 */
const REJECTED: ReadonlyArray<readonly [route: string, data: unknown, field: string]> = [
  ['/searchMedia', { query: '', language: 'en' }, 'query'],
  ['/searchBooks', { query: '' }, 'query'],
  ['/searchGames', { query: '' }, 'query'],
  ['/getMovieDetail', { id: -1 }, 'id'],
  ['/getTvDetail', { id: 'not-a-number' }, 'id'],
  ['/feedback', { traceId: 't', score: 1, comment: 'x'.repeat(2001) }, 'comment'],
  ['/searchAll', { query: '' }, 'query'],
  ['/searchWeb', { query: 'dune', searchDepth: 'exhaustive' }, 'searchDepth'],
  ['/orchestratorFlow', { query: 42 }, 'query'],
];

let privateKey: CryptoKey;
let publicKeyJWK: Record<string, unknown>;
let server: Server;
let baseUrl: string;
let token: string;

async function post(route: string, data: unknown): Promise<Response> {
  return fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ data }),
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

  token = await new SignJWT({ sub: 'user-input-validation' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
    .setAudience('authenticated')
    .setIssuer(TEST_ISSUER)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);

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

describe.each(REJECTED)('POST %s with a body the schema rejects', (route, data, field) => {
  it('answers 400, not 500', async () => {
    const res = await post(route, data);
    expect(res.status).toBe(400);
  });

  it("answers in this API's own error shape, naming the offending field", async () => {
    const res = await post(route, data);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toMatchObject({ status: 'error', error: 'invalid_input' });
    expect(body['message']).toContain(field);
    expect(typeof body['timestamp']).toBe('string');
    // Genkit's own envelope is what used to come back. Nothing should resemble it.
    expect(body).not.toHaveProperty('status', 'INTERNAL');
  });

  it('writes nothing to the fault log', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await post(route, data);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the gate does not reject what the schema accepts', () => {
  // A body every optional-with-default field is allowed to omit. The flow itself cannot run
  // under vitest, so this asserts only that the gate let it past: anything but 400 means the
  // request reached Genkit, which is the whole claim.
  it('lets a valid body through to the flow handler', async () => {
    const res = await post('/searchMedia', { query: 'dune' });
    expect(res.status).not.toBe(400);
  });

  it('still answers 404 in JSON for a route that does not exist', async () => {
    const res = await post('/searchComics', { query: 'dune' });
    expect(res.status).toBe(404);
  });
});
