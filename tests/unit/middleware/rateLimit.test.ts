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

  it('does not let failed requests drain a user budget', async () => {
    // This is what makes keying on an *unverified* `sub` safe: someone forging a victim's
    // subject earns 401s, and those must not count against the victim.
    active = await harness({ RATE_LIMIT_MAX: '2' }, (app, { userLimiter }) => {
      app.get('/flow', userLimiter, (req, res) => {
        if (req.query['fail'] === '1') {
          res.status(401).json({ status: 'error' });
          return;
        }
        res.json({ status: 'ok' });
      });
    });

    for (let i = 0; i < 5; i++) {
      const response = await fetch(`${active.origin}/flow?fail=1`, {
        headers: { authorization: `Bearer ${tokenFor('victim')}` },
      });
      expect(response.status).toBe(401);
    }

    // The budget is untouched despite five requests against it.
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
});
