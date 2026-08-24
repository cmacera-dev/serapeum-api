import 'dotenv/config';

import { createApp } from '../src/app.js';
import { resolveCorsOrigins } from '../src/lib/env.js';

// No try/catch and no process.exit here, unlike the standalone server. In a serverless
// function `process.exit` kills the in-flight invocation and tells the platform nothing;
// letting a ConfigError propagate surfaces the misconfiguration in the logs and fails the
// deployment's first request loudly, which is what you want to notice.
export default createApp(resolveCorsOrigins());
