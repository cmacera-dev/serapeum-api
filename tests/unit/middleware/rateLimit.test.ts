import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';

/**
 * Builds a JWT-shaped token carrying `sub`. The signature is nonsense on purpose: the
 * limiter decodes without verifying, and these tests are about bucketing, not auth.
 */
function tokenFor(sub: string): string {
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ sub })}.not-a-real-signature`;
}

interface Harness {
  origin: string;
  close: () => Promise<void>;
}

/**
 * Loads the limiter module fresh with the given env, so each test gets its own thresholds
 * and its own empty counters. The limits are read at module load, hence `resetModules`.
 */
async function harness(
  env: Record<string, string>,
  mount: (
    app: express.Express,
    limiters: typeof import('../../../src/middleware/rateLimit.js')
  ) => void
): Promise<Harness> {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);

  const limiters = await import('../../../src/middleware/rateLimit.js');

  const app = express();
  app.set('trust proxy', 1);
  mount(app, limiters);

  let server: Server;
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });

  const address = server!.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let active: Harness | undefined;

afterEach(async () => {
  await active?.close();
  active = undefined;
  vi.unstubAllEnvs();
  vi.resetModules();
});

const get = (origin: string, sub?: string): Promise<Response> =>
  fetch(`${origin}/flow`, {
    headers: sub === undefined ? {} : { authorization: `Bearer ${tokenFor(sub)}` },
  });

describe('userLimiter', () => {
  beforeEach(() => {
    vi.stubEnv('RATE_LIMIT_BACKSTOP_MAX', '10000');
  });

  it('rejects with 429 once the threshold is exceeded', async () => {
    active = await harness({ RATE_LIMIT_MAX: '3' }, (app, { userLimiter }) => {
      app.get('/flow', userLimiter, (_req, res) => {
        res.json({ status: 'ok' });
      });
    });

    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await get(active.origin, 'user-a')).status);
    }

    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it('returns the shared JSON error shape when it rejects', async () => {
    active = await harness({ RATE_LIMIT_MAX: '1' }, (app, { userLimiter }) => {
      app.get('/flow', userLimiter, (_req, res) => {
        res.json({ status: 'ok' });
      });
    });

    await get(active.origin, 'user-a');
    const rejected = await get(active.origin, 'user-a');

    expect(rejected.status).toBe(429);
    expect(await rejected.json()).toMatchObject({ status: 'error', error: 'rate_limited' });
  });

  it('gives each authenticated user their own budget', async () => {
    active = await harness({ RATE_LIMIT_MAX: '2' }, (app, { userLimiter }) => {
      app.get('/flow', userLimiter, (_req, res) => {
        res.json({ status: 'ok' });
      });
    });

    // Exhaust one user completely.
    await get(active.origin, 'user-a');
    await get(active.origin, 'user-a');
    expect((await get(active.origin, 'user-a')).status).toBe(429);

    // A different subject must be unaffected.
    expect((await get(active.origin, 'user-b')).status).toBe(200);
  });

  it('keeps a slot spent once the request got past the gate', async () => {
    // The limiter used to carry `skipFailedRequests`, which refunds on a failure *and* on a
    // client disconnect. The disconnect refund handed the slot back while the LLM and catalog
    // calls it had paid for kept running, so hanging up mid-request bought free work. The
    // slot now stays spent whatever the outcome; a request that reaches this limiter has
    // already been authenticated, so there is no stranger's budget to drain.
    active = await harness({ RATE_LIMIT_MAX: '2' }, (app, { userLimiter }) => {
      app.get('/flow', userLimiter, (req, res) => {
        if (req.query['fail'] === '1') {
          res.status(500).json({ status: 'error' });
          return;
        }
        res.json({ status: 'ok' });
      });
    });

    const failing = (): Promise<Response> =>
      fetch(`${active!.origin}/flow?fail=1`, {
        headers: { authorization: `Bearer ${tokenFor('user-a')}` },
      });

    expect((await failing()).status).toBe(500);
    expect((await failing()).status).toBe(500);

    expect((await get(active.origin, 'user-a')).status).toBe(429);
  });

  it('is never reached by a request the gate rejects, so no budget is spent', async () => {
    // What makes keying on the token's `sub` safe is the mounting order in `createApp`:
    // `requireAuth` answers first, so a forged subject earns its 401 before any per-user
    // bucket exists to charge. This stands in for that gate.
    const rejectingGate: express.RequestHandler = (req, res, next) => {
      if (req.query['forged'] === '1') {
        res.status(401).json({ status: 'error', error: 'unauthorized' });
        return;
      }
      next();
    };

    active = await harness({ RATE_LIMIT_MAX: '2' }, (app, { userLimiter }) => {
      app.get('/flow', rejectingGate, userLimiter, (_req, res) => {
        res.json({ status: 'ok' });
      });
    });

    for (let i = 0; i < 5; i++) {
      const response = await fetch(`${active.origin}/flow?forged=1`, {
        headers: { authorization: `Bearer ${tokenFor('victim')}` },
      });
      expect(response.status).toBe(401);
    }

    // The victim's budget is untouched despite five requests naming them.
    expect((await get(active.origin, 'victim')).status).toBe(200);
    expect((await get(active.origin, 'victim')).status).toBe(200);
    expect((await get(active.origin, 'victim')).status).toBe(429);
  });

  it('falls back to the address when there is no usable token', async () => {
    active = await harness({ RATE_LIMIT_MAX: '2' }, (app, { userLimiter }) => {
      app.get('/flow', userLimiter, (_req, res) => {
        res.json({ status: 'ok' });
      });
    });

    await get(active.origin);
    await get(active.origin);

    // Anonymous callers share the address bucket rather than getting a free pass.
    expect((await get(active.origin)).status).toBe(429);
  });
});

describe('expensiveLimiter', () => {
  it('rejects sooner than the ordinary user limiter on the shipped defaults', async () => {
    // Behavioural rather than introspective: what matters is that the flows costing an LLM
    // call run out of budget before the cheap ones do, using the defaults as shipped.
    active = await harness({}, (app, { userLimiter, expensiveLimiter }) => {
      app.get('/flow', userLimiter, (_req, res) => {
        res.json({ status: 'ok' });
      });
      app.get('/costly', expensiveLimiter, (_req, res) => {
        res.json({ status: 'ok' });
      });
    });

    const call = (path: string): Promise<Response> =>
      fetch(`${active!.origin}${path}`, {
        headers: { authorization: `Bearer ${tokenFor('user-a')}` },
      });

    let costlyRejectedAt = 0;
    for (let i = 1; i <= 40; i++) {
      if ((await call('/costly')).status === 429) {
        costlyRejectedAt = i;
        break;
      }
    }

    expect(costlyRejectedAt).toBeGreaterThan(0);

    // The cheap endpoint still has budget left at the point the costly one ran out.
    for (let i = 0; i < costlyRejectedAt; i++) {
      expect((await call('/flow')).status).toBe(200);
    }
  });

  it('does not refund the slot when the client hangs up mid-request', async () => {
    // Measured before the fix: the aborted request's slot came back, so request 2 answered
    // 200 while both handlers ran their work to completion — the client could buy LLM and
    // catalog calls by disconnecting. Both handlers must still run (nothing observes the
    // abort, which is a separate gap), but the quota must not be given back.
    let handlersStarted = 0;
    active = await harness({ RATE_LIMIT_EXPENSIVE_MAX: '1' }, (app, { expensiveLimiter }) => {
      app.get('/costly', expensiveLimiter, (_req, res) => {
        handlersStarted += 1;
        // Stands in for the paid work: router prompt, Tavily, catalog fan-out, synthesizer.
        setTimeout(() => res.json({ status: 'ok' }), 300);
      });
    });

    const headers = { authorization: `Bearer ${tokenFor('aborter')}` };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await fetch(`${active.origin}/costly`, { headers, signal: controller.signal }).catch(
      (err: Error) => err.name
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await fetch(`${active.origin}/costly`, { headers });

    expect(second.status).toBe(429);
    expect(handlersStarted).toBe(1);
  });
});

describe('ipBackstop', () => {
  it('counts failed requests too, unlike the per-user limiters', async () => {
    active = await harness({ RATE_LIMIT_BACKSTOP_MAX: '3' }, (app, { ipBackstop }) => {
      app.get('/flow', ipBackstop, (_req, res) => {
        res.status(401).json({ status: 'error' });
      });
    });

    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await get(active.origin, 'user-a')).status);
    }

    // Three 401s, then the backstop takes over — this is what stops an unauthenticated
    // flood from exercising JWT verification for free.
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
  });

  it('buckets an IPv6 caller by subnet, not by full address', async () => {
    // `ipKeyGenerator(ip, false)` gave every address its own bucket, so anyone holding a
    // /64 — one residential allocation — walked past the floor by varying the last hexlet.
    active = await harness({ RATE_LIMIT_BACKSTOP_MAX: '3' }, (app, { ipBackstop }) => {
      app.get('/flow', ipBackstop, (_req, res) => {
        res.json({ status: 'ok' });
      });
    });

    const fromAddress = (address: string): Promise<Response> =>
      fetch(`${active!.origin}/flow`, { headers: { 'x-forwarded-for': address } });

    const statuses: number[] = [];
    for (const address of ['2001:db8::1', '2001:db8::2', '2001:db8::3', '2001:db8::4']) {
      statuses.push((await fromAddress(address)).status);
    }

    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it('still treats two IPv4 callers as two buckets', async () => {
    // The subnet default must not collapse distinct IPv4 clients, which share no prefix.
    active = await harness({ RATE_LIMIT_BACKSTOP_MAX: '1' }, (app, { ipBackstop }) => {
      app.get('/flow', ipBackstop, (_req, res) => {
        res.json({ status: 'ok' });
      });
    });

    const fromAddress = (address: string): Promise<Response> =>
      fetch(`${active!.origin}/flow`, { headers: { 'x-forwarded-for': address } });

    expect((await fromAddress('203.0.113.1')).status).toBe(200);
    expect((await fromAddress('203.0.113.1')).status).toBe(429);
    expect((await fromAddress('198.51.100.7')).status).toBe(200);
  });
});
