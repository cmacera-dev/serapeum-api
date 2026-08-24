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
npm run test:run           # vitest single run (CI mode, excludes e2e)
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
  e2e/              # E2E tests (excluded from normal runs, require RUN_E2E=true)
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
| `test:run` | `vitest run` (excludes e2e) |
| `build` | `tsc && cp -r src/locales dist/` |
| `format:check` | `prettier --check "src/**/*.ts"` |
| `check-pr-title` | PR title must be Conventional Commits — **no** `[DEV-XX]` prefix; issues are linked with `Closes #123` in the body. Skipped for Dependabot PRs |
| `check:lockfile` | `package-lock.json` is internally consistent (runs inside `test`) |

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
3. **Advisories** — open Dependabot alerts an override would fix. Advisories owned by a
   still-holding blocker are excluded, because "just override `@opentelemetry/*`" would
   break genkit outright.

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
| `typescript` 7 | `@typescript-eslint` widening `peer typescript@">=4.8.4 <6.1.0"` |
| `extract-zip` | any release newer than 2.0.1 (unmaintained since 2023) |

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
- **Portability:** assume Docker container behind a reverse proxy
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
