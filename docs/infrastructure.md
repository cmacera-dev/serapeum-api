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

`serapeum-api` deploys through GitHub Actions with `VERCEL_TOKEN`;
`serapeum-landing` deploys through Vercel's own GitHub integration and has no
Actions secrets at all. That is why a broken Git connection shows up differently
in each: the API's release job fails loudly, the landing site simply stops
receiving deployments.

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
