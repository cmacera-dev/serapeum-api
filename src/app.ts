import express, { type RequestHandler } from 'express';
import cors from 'cors';
import { expressHandler } from '@genkit-ai/express';

import { jwtContextProvider, requireAuth } from './middleware/verifyJwt.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { validateFlowInput } from './middleware/validateFlowInput.js';
import { expensiveLimiter, ipBackstop, userLimiter } from './middleware/rateLimit.js';
import { checkSupabaseHealth } from './lib/health.js';
import { searchMedia } from './flows/catalog/searchMedia.js';
import { searchBooks } from './flows/catalog/searchBooks.js';
import { searchGames } from './flows/catalog/searchGames.js';
import { searchAll } from './flows/catalog/searchAll.js';
import { searchWeb } from './flows/catalog/searchWeb.js';
import { getMovieDetail } from './flows/catalog/getMovieDetail.js';
import { getTvDetail } from './flows/catalog/getTvDetail.js';
import { orchestratorFlow } from './flows/agent/orchestratorFlow.js';
import { feedbackFlow } from './flows/feedback/feedbackFlow.js';
import './prompts/index.js';
import './evals/index.js';

export function createApp(
  corsOrigins: string[] | string,
  trustProxyHops: number | false = false
): express.Express {
  const app = express();

  // How many proxy hops `req.ip` may be read through, per deployment — Vercel puts exactly
  // one in front of the function, while a container with no ingress has none. It used to be
  // the literal 1 for every target: on anything that does not rewrite X-Forwarded-For, that
  // let each caller name their own `req.ip` and so pick their own bucket in the address-keyed
  // backstop. Never `true`, which would trust any spoofed header, and the default is to
  // trust nothing. See resolveTrustProxyHops in lib/env.ts.
  app.set('trust proxy', trustProxyHops);

  // The limit is body-parser's own default, written down. It is the ceiling on every
  // request this API accepts — the one that bounds a 100 KB `/feedback` comment and a
  // 100 KB `query` — and a default nobody declared is a default nobody notices changing.
  app.use(express.json({ limit: '100kb' }));
  app.use(cors({ origin: corsOrigins }));

  // Deliberately mounted before /health so the Vercel cron cannot be used as an
  // unmetered path, but generous enough that a 5-daily ping never notices.
  app.use(ipBackstop);

  app.get('/health', async (_req, res) => {
    const result = await checkSupabaseHealth();
    const timestamp = new Date().toISOString();
    if (result.ok) {
      res.json({ status: 'ok', timestamp });
      return;
    }
    const code = result.error === 'supabase_not_configured' ? 500 : 503;
    res.status(code).json({ status: 'error', error: result.error, timestamp });
  });

  // `requireAuth` owns the HTTP answer for a rejected token; `expressHandler` only ever sees
  // requests that already carry a valid one. See verifyJwt.ts for why the status code cannot
  // be left to Genkit.
  const protect = { contextProvider: jwtContextProvider };

  // The two handlers every flow route mounts: this API answers an input-schema rejection with
  // a 400 of its own, then Genkit runs the flow. Composed here, from one action, so the gate
  // and the handler can never be given different flows — and so a route added later gets the
  // validation by construction. See validateFlowInput.ts for why Genkit cannot answer it.
  const flowRoute = (action: Parameters<typeof expressHandler>[0]): RequestHandler[] => [
    validateFlowInput(action),
    expressHandler(action, protect),
  ];

  // `requireAuth` ahead of the per-user limiters, not behind them. The limiters key on the
  // token's `sub`, and when they ran first they had to be told to skip failed requests so a
  // forged `sub` could not spend a stranger's budget on its way to a 401. That refund also
  // fires when the *client* disconnects, which handed the slot back while the LLM and
  // catalog calls it had already paid for kept running — so the quota stopped bounding
  // spend for anyone willing to hang up. Rejecting first removes the need for the refund:
  // an unauthenticated request never reaches a per-user bucket, and `ipBackstop` (mounted
  // above, counting everything) is what caps the volume reaching the verification path.

  // One upstream API per call.
  app.post('/searchMedia', requireAuth, userLimiter, ...flowRoute(searchMedia));
  app.post('/searchBooks', requireAuth, userLimiter, ...flowRoute(searchBooks));
  app.post('/searchGames', requireAuth, userLimiter, ...flowRoute(searchGames));
  app.post('/getMovieDetail', requireAuth, userLimiter, ...flowRoute(getMovieDetail));
  app.post('/getTvDetail', requireAuth, userLimiter, ...flowRoute(getTvDetail));
  app.post('/feedback', requireAuth, userLimiter, ...flowRoute(feedbackFlow));

  // Model calls, or a fan-out across several catalog APIs.
  app.post('/searchAll', requireAuth, expensiveLimiter, ...flowRoute(searchAll));
  app.post('/searchWeb', requireAuth, expensiveLimiter, ...flowRoute(searchWeb));
  app.post('/orchestratorFlow', requireAuth, expensiveLimiter, ...flowRoute(orchestratorFlow));

  // Both must come last: Express matches in registration order.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
