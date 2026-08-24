import express from 'express';
import cors from 'cors';
import { expressHandler } from '@genkit-ai/express';

import { jwtContextProvider } from './middleware/verifyJwt.js';
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

export function createApp(corsOrigins: string[] | string): express.Express {
  const app = express();

  // Vercel puts exactly one proxy in front of the app, and `req.ip` is meaningless
  // without this — every caller would look like the proxy, collapsing the address-keyed
  // limiter into a single shared bucket. A specific hop count rather than `true`, which
  // would trust any spoofed X-Forwarded-For.
  app.set('trust proxy', 1);

  app.use(express.json());
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

  const protect = { contextProvider: jwtContextProvider };

  // One upstream API per call.
  app.post('/searchMedia', userLimiter, expressHandler(searchMedia, protect));
  app.post('/searchBooks', userLimiter, expressHandler(searchBooks, protect));
  app.post('/searchGames', userLimiter, expressHandler(searchGames, protect));
  app.post('/getMovieDetail', userLimiter, expressHandler(getMovieDetail, protect));
  app.post('/getTvDetail', userLimiter, expressHandler(getTvDetail, protect));
  app.post('/feedback', userLimiter, expressHandler(feedbackFlow, protect));

  // Model calls, or a fan-out across several catalog APIs.
  app.post('/searchAll', expensiveLimiter, expressHandler(searchAll, protect));
  app.post('/searchWeb', expensiveLimiter, expressHandler(searchWeb, protect));
  app.post('/orchestratorFlow', expensiveLimiter, expressHandler(orchestratorFlow, protect));

  // Both must come last: Express matches in registration order.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
