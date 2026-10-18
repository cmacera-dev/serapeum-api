/**
 * Regression harness for the input-schema gate, run under plain `tsx`:
 *
 *     npm run test:e2e:flow-input
 *
 * WHY NOT VITEST. `tests/setup-genkit.ts` mocks `ai.defineFlow` down to the implementation
 * function, so a flow there has no `run` and Genkit's `expressHandler` cannot dispatch it:
 * every request that reaches a flow *body* answers 500 regardless of what is being tested.
 * The vitest companion (`tests/integration/http/flowInputValidation.test.ts`) can therefore
 * assert the 400s — those are answered before dispatch — but not the half of the invariant
 * that needs a flow to really run. This harness boots real flows against local stand-ins and
 * asserts both halves:
 *
 *   1. a body any of the nine schemas refuses answers 4xx, and writes nothing to the fault log
 *   2. a body they accept still runs the flow
 *   3. a body that omits a field the schema gives a default runs with that default applied
 *   4. a genuine fault inside a flow still answers 500, and IS still logged
 *
 * This is the shape of test that #274 needed and did not have: the unit tests asserted the
 * thrown error and stayed green while every rejection came back as `500 INTERNAL`.
 *
 * No outbound network: SUPABASE_URL (JWKS, and the query cache) and LANGFUSE_HOST both point at
 * a local server, and no other upstream is reached. A rejected body never enters a flow body;
 * `/feedback` reaches only the local Langfuse stand-in; and `/orchestratorFlow` is answered from
 * a seeded cache hit, which short-circuits the pipeline before the router prompt, so no model is
 * ever called.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

/** Fault-log lines, as the terminal handler and Genkit's logger write them. */
const faults: string[] = [];
const report = console.log.bind(console);
const realError = console.error.bind(console);
console.error = (...args: unknown[]): void => {
  faults.push(String(args[0]));
};

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  report(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} ${detail}`);
}

const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
const jwk = (await exportJWK(publicKey)) as Record<string, unknown>;
Object.assign(jwk, { kid: 'test-kid', alg: 'RS256', use: 'sig' });

/**
 * The one cache key the stand-in answers a hit for, and every key the flow actually asked for.
 * `orchestratorFlow` derives its key from (query, language), so the key on the wire is a direct
 * readout of the language the flow body saw — which is the whole point of case 3 below.
 */
let cachedKey = '';
const cacheLookups: string[] = [];
const CACHED_RESPONSE = { kind: 'refusal', message: 'seeded cache hit' };

/** Stands in for Supabase (JWKS and the query cache) and Langfuse (score ingestion). */
let langfuseStatus = 200;
const upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
  req.resume();
  const url = req.url ?? '';
  if (url.includes('jwks.json')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [jwk] }));
    return;
  }
  if (url.includes('query_cache')) {
    const key = /key=eq\.([0-9a-f]+)/.exec(url)?.[1] ?? '(none)';
    cacheLookups.push(key);
    const rows = key === cachedKey ? [{ response: CACHED_RESPONSE }] : [];
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(rows));
    return;
  }
  res.writeHead(langfuseStatus, { 'content-type': 'application/json' }).end('{}');
});
await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

// What `src/lib/ai.ts` insists on at import, and what vitest.config.ts supplies for the suite.
// No model is ever called here: the one flow that runs for real does not use one.
process.env['AI_PROVIDER'] ??= 'google';
process.env['GEMINI_MODEL'] ??= 'gemini-2.5-flash';
process.env['GOOGLE_GENAI_API_KEY'] ??= 'stand-in';

process.env['SUPABASE_URL'] = origin;
process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'stand-in';
process.env['LANGFUSE_HOST'] = origin;
process.env['LANGFUSE_PUBLIC_KEY'] = 'stand-in-public';
process.env['LANGFUSE_SECRET_KEY'] = 'stand-in-secret';

const token = await new SignJWT({ sub: 'user-input-validation' })
  .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
  .setAudience('authenticated')
  .setIssuer(`${origin}/auth/v1`)
  .setIssuedAt()
  .setExpirationTime('1h')
  .sign(privateKey);

const { createApp } = await import('../../src/app.js');
const { generateCacheKey } = await import('../../src/lib/queryCache.js');
// Seeded for the DECLARED default, not for whatever the flow happens to send: a flow that read
// `language` as undefined cannot produce this key, so a hit proves the default was applied.
cachedKey = generateCacheKey('dune', 'en');
const server = createApp('*', false).listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

interface Answer {
  status: number;
  body: string;
  newFaults: number;
}

async function post(route: string, data: unknown): Promise<Answer> {
  const before = faults.length;
  cacheLookups.length = 0;
  const res = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ data }),
  });
  return {
    status: res.status,
    body: (await res.text()).slice(0, 180),
    newFaults: faults.length - before,
  };
}

// 1. Every route, with a body its own schema refuses. All nine, because the defect was
//    uniform across them and a route mounted without the gate is the regression to catch.
const rejected: ReadonlyArray<readonly [string, unknown]> = [
  ['/searchMedia', { query: '', language: 'en' }],
  ['/searchBooks', { query: '' }],
  ['/searchGames', { query: '' }],
  ['/getMovieDetail', { id: -1 }],
  ['/getTvDetail', { id: 'not-a-number' }],
  ['/feedback', { traceId: 't', score: 1, comment: 'x'.repeat(2001) }],
  ['/searchAll', { query: '' }],
  ['/searchWeb', { query: 'dune', searchDepth: 'exhaustive' }],
  ['/orchestratorFlow', { query: 42 }],
];

report('— a body the schema rejects: 4xx, and no fault logged —');
for (const [route, data] of rejected) {
  const answer = await post(route, data);
  check(
    `${route} rejects`,
    answer.status >= 400 && answer.status <= 499 && answer.newFaults === 0,
    `status=${answer.status} faults=${answer.newFaults} body=${answer.body}`
  );
}

// The pre-#346 cases, kept apart: these schema constraints predate the comment cap, which is
// why this defect was never one the cap introduced.
report('— constraints that predate the /feedback comment cap —');
for (const data of [{ traceId: '', score: 1 }, { traceId: 't', score: 7 }, { traceId: 't' }]) {
  const answer = await post('/feedback', data);
  check(
    `/feedback ${JSON.stringify(data)}`,
    answer.status >= 400 && answer.status <= 499 && answer.newFaults === 0,
    `status=${answer.status} faults=${answer.newFaults}`
  );
}

// 2. A body the schema accepts still runs the flow, all the way to the upstream.
report('— a body the schema accepts still runs the flow —');
const accepted = await post('/feedback', { traceId: 't', score: 1, comment: 'ok' });
check(
  '/feedback accepts a valid body',
  accepted.status === 200 && accepted.newFaults === 0,
  `status=${accepted.status} faults=${accepted.newFaults} body=${accepted.body}`
);

// 3. A body that omits a field its schema gives a default runs with that default APPLIED.
//
//    Validating is not normalising, and `validateSchema` only inspects: Genkit's `parseSchema`
//    hands the action back the original `data` over an `Ajv` built without `useDefaults`, and
//    the one `inputSchema.parse(input)` that would apply defaults is on `actionFn.stream`,
//    which an HTTP request never takes. So `orchestratorFlow`'s
//    `language: z.enum([...]).optional().default('en')` stayed undefined while the flow's own
//    inferred type says it cannot be, and `generateCacheKey(query, undefined)` died on
//    `language.toLowerCase()`: `500 INTERNAL`, in the fault log, for a body this API's
//    published schema calls valid. Thirteen `.default()` declarations across the nine flow
//    schemas share that seam, which is why `validateFlowInput` closes it for all of them.
//
//    This is the half of the invariant vitest cannot reach: the defect lives BELOW Genkit's
//    dispatch, and `tests/setup-genkit.ts` strips a flow down to its implementation function,
//    so no flow body runs there at all.
report('— an omitted field arrives as its declared default —');
const withLanguage = await post('/orchestratorFlow', { query: 'dune', language: 'en' });
check(
  '/orchestratorFlow with language: en',
  withLanguage.status === 200 && cacheLookups[0] === cachedKey,
  `status=${withLanguage.status} key=${cacheLookups[0]} body=${withLanguage.body}`
);

const withoutLanguage = await post('/orchestratorFlow', { query: 'dune' });
const keyWithout = cacheLookups[0];
check(
  '/orchestratorFlow without language',
  withoutLanguage.status === 200 && keyWithout === cachedKey && withoutLanguage.newFaults === 0,
  `status=${withoutLanguage.status} key=${keyWithout} faults=${withoutLanguage.newFaults} body=${withoutLanguage.body}`
);
check(
  'omitting language changes nothing',
  keyWithout === cachedKey && !faults.some((f) => f.includes('toLowerCase')),
  `key=${keyWithout} expected=${cachedKey} toLowerCase in log=${faults.some((f) => f.includes('toLowerCase'))}`
);

// 4. A genuine fault inside a flow body is still a 500, and is still logged. Without this the
//    fix could not be told apart from one that answers 4xx to everything.
report('— a genuine fault is still 500, and still logged —');
langfuseStatus = 500;
const faulted = await post('/feedback', { traceId: 't', score: 1, comment: 'ok' });
check(
  '/feedback upstream failure',
  faulted.status === 500 && faulted.newFaults > 0,
  `status=${faulted.status} faults=${faulted.newFaults} body=${faulted.body}`
);
langfuseStatus = 200;

console.error = realError;
report(
  `\n${failures === 0 ? 'OK' : `${failures} FAILED`} — fault-log lines captured: ${faults.length}`
);

await new Promise<void>((resolve) => server.close(() => resolve()));
await new Promise<void>((resolve) => upstream.close(() => resolve()));
process.exit(failures === 0 ? 0 : 1);
