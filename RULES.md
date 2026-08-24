# ⚖️ RULES.md
## **The Code of Law for Serapeum API**

---

## 1. 📜 The Prime Directive (Language)

> **CRITICAL:** All code, comments, documentation, and artifacts **MUST be written in ENGLISH.**

This guarantees consistency across the engineering ecosystem and enables future automation, linting, and documentation tooling.

---

## 2. 💻 Coding Standards

**Language Standards:**
- **TypeScript:** Strict mode **must be enabled** in the compiler configuration.
- **Async/Await:** **Mandatory** for all asynchronous or I/O operations.
- **Imports:** Always use **explicit relative imports** (e.g. `../lib/ai`) instead of wildcard or implicit paths.

> *Clean, deterministic, and strictly typed code sustains the Serapeum core.*

---

## 3. 🔩 Genkit Standalone Mandates (The Iron Laws)

These rules govern how Serapeum services behave when deployed as independent **Genkit Standalone** servers.

### 3.1 🛰️ Server & Deployment

- **No Firebase Functions:**
  Do **not** import or depend on `firebase-functions`. Use **Genkit Core** libraries only.
- **Port Configuration:**
  Always bind to `process.env.PORT`.
  Never hardcode ports (`80`, `3000`, etc.) in production code.
- **Graceful Shutdown:**
  The server **must handle** `SIGTERM` and `SIGINT` signals to close database and network connections safely, enabling zero-downtime rolling updates on PaaS platforms.

### 3.2 🧪 Schema & Validation

- **Zod Everywhere:**
  All **Input** and **Output** schemas must be defined and validated using **Zod**.
- **Strict Typing:**
  The use of `z.any()` is **forbidden** under all circumstances.
- **Single Source of Truth:**
  All schemas live in `packages/shared-schemas/`. `src/schemas/` only re-exports from there — never define schemas in both places.

> *Every Flow must be schema-bound; ambiguity is antithetical to structure.*

### 3.3 🔐 Security

- **No `.env` in Git:**
  `.env` files must be **gitignored** at all times.
- **Secrets Management:**
  All keys, tokens, and credentials belong in **environment variables**, never in source code or static config files.
- **CORS Policy:**
  In production, explicitly **restrict origins** and **reject unauthorized sources**.
- **HTTP Responses:**
  Always check `res.ok` before calling `res.json()`. Include `status` and `statusText` in any thrown error.

> *Security is not configuration — it is culture.*

### 3.4 📝 Dotprompt Rules

- **Location:** All `.prompt` files live in the top-level `prompts/` directory.
- **YAML indentation:** Frontmatter keys must use exactly 2-space indentation.
- **Variants:** Use `*.v2.prompt` naming for iterative improvements. Never modify the original while A/B evals are in progress.
- **Promotion:** Once evals confirm a variant wins, replace the original and delete the variant file.

---

## 4. 🧪 Local Quality Gates (Pre-commit Hooks)

Local development MUST enforce quality before changes reach remote branches.

- **Git Hooks Engine:**
  All contributors MUST use `husky` to manage Git hooks (`pre-commit`, `commit-msg`, `pre-push`).
- **Git Rules:**

*   **Clean, Atomic Commits:**
    *   Do not include unrelated changes in the same commit or PR.
    *   If you find a bug unrelated to your task, report it or create a separate ticket; do not fix it "along the way".
*   **Commit Messages:**
    *   Use [Conventional Commits](https://www.conventionalcommits.org/).
    *   Structure: `type(scope): description`. Example: `feat(auth): add login endpoint`.
    *   **No** `[DEV-XX]` prefix in local commits — `commitlint` rejects it. The ticket ID belongs only in the PR title.
*   **Pull Requests:**
    *   **Title**: Must include the Linear ticket ID (e.g., `[DEV-123] feat(auth): add login` or `DEV-123: feat(auth): add login`).
    *   **Description**: Must include `Closes DEV-123` to automatically link it.
- **Staged Checks (`pre-commit`):**
  `lint-staged` MUST run on every commit to:
  - Format code with `prettier`.
  - Lint code with `eslint`.
  - Type-check with `tsc --noEmit`.
- **Commit Messages (`commit-msg`):**
  `commitlint` MUST enforce a conventional commit style for all commits.
- **Config files (`.env.example`):**
  Keys within each section MUST be ordered alphabetically to satisfy `dotenv-linter`'s `UnorderedKey` rule.

> *If it does not pass locally, it does not reach the repository.*

---

## 5. 🔗 Linear Integration & Git Workflow

Serapeum uses **Linear** as the single source of truth for planning and issue tracking.

- **Branch Naming:**
  All branches MUST start with the corresponding Linear issue key:
  - Example: `DEV-123/add-genkit-flow-for-recommendations`.
- **PR Title Convention:**
  Pull Requests MUST include the Linear issue key at the beginning of the title:
  - Example: `[DEV-123] feat(auth): implement Supabase JWT validation` or `DEV-123: ...`
- **PR Description:**
  PR descriptions MUST include a direct reference to the Linear issue:
  - Example: `Closes DEV-123`.
- **Sync Requirement:**
  Every merged PR MUST be linked to at least one Linear issue.

> *Work that is not tracked in Linear does not exist.*

### 5.1 🤖 Agent Commit Protocol

- **User Authority Required:**
  The AI Agent **MUST NOT** commit or push changes to the repository without explicit user approval.
  - All changes must be staged or left in the working directory for user review.
  - Commits to remote branches are strictly prohibited unless the user explicitly requests them (e.g. *"commit and push this"*).

### 5.2 🤖 Agent PR Creation Protocol

Every Pull Request opened by the AI agent **MUST** follow the PR workflow. Key requirements:

- **PR Title format (MANDATORY):**
  The `check-pr-title.yml` action validates: `/^(\[DEV-\d+\]|DEV-\d+)/`
  Both formats pass ✅:
  ```text
  [DEV-47] feat(auth): implement Supabase JWT validation middleware
  DEV-47 feat(auth): implement Supabase JWT validation middleware
  ```
  Preferred: `[DEV-47] ...` — matches Linear's own link style.
  > Any title **not** starting with `[DEV-XXX]` or `DEV-XXX` will **fail** CI.

- **PR Description (MANDATORY):**
  Must contain `Closes DEV-XXX` to auto-link the Linear issue and satisfy the Linear ↔ GitHub sync requirement.

> ⚠️ Pull Requests missing a valid Linear ticket ID at the start of the title will be **blocked by CI**.

---

## 6. 🛂 CI Enforcement

The CI pipeline is the final gatekeeper of Serapeum's standards.

**`test` job** (runs on every push/PR):

| Check | Command | Scope |
|---|---|---|
| `typecheck` | `tsc --noEmit` | `src/` only |
| `lint` | `eslint src --ext .ts` | `src/` only |
| `test:run` | `vitest run --coverage` | thresholds in `vitest.config.ts` |
| `build` | `tsc && cp -r src/locales dist/` | full build |

**`format` job** (separate workflow):

| Check | Command | Scope |
|---|---|---|
| `format:check` | `prettier --check "src/**/*.ts"` | `src/` only |

**`check-pr-title` workflow** (PR title only):

| Check | Command | Scope |
|---|---|---|
| `check-pr-title` | regex `/^(\[DEV-\d+\]\|DEV-\d+)/` | PR title |

> *CI is law enforcement; local hooks are the neighborhood watch.*

---

> ⚖️ *"Law defines order; order empowers flow — the Serapeum stands on disciplined engineering."*
