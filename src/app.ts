import express from 'express';
import cors from 'cors';
import { expressHandler } from '@genkit-ai/express';

import { jwtContextProvider, requireAuth } from './middleware/verifyJwt.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
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

  // `requireAuth` ahead of the per-user limiters, not behind them. The limiters key on the
  // token's `sub`, and when they ran first they had to be told to skip failed requests so a
  // forged `sub` could not spend a stranger's budget on its way to a 401. That refund also
  // fires when the *client* disconnects, which handed the slot back while the LLM and
  // catalog calls it had already paid for kept running — so the quota stopped bounding
  // spend for anyone willing to hang up. Rejecting first removes the need for the refund:
  // an unauthenticated request never reaches a per-user bucket, and `ipBackstop` (mounted
  // above, counting everything) is what caps the volume reaching the verification path.

  // One upstream API per call.
  app.post('/searchMedia', requireAuth, userLimiter, expressHandler(searchMedia, protect));
  app.post('/searchBooks', requireAuth, userLimiter, expressHandler(searchBooks, protect));
  app.post('/searchGames', requireAuth, userLimiter, expressHandler(searchGames, protect));
  app.post('/getMovieDetail', requireAuth, userLimiter, expressHandler(getMovieDetail, protect));
  app.post('/getTvDetail', requireAuth, userLimiter, expressHandler(getTvDetail, protect));
  app.post('/feedback', requireAuth, userLimiter, expressHandler(feedbackFlow, protect));

  // Model calls, or a fan-out across several catalog APIs.
  app.post('/searchAll', requireAuth, expensiveLimiter, expressHandler(searchAll, protect));
  app.post('/searchWeb', requireAuth, expensiveLimiter, expressHandler(searchWeb, protect));
  app.post(
    '/orchestratorFlow',
    requireAuth,
    expensiveLimiter,
    expressHandler(orchestratorFlow, protect)
  );

  // Both must come last: Express matches in registration order.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
