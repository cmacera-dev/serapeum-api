import { describe, it, expect, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/**
 * What `trust proxy` does to the address-keyed limiter, over a real socket.
 *
 * The hop count used to be the literal `1` for every deployment. That is right behind
 * Vercel's edge, which replaces `X-Forwarded-For`, and wrong anywhere the port can be
 * reached without such an ingress: there the caller writes the header, so the caller picks
 * their own `req.ip` and their own bucket, and `ipBackstop` stops being a floor at all.
 *
 * `req.ip` is not echoed by any route, so these assert it the way it matters — through the
 * bucketing of the backstop, which is the thing that was broken.
 */

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    const open = server;
    await new Promise<void>((resolve) => open.close(() => resolve()));
    server = undefined;
  }
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Boots `createApp` fresh, so the limiter picks up the stubbed threshold at import. */
async function boot(trustProxyHops?: number | false): Promise<string> {
  vi.resetModules();
  vi.stubEnv('RATE_LIMIT_BACKSTOP_MAX', '1');
  const { createApp } = await import('../../../src/app.js');

  const app = trustProxyHops === undefined ? createApp('*') : createApp('*', trustProxyHops);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

/** `/health` is the one public route, and it sits behind `ipBackstop`. */
async function fromAddress(origin: string, address: string): Promise<number> {
  const res = await fetch(`${origin}/health`, { headers: { 'x-forwarded-for': address } });
  await res.text();
  return res.status;
}

describe('trust proxy', () => {
  it('ignores X-Forwarded-For by default, so one caller cannot pick their bucket', async () => {
    const origin = await boot();

    // Two different forged addresses, a limit of one request: if the header were trusted
    // these would be two buckets and both would pass.
    expect(await fromAddress(origin, '203.0.113.1')).not.toBe(429);
    expect(await fromAddress(origin, '203.0.113.2')).toBe(429);
  });

  it('reads the client address through exactly one hop when told to', async () => {
    const origin = await boot(1);

    expect(await fromAddress(origin, '203.0.113.1')).not.toBe(429);
    expect(await fromAddress(origin, '203.0.113.2')).not.toBe(429);
    // ...and each of those buckets is still enforced.
    expect(await fromAddress(origin, '203.0.113.1')).toBe(429);
  });
});
