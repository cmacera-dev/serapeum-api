# CLAUDE.md — Serapeum API

## Project overview

Node.js AI orchestration service built with **Genkit (Standalone)**. Connects a Flutter frontend with external knowledge sources (TMDB, IGDB, Google Books, Tavily) through a router → extractor → synthesizer agent pipeline.

- **Runtime:** Node ≥ 22, ESM (`"type": "module"`)
- **Language:** TypeScript strict, `ES2022` target, `NodeNext` modules
- **Framework:** Genkit with dotprompt (prompts live in `prompts/`)

---

## Key commands

```bash
npm run genkit:start       # Genkit DevTools UI at localhost:4000
npm run genkit:start:ts    # Same with timestamps (macOS)
npm run dev                # tsx watch (no DevTools)
npm run typecheck          # tsc --noEmit (src/ only)
npm run lint               # eslint src/
npm run test:run           # vitest + coverage; thresholds enforced, HTML report in coverage/
npm run test:e2e:flow-input # tsx harness: input-schema rejections answer 4xx (not collected by vitest)
npm run build              # tsc + copy locales → dist/
```

---

## Directory structure

```text
src/
  flows/
    agent/          # orchestratorFlow.ts, findBestMatch.ts
    catalog/        # searchAll, searchMedia, searchGames, searchBooks, searchWeb
  tools/            # TMDB, IGDB, Google Books, Tavily wrappers
  schemas/          # Thin re-exports from @serapeum/shared-schemas
  middleware/       # JWT verification (Supabase)
  lib/              # ai.ts, aiConfig.ts, auth.ts, retry, types
  locales/          # i18n JSON files
  evals/            # Genkit eval metrics and runners
prompts/            # *.prompt dotprompt files (router, extractor, synthesizer)
packages/
  shared-schemas/   # npm workspace — canonical Zod schemas (built before main)
tests/
  unit/             # Unit tests
  integration/      # Integration tests
.genkit/
  datasets/         # Eval datasets (JSON) and index
```

---

## Architecture

### Agent pipeline (`orchestratorFlow`)

```text
User query → routerPrompt → extractorPrompt → [catalog tools] → synthesizerPrompt
```

1. **Router** — classifies intent (`SPECIFIC_ENTITY` / `GENERAL_DISCOVERY` / `OUT_OF_SCOPE` / `FACTUAL_QUERY`) and category (`MOVIE_TV` / `GAME` / `BOOK` / `ALL`)
2. **Extractor** — extracts title(s) from Tavily web context
3. **Catalog tools** — TMDB / IGDB / Google Books based on category
4. **findBestMatch** — fuzzy match + popularity tiebreaker for featured result
5. **Synthesizer** — formats final natural language response

### Schemas

`packages/shared-schemas/` is the canonical source. `src/schemas/` re-exports from there. Never duplicate schemas.

### AI providers

Configured via env vars in `src/lib/aiConfig.ts`. Four supported providers:

| Provider | Env vars required |
|---|---|
| Google (default) | `GOOGLE_GENAI_API_KEY`, `GEMINI_MODEL` |
| Ollama | `OLLAMA_SERVER_URL`, `OLLAMA_MODEL` |
| Ollama Cloud | `OLLAMA_CLOUD_API_KEY`, `OLLAMA_CLOUD_MODEL` |
| OpenRouter | `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` |

Set `AI_PROVIDER=google|ollama|ollama-cloud|openrouter` to select.

### Prompts

- Dotprompt files in `prompts/` — YAML frontmatter (2-space indent) + Handlebars body
- Variants: `*.v2.prompt` for iterative improvements before promoting to default
- `model:` in frontmatter sets the default picker in the eval UI

---

## CI pipeline

All checks run against `src/` only. Must pass before merge:

| Check | Command |
|---|---|
| `typecheck` | `tsc --noEmit` |
| `lint` | `eslint src --ext .ts` |
| `test:run` | `vitest run --coverage` — thresholds enforced, see `vitest.config.ts` |
| `test:e2e:flow-input` | the input-gate harness under plain `tsx`, which vitest cannot run — see [Input validation](#input-validation) (runs inside `test`) |
| `build` | `tsc && cp -r src/locales dist/` |
| `format:check` | `prettier --check "src/**/*.ts"` |
| `check-pr-title` | PR title must be Conventional Commits — **no** `[DEV-XX]` prefix; issues are linked with `Closes #123` in the body. Skipped for Dependabot PRs |
| `check:lockfile` | `package-lock.json` is internally consistent (runs inside `test`) |
| `check:openapi` | every route mounted in `src/app.ts` appears in `docs/openapi.yaml`, and vice versa (runs inside `test`) |

---

## GitHub Actions conventions

**Actions are pinned to a commit SHA, never a tag.** A tag is mutable: whoever compromises
an action's repository can repoint `v7` at malicious code and it runs in CI with access to
the secrets. This is not hypothetical — it happened to `tj-actions/changed-files` in 2025.

```yaml
uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
```

Keep the tag in a trailing comment: it is what makes the line readable, and it is how
Dependabot knows which release the SHA corresponds to, so updates keep flowing.
`sha_pinning_required` is enabled on the repo, so a tag reference is rejected outright.

**Every workflow declares `permissions:`.** The repo default is `read`, but declaring it
per workflow means a change to that default cannot silently widen them.

`ci.yml` also runs `dependency-review`, which fails a PR that introduces a high-severity
dependency vulnerability — Dependabot only reports one already in the tree. It is set to
`fail-on-severity: high` on purpose: every advisory here is transitive and pinned through
`overrides`, so failing on moderate would block every PR on issues already handled.

---

## Dependency & security maintenance

Everything held back is held back for a reason, and every reason expires eventually. Two
scripts keep that from rotting silently.

```bash
npm run check:blockers    # are the upstream blockers still real? any advisory uncovered?
npm run check:lockfile    # is package-lock.json internally consistent?
```

### The weekly watchdog

`check-dependency-blockers.yml` runs [scripts/check-dependency-blockers.ts](scripts/check-dependency-blockers.ts)
every Monday and answers three questions:

1. **Blockers** — re-tests each reason we pin something, against the live npm registry.
   `typescript-7` is checked *empirically*: it resolves the real dependency set with
   `typescript@^7` and sees whether npm errors, rather than parsing peer ranges.
2. **Dead overrides** — `overrides` entries naming a package no longer in the tree.
   It deliberately does **not** flag overrides whose package already resolves above the
   pin. Those are insurance, not dead weight: the pin is what keeps the tree patched when
   a future `npm install` reshuffles it.
3. **Advisories** — vulnerabilities an override would fix, read from `npm audit` (the
   Dependabot alerts API rejects the Actions `GITHUB_TOKEN`, so it needs no credentials
   and works locally too). The patched version comes from the advisory's own `<x.y.z`
   upper bound. Advisories owned by a still-holding blocker are excluded, because "just
   override `@opentelemetry/*`" would break genkit outright. What is left is split into
   safe pins (fix is inside a major already in the tree) and judgement calls (fix is in a
   higher major, so pinning would drag consumers across a major boundary).

   "Covered" is decided from the lockfile, not from the override keys. A scoped override
   like `uuid@11` only patches that one line — the tree can still carry vulnerable copies
   at other majors.

Output goes to the run summary, and to a single self-managing issue labelled
`dependency-status`: it opens when there is work and closes itself when there is not.

To add a blocker, append one object to the `blockers` array in the script. Give it an
`owns` list so its advisories are attributed to it instead of being recommended as
overrides.

### Current blockers

| Blocked | Waiting on |
|---|---|
| `zod` v4, `@asteasolutions/zod-to-openapi` v8 | `@genkit-ai/core` moving off `zod@^3` |
| `@opentelemetry/*` 2.x | `@genkit-ai/core` moving off `@opentelemetry/sdk-node@^0.52` |
| `@opentelemetry/api` 1.10 | `@opentelemetry/sdk-trace-node` widening `peer @opentelemetry/api@">=1.0.0 <1.10.0"` — 2.x carries the same cap |
| `typescript` 7 | `@typescript-eslint` widening `peer typescript@">=4.8.4 <6.1.0"` |
| `extract-zip` | any release newer than 2.0.1 (unmaintained since 2023) |
| `@types/node` | the runtime moving off Node 22 — types must never run ahead of the runtime, or `tsc` accepts APIs that crash in production |

### Transitive advisories

Every Dependabot alert on this repo is transitive, so Dependabot cannot fix any of them —
it only opens PRs for direct dependencies. The remedy is `overrides` in `package.json`,
pinned inside the major already in the tree. Packages resolving to several majors use the
scoped `"name@major"` key form so each line is patched independently.

### Lockfile gotcha

`npm install` on macOS arm64 prunes `@emnapi/core` and `@emnapi/runtime`, which
`@rolldown/binding-wasm32-wasi` depends on and Linux CI needs. `npm run check:lockfile`
catches it, and CI runs it — but if it fires locally, restore the entries from `main`
rather than regenerating the lockfile.

---

## Request handling

`src/app.ts` wires the Express layer. Order matters — Express matches in registration order.

### Rate limiting

Authentication answers "who are you", not "how often". Every flow is behind a Supabase JWT,
but one authenticated user looping `/orchestratorFlow` costs real money, so there are two
layers in [src/middleware/rateLimit.ts](src/middleware/rateLimit.ts):

| limiter | keyed on | counts failures | default |
|---|---|---|---|
| `ipBackstop` | address subnet | yes | 600 / 15 min |
| `userLimiter` | JWT `sub` | yes | 200 / 15 min |
| `expensiveLimiter` | JWT `sub` | yes | 30 / 5 min |

`expensiveLimiter` guards `/orchestratorFlow`, `/searchAll` and `/searchWeb` — the calls
that hit a model or fan out across several catalogs.

**The per-user limiters are mounted *after* `requireAuth`, and that ordering is load
bearing.** They key on the token's `sub`, which they decode rather than verify — safe only
because the gate above them has already verified it, so a forged `sub` never reaches a
per-user bucket. They used to run first and carry `skipFailedRequests` to keep the resulting
401 from charging the victim. That option also refunds on client *disconnect*, which handed
the slot back while the LLM and catalog calls it had paid for kept running uncancelled:
hanging up mid-request bought free work, measured. Rejecting first removes the need for the
refund, so a slot once taken stays spent. Unauthenticated volume is `ipBackstop`'s job, and
it counts everything.

`ipKeyGenerator` is called with one argument, so the library's subnet default applies.
Passing `false` gave every full IPv6 address its own bucket, which makes the floor useless
against anyone holding a /64.

The trusted proxy hop count is `TRUST_PROXY_HOPS`, parsed in
[src/lib/env.ts](src/lib/env.ts) and passed into `createApp`, defaulting to **0 — trust
nothing**. Vercel puts exactly one proxy in front and replaces `X-Forwarded-For`, so
`vercel.json` sets it to `1`; a deployment whose port is reachable without such an ingress
must leave it at 0, because with a hop count it does not have, every caller picks their own
`req.ip` and so their own bucket. Never `true`, which would trust any spoofed header.

All thresholds are overridable by env var — see `.env.example`.

### Authentication

Every flow route sits behind `requireAuth` in
[src/middleware/verifyJwt.ts](src/middleware/verifyJwt.ts), mounted *ahead* of
`expressHandler` rather than relying on Genkit's `contextProvider` to reject the request.

That is not a style choice. Genkit picks the HTTP status with `getHttpStatus(e)`, which
returns 401 only when the error is `instanceof` **its own** `GenkitError` — and it never is.
Genkit ships a dual build, but the reason the CommonJS copy is the one doing the comparing is
an asymmetry in the **export maps**, not the import syntax used here:

```jsonc
// @genkit-ai/express — "default" comes FIRST, so an ESM `import` still gets the CJS build
{ "require": "./lib/index.js", "default": "./lib/index.js", "import": "./lib/index.mjs" }
// genkit and @genkit-ai/core — "import" comes first, so an ESM `import` gets the ESM build
{ "require": "./lib/index.js", "import": "./lib/index.mjs", "default": "./lib/index.js" }
```

Node resolves export conditions in declaration order, so `import { expressHandler } from
'@genkit-ai/express'` loads `lib/index.js` — CommonJS — while `import { GenkitError } from
'genkit'` loads `lib/index.mjs`. The class the error carries is therefore never the class the
`instanceof` names, whatever this code does. **Do not read the old shorthand ("`.mjs` for
`import`, `.js` for `require`") as meaning the check works for an ESM caller: it does not, and
cannot.** The check fails silently, falls through to the unknown-error branch, and every
rejected token came back as `500 {"message":"Internal Error","status":"INTERNAL"}` while the
log said `UNAUTHENTICATED`. A client cannot tell "refresh your session" from "the server is
down", and authentication noise buries real 5xx in monitoring.

The `contextProvider` is still wired, and still verifies. It is no longer what answers the
caller — it populates flow context, and it is the reason a route mounted without
`requireAuth` fails closed rather than open.

**It publishes `{ sub }` and nothing else, because flow context is exported telemetry.** Genkit
shallow-copies whatever the provider resolves to onto the real OTel span attribute
`genkit:metadata:context`, replacing only top-level keys literally named `auth` or `secrets` —
and a Supabase payload has neither, while the redaction is shallow as well as name-keyed, so a
key called `auth` nested inside `user_metadata` survives verbatim. `src/lib/telemetry.ts` then
registers a `BatchSpanProcessor` with no attribute filter. So returning the payload meant that
with both `LANGFUSE_*` keys set, every claim in the token — `email`, `phone`, `user_metadata` —
was exported to a third-party processor for whatever the project's retention is. Observed with
an `InMemorySpanExporter`, not inferred. Narrowing costs nothing: the only reader of flow
context anywhere in `src/` is `orchestratorFlow.ts`, which reads `sub` to label a trace. Assert
absence with `toEqual`, never `toMatchObject` — the latter passes while every extra claim
leaks.

**Assertions about auth belong at the HTTP layer.** The unit tests always asserted the
correct thrown error, and were green throughout. Only a test that reads a status code off a
real socket can catch this class of bug — see
[tests/integration/http/auth.test.ts](tests/integration/http/auth.test.ts).

### Input validation

The same hazard, one layer deeper. A flow whose `inputSchema` rejects raises `GenkitError`
with status `INVALID_ARGUMENT`, which `getHttpStatus` misclassifies for exactly the reason
above: every malformed body — an over-cap `/feedback` comment, an empty `query`, a missing
field — answered `500 INTERNAL` and was written to the fault log, telling the caller to retry
something only they could fix. The reasoning behind `requireAuth` had been scoped to
authentication and never extended here.

So [src/middleware/validateFlowInput.ts](src/middleware/validateFlowInput.ts) answers it at
the layer that owns status codes, mounted ahead of `expressHandler` on all nine flow routes by
the `flowRoute` helper in `src/app.ts`. Three things make it hold:

- **The schema comes off the action** (`action.__action.inputSchema`), not from a per-flow
  import, so a route added later gets the gate by construction — and the one route that
  exports its schema (`FeedbackInputSchema`) is not a precedent to follow nine times.
- **The check runs through Genkit's own `validateSchema`**, the very function the action
  calls, so the gate and the action cannot disagree about what a valid body is.
- **A rejection is not logged**, like a rejected token. A genuine fault inside a flow body is
  still Genkit's to answer, still 500, and still logged.

**The gate also applies the schema's defaults**, because validating is not normalising and
Genkit never normalises. `parseSchema` hands the action back the *original* `data` over an
`Ajv` built without `useDefaults`, and the one `inputSchema.parse(input)` that would apply
them lives on `actionFn.stream`, which an HTTP flow request never takes. So a field declared
`.optional().default('en')` stayed `undefined` at runtime while the flow's own inferred type
— the schema's **output** type, where a defaulted field is required — said it could not be.
`POST /orchestratorFlow {"data":{"query":"dune"}}` passed the gate, reached
`generateCacheKey(query, undefined)` and died on `language.toLowerCase()`: a `500 INTERNAL`,
in the fault log, for a body this API's published OpenAPI calls valid.

Thirteen `.default()` declarations across the nine flow input schemas sit on that seam, which
is why the gate closes it for all of them instead of a `?? 'en'` at one call site — the per-site
fix leaves the next one to be found in production. Normalising there cannot make the gate
disagree with the action in either direction: `validateSchema` stays the only thing that decides
valid from invalid, and the Zod parse is best-effort, so on the one way the two can diverge — a
`.refine()` ajv cannot see in the emitted JSON Schema — the body passes through untouched rather
than being rejected by a gate stricter than the flow behind it.

Note what cannot cover this: `errorHandler`'s `clientErrorStatus` reads a *numeric* status
while `GenkitError.status` is the string `INVALID_ARGUMENT`, and `expressHandler` answers
before `next(err)` is ever reached.

**Only part of this is testable under vitest.** `tests/setup-genkit.ts` mocks `ai.defineFlow`
down to the implementation function, so a flow there has no `run` and Genkit cannot dispatch
it at all. The 400s are answered *before* dispatch, so
[tests/integration/http/flowInputValidation.test.ts](tests/integration/http/flowInputValidation.test.ts)
asserts them in CI, and
[tests/unit/middleware/validateFlowInput.test.ts](tests/unit/middleware/validateFlowInput.test.ts)
asserts the normalisation against a flow-shaped stand-in; the other half — a valid body still
running the flow, an omitted field arriving as its declared default, a genuine fault still
answering 500 and still logging — needs real flows, and lives in a plain `tsx` harness:

```bash
npm run test:e2e:flow-input
```

It is outside `tests/**/*.test.ts` on purpose, so vitest never collects it — **and `ci.yml`
runs it as its own step in the `test` job, right after `test:run`.** Both halves have to be
enforced somewhere a merge can see them: a harness that only runs when someone remembers it
is the same gap that let #274 ship, where the unit tests asserted the thrown error and stayed
green while every rejection came back as a 500. The harness needs no secrets and reaches no
network — it defaults the three variables `src/lib/ai.ts` insists on at import, and points
Supabase and Langfuse at a loopback stand-in. `/orchestratorFlow` runs there for real against a
**seeded cache hit**: the stand-in answers only the key `generateCacheKey('dune', 'en')`, so a
hit is proof the flow body saw `language` as `'en'` and not merely as something non-`undefined`,
and the hit short-circuits the pipeline before the router prompt, so no model is ever called.

### Errors

[src/middleware/errors.ts](src/middleware/errors.ts) adds a JSON 404 and a terminal error
handler. Genkit's `expressHandler` deals with errors inside a flow; these cover everything
else. The handler logs the real error and returns a generic message, with two exceptions:
"your JSON was malformed", which is useful and gives nothing away, and **a 4xx the error
already carries, which is passed through**. That second one was a defect of its own — a body
over the `express.json({ limit: '100kb' })` ceiling raises body-parser's
`PayloadTooLargeError` with `status: 413`, and answering 500 told the caller the server had
broken rather than that their request was too big, while filling the fault log with client
errors. A 5xx carried by an error is still answered as 500 and still logged.

### Configuration

Both entrypoints (`src/index.ts` standalone, `api/index.ts` on Vercel) parse env through
[src/lib/env.ts](src/lib/env.ts). They used to do it separately and had already drifted.
A missing `CORS_ORIGINS` in production raises `ConfigError` rather than defaulting to `*`;
the standalone server logs and exits, while the serverless entrypoint lets it propagate,
because `process.exit` in a function kills the invocation without surfacing the cause.

---

## Health check & Supabase keep-alive

`GET /health` (public, no auth) pings Supabase Postgres via `${SUPABASE_URL}/rest/v1/query_cache?select=key&limit=1` to keep the project active on the free tier — Supabase pauses projects after 7 days without database activity (Auth hits do not count).

A Vercel cron in `vercel.json` calls `/health` every 5 days at 09:00 UTC (`0 9 */5 * *`). Logic lives in [src/lib/health.ts](src/lib/health.ts); the endpoint just wraps it.

Status codes: `200` ok / `503` Supabase unreachable or 5xx / `500` env vars missing. Body always includes `timestamp`.

---

## Releases

Production deploys are **manual and tag-driven**. Pushing to `main` does not deploy — only pushing a `vX.Y.Z` tag does.

```bash
# 1. Open the version-bump PR (defaults to patch)
npm run release            # → opens PR titled "chore(release): bump version to vX.Y.Z"
npm run release:minor
npm run release:major

# 2. Review and squash-merge the PR on GitHub.

# 3. From updated main, tag and push:
git checkout main && git pull --ff-only
npm run release:tag        # → tags + pushes; release.yml deploys to Vercel
```

The `release.yml` workflow re-runs `typecheck` / `lint` / `test:run`, deploys via `vercel --prod`, and creates a GitHub Release with auto-generated notes.

**Required GitHub secrets** (set once): `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`. ORG and PROJECT IDs can be read from `.vercel/project.json` after `vercel link`.

---

## Architecture constraints

- **No vendor lock-in:** avoid Firebase-specific features (Functions, Triggers)
- **Portability:** assume Docker container behind a reverse proxy. The image is built and
  booted in CI ([.github/workflows/docker.yml](.github/workflows/docker.yml)) on any PR
  that touches it — building alone is not enough, since the image once built fine and
  still could not serve a request
- **Build output lives at `dist/src/`, not `dist/`:** `tsconfig.json` sets `rootDir: "."`,
  so the compiler mirrors the repo layout. `main` and `start` point at `dist/src/index.js`
  accordingly. A `dist/index.js` in a working tree is a stale artifact from an older
  layout, not something a clean build produces
- **Prompts are runtime data:** `promptDir` reads `prompts/` from disk at startup, resolved
  relative to the module rather than the working directory. Any deployment target must ship
  that directory — `vercel.json` does it with `includeFiles`, the Dockerfile with a `COPY`
- **Config via env:** all external credentials and model selection through `process.env`
- **Schemas first:** define Zod schemas before implementing flows or tools
- **Error handling:** explicit error handling on all HTTP calls (check `res.ok` before `res.json()`)

---

## Path aliases

```json
"@/*"                    → "src/*"
"@serapeum/shared-schemas" → "packages/shared-schemas/src/index.ts"
```

Both tsconfig and vitest resolve these aliases.

---

## OpenAPI spec

`docs/openapi.yaml` is generated by [scripts/generate-openapi.ts](scripts/generate-openapi.ts) and
is what the Flutter repo turns into Dart DTOs, so a route missing from it is a route the client
cannot see.

**The generator registers every path by hand, and nothing used to compare it against the router.**
`POST /searchWeb` was mounted, authenticated, rate-limited and reaching a paid Tavily upstream while
the spec listed eight routes instead of ten; `GET /health` was missing too. Neither was a decision.
`npm run check:openapi` now boots the real app, reads the Express route table and fails on drift in
either direction — it reads the router rather than grepping `app.ts`, because a grep only finds the
mounting style it was written for. CI runs it in the `test` job.

There is deliberately **no allowlist**. "Every mounted route is in the spec" has no exceptions to
maintain, which is why `/health` is documented even though no generated client needs it.

**The documented request bodies do not match what the API accepts** — the spec omits Genkit's
`{"data": { … }}` envelope on every route. Tracked in
[#362](https://github.com/cmacera-dev/serapeum-api/issues/362); the options and the cross-repo
consequence live there, not here.

---

## Genkit eval workflow

Datasets live in `.genkit/datasets/`. Add cases via the Genkit UI (localhost:4000) or by editing JSON directly. `index.json` tracks metadata.

Datasets:
- `router-cases` — 49 cases covering all 4 intents and multilingual inputs. Use with `npm run eval:compare -- --dataset router-cases --actions routerPrompt`.
- `extractor-cases` — 22 cases. Use with `npm run eval:compare -- --dataset extractor-cases --actions extractorPrompt`.
- `synthesizer-cases` — 13 cases (factual queries, franchise questions, multilingual). Evaluate via Genkit UI (no CLI scorer — free-form text).

---

## Linear

**Project:** Serapeum API

> Note: local commits must not include `[DEV-XX]` prefix — commitlint rejects it.

### Closing a feature

After merging:
```bash
# From main repo root (not inside a worktree)
git checkout main && git pull
git worktree remove .claude/worktrees/<branch>   # if a worktree was used
git branch -D <branch>
```
