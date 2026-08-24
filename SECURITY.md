# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Report it privately through GitHub:

1. Go to the [Security tab](https://github.com/cmacera-dev/serapeum-api/security)
2. Choose **Report a vulnerability**

That opens a private advisory visible only to the maintainers. GitHub's private reporting
is preferred over email — it keeps the discussion, the fix and the disclosure in one place.

Please include what you would want to receive yourself: what you did, what happened, what
you expected, and how severe you think it is. A minimal reproduction is worth more than a
long description.

## What to expect

This is a small project maintained by one person, so no response-time guarantee would be
honest. Reports are triaged as soon as they are seen, and you will hear back with either a
fix, a timeline, or an explanation of why it is not being treated as a vulnerability.

## Supported versions

Only the latest release receives fixes. Older tags are not patched.

## Scope

In scope:

- Authentication and authorisation (Supabase JWT verification, `src/middleware/`)
- The flow endpoints in `src/app.ts` and everything they reach
- Secret or credential exposure in code, logs, or responses
- Dependency vulnerabilities that are actually reachable from this codebase

Out of scope:

- Vulnerabilities in third-party APIs (TMDB, IGDB, Google Books, Tavily, Supabase)
  themselves — report those to the relevant vendor
- Findings from automated scanners with no demonstrated impact here
- Rate limiting thresholds you consider too generous, absent a concrete abuse scenario
- Anything requiring a valid credential you were not authorised to hold

## Dependency handling

Every advisory this repository carries is transitive, so Dependabot cannot open pull
requests for them. They are pinned through `overrides` in `package.json`, and a weekly
workflow re-checks the ones that cannot be pinned yet.

See the "Dependency & security maintenance" section of [CLAUDE.md](./CLAUDE.md), or run:

```bash
npm run check:blockers
```
