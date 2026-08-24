# Infrastructure

Every third-party account Serapeum uses belongs to the project's own Google
account, never to a personal one — the address is in the password manager, not
here. The separation is deliberate: these accounts hold a Supabase
`service_role` key and a Vercel token, so compromising one identity must not
reach the other.

The GitHub repositories live in the `cmacera-dev` organisation. That is the one
exception to the rule above, and it is fine: nothing in GitHub can delete the
database.

## Platform

| Service | Holds | Used by |
| --- | --- | --- |
| Vercel | landing and API deployments | landing, api |
| Supabase | database, auth, the anon and `service_role` keys | all three |
| Sentry | crash reporting | app |
| Langfuse | tracing for the Genkit flows | api |

**Both repositories deploy through the Vercel CLI from GitHub Actions**, not
through Vercel's Git integration, and neither is Git-connected on the Vercel
side. That is deliberate rather than incidental: Vercel does not support
connecting a Hobby-plan project to a repository owned by a GitHub organisation,
and these repositories live in one. The CLI authenticates with a token, so the
restriction does not apply.

`serapeum-api` deploys on a `v*.*.*` tag; `serapeum-landing` deploys on every
push to `main`. Each holds `VERCEL_TOKEN`, `VERCEL_ORG_ID` and
`VERCEL_PROJECT_ID` as Actions secrets.

Leaving a project Git-connected as well would make one push deploy twice, which
is why the connection is off and the Vercel GitHub App is not installed. The
cost is real and worth knowing: there are no per-pull-request preview
deployments and no deployment status on commits. A preview job using
`npx vercel --yes` would bring the first of those back.

## Data and model providers

Keys live in `.env`, which is gitignored; the variable names are in
`.env.example`.

| Provider | Variables | Note |
| --- | --- | --- |
| Google AI | `GOOGLE_GENAI_API_KEY` | Gemini |
| OpenRouter | `OPENROUTER_API_KEY` | |
| Ollama Cloud | `OLLAMA_CLOUD_API_KEY` | |
| TMDB | `TMDB_API_KEY` | films and TV |
| Google Books | `GOOGLE_BOOKS_API_KEY` | |
| IGDB | `IGDB_CLIENT_ID`, `IGDB_CLIENT_SECRET` | issued by **Twitch**, not by IGDB, under the same project account |
| Tavily | `TAVILY_API_KEY` | web search |

## Secrets in GitHub

Each repository's Actions settings hold what its workflows need. Values are
recoverable from the local `.env` files and `.vercel/project.json`; none has
ever been committed.

`sync-flutter` authenticates as a GitHub App owned by the organisation rather
than with a personal token, because pushing to `main` requires signed commits
and only a GitHub-created commit carries a signature. `FLUTTER_SYNC_APP_ID` and
`FLUTTER_SYNC_APP_KEY` are that App's credentials. The private key cannot be
re-downloaded — generate a new one from the App's settings if it is lost.
