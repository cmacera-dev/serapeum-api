import 'dotenv/config';

import { createApp } from './app.js';
import { ConfigError, parsePort, resolveCorsOrigins } from './lib/env.js';

const PORT = parsePort(process.env['PORT'], 3000);

let corsOrigins: string | string[];
try {
  corsOrigins = resolveCorsOrigins();
} catch (error) {
  if (error instanceof ConfigError) {
    // A long-lived process that would serve every origin is worse than one that refuses
    // to start, so this is the one place exiting is the right answer.
    console.error(`🛑 Fatal Error: ${error.message}`);
    process.exit(1);
  }
  throw error;
}

console.log('🚀 Starting Serapeum API (Genkit Powered)...');

const app = createApp(corsOrigins);
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
