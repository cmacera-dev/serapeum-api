/**
 * Rate limiting for the flow endpoints.
 *
 * Authentication answers "who are you", not "how often". Every flow here is behind a
 * Supabase JWT, but a single authenticated user can still call `/orchestratorFlow` in a
 * loop — and each call fans out to an LLM plus Tavily plus the catalog APIs. The cost of
 * an unbounded loop is real money, so the expensive flows get a tighter budget than the
 * cheap ones.
 *
 * Two layers, because they defend against different things:
 *
 *   - `ipBackstop` counts every request from an address, including the ones that fail
 *     authentication. This is what stops an unauthenticated flood.
 *   - `userLimiter` / `expensiveLimiter` count per authenticated user and ignore failed
 *     requests, so one caller cannot exhaust another's budget (see `subjectKey`).
 */

import rateLimit, { ipKeyGenerator, type Options } from 'express-rate-limit';
import type { Request, Response } from 'express';
import { decodeJwt } from 'jose';

/** Minutes → milliseconds, so the windows below read as the units they are written in. */
const minutes = (count: number): number => count * 60 * 1000;

function numberFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Rate-limit key for an authenticated caller: the `sub` claim of the bearer token.
 *
 * The token is decoded but deliberately NOT verified here. Verification happens inside the
 * Genkit context provider, further down the stack, and doing it twice would mean a second
 * signature check on every request.
 *
 * That is safe because of how the two layers combine. A forged `sub` cannot buy extra
 * budget: the request still fails verification downstream and never reaches an upstream
 * API. And a forged `sub` cannot *drain someone else's* budget either, because these
 * limiters are configured with `skipFailedRequests`, so the 401 it earns is not counted.
 * Unauthenticated volume is handled by `ipBackstop`, which counts everything.
 */
function subjectKey(req: Request, res: Response): string {
  const header = req.headers.authorization;
  const [scheme, token] = header?.split(' ') ?? [];

  if (scheme?.toLowerCase() === 'bearer' && token !== undefined) {
    try {
      const { sub } = decodeJwt(token);
      if (typeof sub === 'string' && sub !== '') return `user:${sub}`;
    } catch {
      // Malformed token — fall through to the address, and let auth reject it downstream.
    }
  }

  return ipKeyGenerator(req.ip ?? '', false) || `anon:${res.locals['requestId'] ?? 'unknown'}`;
}

const shared: Partial<Options> = {
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    status: 'error',
    error: 'rate_limited',
    message: 'Too many requests. Please slow down and try again shortly.',
  },
};

/**
 * Counts every request from an address, successes and failures alike.
 *
 * Generous on purpose: this is not the per-user budget, it is the floor that stops someone
 * without a valid token from hammering the JWT verification path for free.
 */
export const ipBackstop = rateLimit({
  ...shared,
  windowMs: minutes(numberFromEnv('RATE_LIMIT_BACKSTOP_WINDOW_MINUTES', 15)),
  limit: numberFromEnv('RATE_LIMIT_BACKSTOP_MAX', 600),
  keyGenerator: (req: Request): string => ipKeyGenerator(req.ip ?? '', false),
});

/** Per-user budget for the flows that hit a single upstream API. */
export const userLimiter = rateLimit({
  ...shared,
  windowMs: minutes(numberFromEnv('RATE_LIMIT_WINDOW_MINUTES', 15)),
  limit: numberFromEnv('RATE_LIMIT_MAX', 200),
  keyGenerator: subjectKey,
  skipFailedRequests: true,
});

/**
 * Per-user budget for the flows that cost the most per call.
 *
 * `/orchestratorFlow` runs three prompts through the model plus a Tavily search plus the
 * catalog lookups; `/searchAll` fans out to TMDB, IGDB and Google Books at once. These are
 * the calls worth being strict about.
 */
export const expensiveLimiter = rateLimit({
  ...shared,
  windowMs: minutes(numberFromEnv('RATE_LIMIT_EXPENSIVE_WINDOW_MINUTES', 5)),
  limit: numberFromEnv('RATE_LIMIT_EXPENSIVE_MAX', 30),
  keyGenerator: subjectKey,
  skipFailedRequests: true,
});
