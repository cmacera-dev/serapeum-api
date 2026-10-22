/**
 * Fails when a route mounted in `src/app.ts` is missing from `docs/openapi.yaml`, or vice versa.
 *
 * `scripts/generate-openapi.ts` registers every path BY HAND. Nothing tied those registrations
 * to the router, so a route could be mounted and served while the published contract never
 * mentioned it — and one was: `POST /searchWeb` reached a paid Tavily upstream for months while
 * the spec that generates the Flutter DTOs showed eight routes, not ten. `/health` was missing
 * too. Neither was a decision; both were an omission nothing could catch.
 *
 * This reads the ACTUAL router rather than grepping `app.ts`, because a grep only finds the
 * mounting style it was written for, and the next route may be mounted some other way.
 *
 * There is deliberately no allowlist. "Every mounted route appears in the spec" is a rule with
 * no exceptions to maintain; a list of routes exempt from the contract is somewhere drift hides.
 *
 * Run with: npm run check:openapi
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'yaml';

// Dummy values only, and only where an import would otherwise throw: this boots the app to read
// its route table, and must never need a real credential or reach the network.
process.env['AI_PROVIDER'] ??= 'google';
process.env['GEMINI_MODEL'] ??= 'gemini-2.5-flash';
process.env['GOOGLE_GENAI_API_KEY'] ??= 'stand-in';
process.env['SUPABASE_URL'] ??= 'http://127.0.0.1:1';
process.env['SUPABASE_SERVICE_ROLE_KEY'] ??= 'stand-in';

const { createApp } = await import('../src/app.js');

interface RouteLayer {
  route?: { path?: unknown; methods?: Record<string, boolean> };
}

/** Every method+path pair the Express router will actually answer. */
function mountedRoutes(): Set<string> {
  const app = createApp('*', false) as unknown as { router?: { stack?: RouteLayer[] } };
  const stack = app.router?.stack ?? [];
  const found = new Set<string>();
  for (const layer of stack) {
    const path = layer.route?.path;
    if (typeof path !== 'string') continue;
    for (const [method, enabled] of Object.entries(layer.route?.methods ?? {})) {
      if (enabled && method !== '_all') found.add(`${method.toLowerCase()} ${path}`);
    }
  }
  return found;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const spec = yaml.parse(readFileSync(resolve(__dirname, '../docs/openapi.yaml'), 'utf-8')) as {
  paths?: Record<string, Record<string, unknown>>;
};

const documented = new Set<string>();
for (const [path, item] of Object.entries(spec.paths ?? {})) {
  for (const method of Object.keys(item)) {
    if (['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method)) {
      documented.add(`${method} ${path}`);
    }
  }
}

const mounted = mountedRoutes();
if (mounted.size === 0) {
  console.error('✖ Read no routes off the router. The check cannot pass by finding nothing.');
  process.exit(1);
}

const undocumented = [...mounted].filter((r) => !documented.has(r)).sort();
const phantom = [...documented].filter((r) => !mounted.has(r)).sort();

for (const r of undocumented) console.error(`✖ mounted but absent from docs/openapi.yaml: ${r}`);
for (const r of phantom) console.error(`✖ in docs/openapi.yaml but not mounted: ${r}`);

if (undocumented.length > 0 || phantom.length > 0) {
  console.error(
    '\nRegister the path in scripts/generate-openapi.ts and re-run `npm run generate:openapi`.\n' +
      'docs/openapi.yaml generates the Flutter DTOs, so a route missing here is a route the client cannot see.'
  );
  process.exit(1);
}

console.log(`✅ ${mounted.size} mounted routes, all documented in docs/openapi.yaml`);
