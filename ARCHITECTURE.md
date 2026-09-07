# AEGIS — Architecture (Brownfield Engineering Agent)

Complete file-by-file documentation of the project. Start with the [README](./README.md) for setup; this document explains **how the system is built and what every file does**.

---

## 1. System overview

One deployable Next.js process contains everything: the dashboard UI, the REST API, the repository-intelligence engine, the agent orchestrator, the sandbox, and the LLM abstraction. No microservices, no queues — background work runs as in-process async jobs.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                            Browser (developer)                          │
│  login → projects → repository analysis → tasks → run view (live)       │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │ REST + polling (Bearer/cookie dual auth)
┌──────────────────────────────▼───────────────────────────────────────────┐
│                        Next.js 16 App Router                            │
│  src/app/page.tsx (SPA shell)      src/app/api/** (21 route handlers)   │
│  src/components/dashboard/** (UI)  src/lib/session.ts (auth guard)      │
├──────────────────────────────────────────────────────────────────────────┤
│                          Server core (src/server)                       │
│                                                                          │
│  api-helpers.ts ── startRepoAnalysis() background job, withAuth()       │
│        │                                                                │
│        ▼                                                                │
│  ┌─────────────────┐   index   ┌──────────────────────────────┐        │
│  │ sandbox/        │──────────▶│ intelligence/                 │        │
│  │ workspace.ts    │           │ tree-sitter → parsers →       │        │
│  │ (git worktree,  │           │ indexer → graph/semantic →    │        │
│  │  clone/branch)  │           │ retrieval → impact → git      │        │
│  │ executor.ts     │◀──runs─── │ overview (framework detect)   │        │
│  │ (allowlisted    │           └──────────┬───────────────────┘        │
│  │  commands)      │                      │ focused context             │
│  └────────┬────────┘                      ▼                             │
│           │                    ┌──────────────────────┐                  │
│           │ patch/apply        │ agent/               │                  │
│           ├───────────────────▶│ engine (state mach.) │                  │
│           │                    │ planner → coder →    │                  │
│           │                    │ verifier → patcher   │                  │
│           │                    │ tools (20-tool gate) │                  │
│           │                    │ events (audit log)   │                  │
│           │                    └──────────┬───────────┘                  │
│           │                               │ chat/embed                   │
│           │                               ▼                              │
│           │                    ┌──────────────────────┐                  │
│           │                    │ llm/ (provider chain)│                  │
│           │                    │ 9router/OpenAI-compat│                  │
│           │                    │ → GLM → heuristic    │                  │
│           │                    └──────────────────────┘                  │
├───────────┴──────────────────────────────────────────────────────────────┤
│  Prisma + SQLite (18 entities)          instrumentation.ts (boot hooks) │
└──────────────────────────────────────────────────────────────────────────┘
```

**Design principles**

1. **Understand before change** — repository intelligence is not optional garnish; the planner, impact analysis, and coder all consume its output.
2. **Human gate** — the repository is never modified before a plan is explicitly approved; commits are user-triggered.
3. **Isolation** — every run happens in its own git worktree on its own branch; command execution is allowlisted and resource-limited.
4. **Graceful degradation everywhere** — LLM → deterministic fallback; unified-diff → full-file rewrite → pattern edits; gateway down → next provider. Every degradation is logged in the run's event log.
5. **Vendor neutrality** — nothing outside `src/server/llm/` knows which model is behind the curtain.

---

## 2. The two lifecycles

### 2.1 Repository analysis pipeline (background job)

```
connect repo (sample | local path | remote URL)
  → materializeRepository()        clone --depth 50 / copy / reference
  → indexRepository()
      1. walk files (caps: 5000 files, 1MB/file, skip binaries)
      2. detect language + module per file
      3. Tree-sitter parse (JS/TS/TSX/Py) → symbols, imports, calls,
         routes, DB access   (regex fallback for other languages)
      4. persist File/Symbol/Relationship rows
      5. embed documents (readme, docs, comments, tests, commits) → Document rows
      6. synthesize overview (frameworks, DB, entry points, architecture summary)
  → analysisStatus = ready   (progress streamed to UI via RepositoryAnalysis row)
```

### 2.2 Agent run state machine (spec §9)

```
CREATED → DISCOVERING → UNDERSTANDING → IMPACT_ANALYSIS → PLANNING
        → WAITING_FOR_APPROVAL            ← hard human gate
        → IMPLEMENTING → VERIFYING → (FIXING → VERIFYING)* → FINAL_REVIEW
        → COMPLETED
   failure at any state → FAILED     user action → CANCELLED
   state persisted to DB after every transition (resumable after restart)
```

---

## 3. Complete project tree

```
aegis/
├── package.json                  scripts + dependencies
├── tsconfig.json / next.config.ts / tailwind.config.ts / postcss.config.mjs
├── eslint.config.mjs / components.json / Caddyfile / bun.lock
├── .env.example                  template for local configuration
├── prisma/
│   └── schema.prisma             18 data entities
├── src/
│   ├── instrumentation.ts        server boot hook
│   ├── app/
│   │   ├── layout.tsx  page.tsx  globals.css
│   │   └── api/
│   │       ├── route.ts                                 health probe
│   │       ├── auth/{login,register,me,logout}/route.ts session auth (4)
│   │       ├── projects/route.ts                        list + create
│   │       ├── projects/[id]/route.ts                   detail + delete
│   │       ├── projects/[id]/repos/route.ts             connect repository
│   │       ├── projects/[id]/tasks/route.ts             list + create tasks
│   │       ├── projects/[id]/memories/route.ts          project memory CRUD
│   │       ├── repos/[id]/{analyze,overview,system-map,search}/route.ts
│   │       ├── tasks/[id]/route.ts                      task detail
│   │       ├── runs/[id]/{route,approve,cancel,events,commit}/route.ts
│   │       └── settings/provider/route.ts               LLM gateway config
│   ├── server/
│   │   ├── api-helpers.ts
│   │   ├── intelligence/  (10 files)
│   │   ├── agent/         (8 files)
│   │   ├── sandbox/       (3 files)
│   │   └── llm/           (5 files)
│   ├── lib/               (5 files)
│   ├── hooks/             (2 files)
│   └── components/
│       ├── dashboard/     (16 files)
│       └── ui/            (48 shadcn/ui primitives)
├── scripts/               (8 files: seed, sample builder, 6 test harnesses)
├── sample-repos/legacy-shop/        the demo brownfield repository
├── db/                                SQLite databases (runtime artifacts)
├── public/                            logo.svg, robots.txt
└── tests/*.sh, examples/, skills/, download/   ← workspace scaffolding, not the app
```

---

## 4. File-by-file reference

### 4.1 Root configuration

| File | Purpose |
|---|---|
| `package.json` | Project manifest. Scripts: `dev` (next dev, port 3000, logs to `dev.log`), `build` (standalone Next build + copies `static/` and `public/` into `.next/standalone/`), `start` (production via Bun on the standalone server), `lint`, `db:push` / `db:generate` / `db:migrate` / `db:reset` (Prisma). `trustedDependencies` allows Bun to build the native tree-sitter addons. Key dependencies: Next 16, React 19, Prisma 6, Tailwind 4, shadcn/ui stack (Radix primitives), tree-sitter grammars, `z-ai-web-dev-sdk` (GLM), recharts, react-syntax-highlighter, zod. |
| `tsconfig.json` | TypeScript config — strict mode, `@/*` path alias to `src/*`, Next.js plugin, Bun types. |
| `next.config.ts` | `output: "standalone"` (self-contained production build), `serverExternalPackages` for the four tree-sitter native modules (they must be `require`-d at runtime, not bundled), `reactStrictMode: false`. |
| `tailwind.config.ts` / `postcss.config.mjs` | Tailwind CSS 4 pipeline with the shadcn/ui design tokens (CSS variables in `globals.css`). |
| `eslint.config.mjs` | ESLint 9 flat config on top of `eslint-config-next`. `bun run lint` must stay at 0 errors. |
| `components.json` | shadcn/ui generator config (style, aliases, RSC flag) — needed when adding more UI primitives. |
| `.env.example` | Documented template of every environment variable (DB URL, session secret, all `LLM_*` gateway vars). Copy to `.env`. |
| `Caddyfile` | Workspace artifact only — reverse proxy for the hosted preview. Not needed locally. |
| `bun.lock` | Lockfile for reproducible installs. |

### 4.2 `prisma/schema.prisma` — the data model

SQLite datasource + Prisma Client. 18 entities, designed to port 1:1 to PostgreSQL + pgvector (embedding columns become `vector`):

| Entity | Role | Key fields |
|---|---|---|
| `User` | account | `passwordHash` (scrypt), role; owns projects/tasks/memories/audit |
| `Project` | workspace | 1:1 `Repository`, 1:N tasks/runs/memories |
| `Repository` | connected repo | `source`/`sourceType` (sample·local·remote), `localPath`, clone + analysis status, progress fields |
| `RepositoryAnalysis` | one analysis run | `overview` JSON, `progress` 0-100 + `progressStep` for live UI |
| `File` | indexed file | path, language, loc, isTest/isConfig/isDoc, derived module |
| `Symbol` | code symbol | name, qualifiedName, kind (class/function/method/route/table…), signature, line span, exported, doc comment |
| `Relationship` | graph edge | kind (IMPORTS/CALLS/REFERENCES/TESTS/ROUTES_TO/READS/WRITES…), fromFile→toFile |
| `Document` | embedded text chunk | sourceType (readme/doc/comment/commit/test/issue/config), 384-dim embedding stored as JSON |
| `Task` | engineering request | title, description, status; 1:N `AgentRun` |
| `AgentRun` | one agent execution | `state` machine value, `stateData` (full AgentStateObject JSON), branch, workspacePath, provider+model, tokenUsage, error |
| `AgentEvent` | structured run log | seq, phase, type, title, detail, `data` JSON (tool args/results) |
| `Plan` | proposed plan (1:1 run) | objective, filesToModify/Create/Delete, api/database changes, risks, rollback, approval fields |
| `Change` | per-file diff | changeType, additions/deletions, unified diff |
| `TestRun` | verification result | kind (test/lint/typecheck/build), status, classification, fixAttempt |
| `Memory` | durable project memory | kind (verified_fact/inferred/user_rule/assumption), category, source, confidence |
| `AuditLog` | security trail | action (login, plan.approve, run.commit, provider.update…), metadata JSON |
| `ProviderConfig` | LLM gateway settings | singleton row `default`: enabled, baseUrl, apiKey (masked in API), per-role models, probe status |

### 4.3 `src/lib/` — shared primitives

| File | Purpose |
|---|---|
| `db.ts` | Prisma client singleton (global caching in dev to survive HMR). `PRISMA_LOG=query` enables SQL logging. |
| `auth.ts` | Password + token primitives, zero dependencies: scrypt hash/verify with timing-safe compare; `signSessionToken`/`verifySessionToken` — HMAC-SHA256 signed `userId.expiry.signature` payloads (7-day TTL), secret from `SESSION_SECRET`. |
| `session.ts` | Request-level auth. `setSessionCookie`/`clearSessionCookie` (`bfa_session`, httpOnly, SameSite=None; Secure — survives iframe contexts). `getCurrentUser()` reads the cookie, then falls back to `Authorization: Bearer` for browsers that block third-party cookies. `requireUser()`/`Unauthorized` power the API guard. |
| `types.ts` | The shared client/server contract: `AgentState` union + `ACTIVE_STATES`, view shapes (`ProjectSummary`, `RepoOverview`, `SystemMapGraph`, `PlanView`, `ImpactView`, `ChangeView`, `TestRunView`, `RunView`, `MemoryView`, `RunEvent`, `AgentActivityPoint`). API routes serialize DB rows into these; the UI renders them. |
| `utils.ts` | `cn()` class merger (clsx + tailwind-merge) for shadcn/ui. |

### 4.4 Boot & API plumbing

| File | Purpose |
|---|---|
| `src/instrumentation.ts` | Next.js boot hook: (1) loads saved `ProviderConfig` from the DB into the gateway provider so 9router settings survive restarts; (2) `bootstrapRecovery()` — marks analyses interrupted by a restart as failed and recovers stale agent runs (spec §9 resumability). |
| `src/server/api-helpers.ts` | `withAuth(handler)` — wraps every protected route: resolves the user, JSON-encodes the result, maps `Unauthorized`→401. `badRequest()`. `startRepoAnalysis(repoId)` — the background analysis job registry (in-process async, de-duplicated per repo, updates `RepositoryAnalysis` progress rows). `bootstrapRecovery()` used by instrumentation. |

### 4.5 `src/server/llm/` — model abstraction (spec §19)

Everything speaks to models through one interface; the rest of the codebase is vendor-blind.

| File | Purpose |
|---|---|
| `types.ts` | The contract: `LLMProvider` (`name`, `capabilities.freeformChat`, `available()`, `chat()`, `embed()`), `ChatOptions` (role fast/reasoning/coding/embedding, system, messages, temperature, maxTokens, `json` flag), `ChatResult` with usage. `LLMError`. `extractJson()` — robust "first JSON object in a model reply" parser (strips markdown fences, tries slice candidates). |
| `openai-compat.ts` | **The 9router/gateway provider.** OpenAI-compatible chat-completions client that works with 9router, OpenRouter, LiteLLM, Ollama `/v1`, vLLM. Config resolution: DB settings (UI) override env (`LLM_BASE_URL` + `LLM_API_KEY` + per-role `LLM_*_MODEL` + `LLM_TIMEOUT_MS`). If no model is configured the `model` field is **omitted** so the gateway's own routing decides. 3 retries with backoff, `response_format: json_object` support, token usage accounting, 4 s `/models` availability probe cached 60 s. `embed()` uses the gateway only when `LLM_EMBEDDING_MODEL` is set (vector-consistency guarantee), else the local deterministic embedder. `setGatewayConfig()`/`invalidateProbe()` let settings changes apply without restart. |
| `glm-provider.ts` | GLM via `z-ai-web-dev-sdk` (available in the hosted sandbox; on a plain local machine it reports unavailable and the chain moves on). Retries, usage tracking, `GLM_MODEL` override. |
| `heuristic-provider.ts` | Deterministic offline provider: `capabilities.freeformChat = false`, which tells planner/coder to use their own deterministic strategies instead of parsing model text. Makes the whole product work with zero LLM — and powers the E2E tests. |
| `index.ts` | Provider factory + chain: `getProvider()` probes **gateway → GLM → heuristic** (60 s cache; `AGENT_PROVIDER=heuristic` forces offline). `resetProviderCache()` after settings changes. `providerModelLabel()` for run records. Exposes the three singletons for the settings API. |

### 4.6 `src/server/intelligence/` — repository intelligence (the core)

| File | Purpose |
|---|---|
| `tree-sitter-loader.ts` | Loads the native grammar addons via `createRequire` (they are `serverExternalPackages`). Maps language → grammar (JS, TS, TSX, Python), with graceful failure when a grammar is missing. |
| `languages.ts` | Extension → language mapping, binary/config/doc classification, module-name derivation (e.g. `src/services` → `services`). |
| `parsers.ts` | The extraction layer: walks the Tree-sitter AST per file to pull out symbols (functions/classes/methods/routes with signatures + line spans + doc comments), import edges, call edges, HTTP route declarations (method + path), and DB-table access (READS/WRITES). Regex fallback for languages without a grammar. Output feeds the `File`/`Symbol`/`Relationship` tables. |
| `indexer.ts` | `indexRepository(repoId, path, onProgress)` — orchestrates the full analysis pipeline: file walk (5000-file / 1MB caps), parse, persist rows, chunk + embed documents (readme, docs, comments, commits, tests), write `Memory` discoveries (quirks/conventions from git), and synthesize the overview. Progress callbacks stream percent + step to the UI. |
| `graph.ts` | `RepoGraph` — the queryable code graph loaded from the persisted rows: `findSymbol`, `findReferences`, `callers/callees`, `dependencies`, `testsFor`, `impactClosure` (transitive blast radius), and `systemMap()` (layered entry/api/service/data/external/config nodes + aggregated edges for the UI diagram). |
| `semantic.ts` | Local deterministic embedder: `embedText()` produces 384-dim hashed-TF vectors (works offline, consistent across restarts). `cosine()`. `searchDocuments()` — vector similarity over `Document` rows. The `embedding` provider role delegates here unless a gateway embedding model is configured. |
| `retrieval.ts` | `hybridRetrieve()` — the agent's investigation engine. Runs parallel channels (semantic search, keyword/regex, symbol lookup, graph expansion, git history, tests) and merges evidence into a focused context pack with per-source reasoning. This is what "the agent reads before it writes". |
| `impact.ts` | `analyzeImpact()` — blast-radius analysis over the graph: direct + transitive files, affected services/APIs/tests, DB changes, compatibility concerns (frozen contracts, legacy markers in git blame), and a LOW/MEDIUM/HIGH/CRITICAL risk classification with cited evidence. |
| `git.ts` | Safe git porcelain over the repo clone: `log`, `blame`, `diff`, file history, and `suspiciousCodeInvestigation()` — surfaces HACK/TODO/DO-NOT-REMOVE/INC-… markers and the commits/actors behind them ("why does this code exist"). |
| `overview.ts` | Synthesis pass over the index: language stats, framework + test-framework detection, DB detection, important directories, services, entry points, and a human-readable architecture summary shown in the Overview tab. |

### 4.7 `src/server/sandbox/` — isolation

| File | Purpose |
|---|---|
| `shell.ts` | **Cross-platform shell primitives.** Bun's `execSync` resolves its default shell to `/bin/sh` — which does not exist on Windows (`spawnSync /bin/sh ENOENT`). Every process spawn in the app therefore goes through this module: `shSync()` spawns an **explicit** shell (cmd.exe on Windows, /bin/sh on POSIX) with execSync-compatible error semantics; `minimalEnv()` builds a minimal environment (host `PATH` + the OS variables Windows binaries require, `HOME`/`GIT_CONFIG_NOSYSTEM` isolation for git — nothing else, no credentials); `sandboxHomeFor()` gives each run a writable HOME *outside* the repository checkout so caches never pollute git status. |
| `workspace.ts` | `materializeRepository()` — sample copy / local reference / `git clone --depth 50` into `.agent-data/repos/<id>`. `createWorkspace()` — ephemeral **git worktree** + unique branch `agent/<runId-suffix>` per run, so the checkout under test never touches the user's clone. `workspaceDiff`/`workspaceChangedFiles`/`commitWorkspace` — shell-syntax-free git flows (no `&&`/`||`/`2>/dev/null`, so they also run under cmd.exe). Cleanup helpers. |
| `executor.ts` | `execInSandbox()` — the hardened runner: binary allowlist (node, git, npm, pytest, …) with Windows extension normalization (`node.exe` → `node`), forbidden-pattern screening (`sudo`, `curl`, `ssh`, chaining **and piping**, absolute outside-workspace paths incl. Windows drive letters), per-command timeout + output cap, `ulimit` CPU/memory/file ceilings on POSIX, cmd.exe + process-tree kill (`taskkill /T`) on Windows, and a **minimal environment** — no host env vars or credentials ever reach agent-run commands. Bash availability is probed once; plain `/bin/sh` fallback when absent. |

### 4.8 `src/server/agent/` — the orchestrator

| File | Purpose |
|---|---|
| `engine.ts` | The heart (607 lines). `startRun()` / `runLoop()` drive the 11-state machine, persisting `stateData` after every transition. Owns the live-run registry (`isRunLive`, `cancelRun`), calls intelligence → retrieval → impact → planner → coder → verifier in sequence, handles the approval pause/resume (approve API and boot recovery resume runs in `WAITING_FOR_APPROVAL`), records provider + model + token usage on the run row, and classifies failures into the event log. `recoverStaleRuns()` at boot. |
| `state.ts` | `AgentStateObject` (spec §10): repository info, retrieval context, impact result, plan, implementation state, verification results, review — the persisted cross-transition memory. `initialStateObject()`, `isTerminal()`. |
| `planner.ts` | `generatePlan()` — asks the LLM (role `reasoning`) for a `PlanSchema` JSON grounded in the retrieval context + impact; validates with zod-style checks; on `freeformChat=false` providers or invalid output, falls back to a deterministic plan built from the impact analysis (files to modify, tests to add, rollback = revert branch). Writes the `Plan` row (status `proposed`). |
| `coder.ts` | `implement()` — tries, in order: (1) LLM unified diff → `patcher`; (2) LLM full-file rewrite — but **rejected by the brownfield guard** if it would delete git-documented legacy markers (HACK / DO NOT REMOVE / INC-…), with a correction retry; (3) deterministic pattern edits for known task shapes (route additions, race-condition fixes with mutex/atomic updates + regression tests). Writes `Change` rows with real diffs. Every degradation is an event. |
| `verifier.ts` | `detectCommands()` picks the right runners from the repo's test frameworks. `verifyAndRepair()` executes them in the workspace, classifies failures (`agent_caused` / `pre_existing` / `flaky` / `environment`) by re-running against a pristine clone, and drives the repair loop (max attempts, fix prompts back to the coder). `finalReview()` — diff audit (only planned files changed), secret scan of added lines, unintended-change detection; produces the final result summary. Writes `TestRun` rows. |
| `tools.ts` | The controlled **tool gateway** (20 tools) the LLM/planner can invoke: repository queries (read file, search, symbols, graph, git history, tests), modification tools (write_file with guardrails), and execution — all routed through the sandbox with argument/result summaries recorded into events. |
| `events.ts` | `RunEventLog` — appends `AgentEvent` rows with monotonically increasing `seq` per run (retry on P2002 races). Phase + type vocabulary matches the UI timeline; no chain-of-thought, only concise action summaries. |
| `patcher.ts` | Applies unified diffs with `git apply` inside the workspace; validates context lines and paths, refuses absolute/outside paths; reports per-hunk success. |

### 4.9 `src/app/` — pages

| File | Purpose |
|---|---|
| `layout.tsx` | Root layout: fonts, globals.css, dark-mode support. |
| `page.tsx` | The entire dashboard as a single-page client app — mounts `AppShell` (see components). No server-side rendering of data; everything flows through the REST API. |
| `globals.css` | Tailwind 4 + shadcn/ui design tokens (light/dark CSS variables), custom scrollbar + code-view styles. |

### 4.10 `src/app/api/` — REST surface (21 route handlers)

All protected routes use `withAuth()`; every query is scoped by `userId`. Errors → `{error}` JSON.

**Auth**

| Route | Purpose |
|---|---|
| `auth/login/route.ts` | POST email+password → verifies scrypt hash, sets the session cookie, returns `{user, token}` (token powers the Bearer fallback path). Audit: `login`. |
| `auth/register/route.ts` | POST → creates user (scrypt hash), same session setup. Audit: `user.register`. |
| `auth/me/route.ts` | GET → current user or `{user:null}` (cookie or Bearer). |
| `auth/logout/route.ts` | POST → clears the session cookie. |

**Projects**

| Route | Purpose |
|---|---|
| `projects/route.ts` | GET list (with repository + recent tasks summary) · POST create. Audit: `project.create`. |
| `projects/[id]/route.ts` | GET detail · DELETE (cascade removes repo, tasks, runs). |
| `projects/[id]/repos/route.ts` | POST connect repository (`sample:…`, local path, or remote URL) → creates the `Repository` row and kicks off `startRepoAnalysis()`. Audit: `repo.connect`. |
| `projects/[id]/tasks/route.ts` | GET list · POST create task (then `startRun()` immediately). Audit: `task.create`. |
| `projects/[id]/memories/route.ts` | GET list · POST add user rule (`user_rule` kind) — durable guidance injected into future runs. |

**Repository intelligence**

| Route | Purpose |
|---|---|
| `repos/[id]/analyze/route.ts` | POST re-run analysis (idempotent background job). |
| `repos/[id]/overview/route.ts` | GET the synthesized `RepoOverview` (languages, frameworks, DB, architecture summary). |
| `repos/[id]/system-map/route.ts` | GET the layered `SystemMapGraph` (nodes/edges for the UI diagram). |
| `repos/[id]/search/route.ts` | GET hybrid search across the index (semantic + keyword + symbol). |

**Tasks & runs**

| Route | Purpose |
|---|---|
| `tasks/[id]/route.ts` | GET task with its runs. |
| `runs/[id]/route.ts` | GET full `RunView` — state, plan, impact, changes, test runs, final result, provider/model/tokens. |
| `runs/[id]/events/route.ts` | GET the event log after `?after=<seq>` — the polling endpoint behind the live timeline. |
| `runs/[id]/approve/route.ts` | POST approve/reject the proposed plan (`{decision, reason}`) → sets `Plan.status`, resumes the engine loop if the process still holds the run (single-driver via polling), audit `plan.approve`. |
| `runs/[id]/cancel/route.ts` | POST set the in-memory cancel flag → engine transitions to CANCELLED. |
| `runs/[id]/commit/route.ts` | POST user-triggered `git commit` on the agent branch inside the workspace; records the SHA, audit `run.commit`. Explicit human action — never automatic. |

**Settings & health**

| Route | Purpose |
|---|---|
| `settings/provider/route.ts` | GET current gateway config (API key **masked**, env fallbacks, probe status) · PUT save + activate: validates with a live probe first (`testOnly` mode for the UI's Test-Connection button), persists to `ProviderConfig`, calls `setGatewayConfig()` + `resetProviderCache()` so new runs use it immediately, audit `provider.update`. The key never leaves the server. |
| `route.ts` | GET health probe (`{ok:true}`). |

### 4.11 `src/components/dashboard/` — the UI (16 files)

| File | Purpose |
|---|---|
| `app-shell.tsx` | Top-level client shell: session bootstrap (`api.me`), routing between login/projects/project/run views, header with dark-mode toggle, provider-settings trigger, logout (clears Bearer token). |
| `api.ts` | The client API layer — every endpoint typed against `lib/types`. Fetch wrapper attaches the `Authorization: Bearer` token from `bfa_token` localStorage when the cookie is blocked; login/register persist the token. |
| `login-view.tsx` | Sign-in / registration form. |
| `projects-view.tsx` | Project grid + `NewProjectDialog` trigger; empty state. |
| `new-project-dialog.tsx` | Create project (name/description) → connect repository (sample/local/remote tabs). |
| `project-view.tsx` | Project workspace with 4 tabs; orchestrates polling of analysis progress and task runs. |
| `overview-tab.tsx` | Analysis progress bar + the `RepoOverview` render: language bars, frameworks, DB, entry points, architecture summary. |
| `system-map-tab.tsx` | Renders `SystemMapGraph` as a hand-rolled layered SVG (entry/api/service/data/external/config columns, hover for file counts). |
| `tasks-tab.tsx` | Task list with status + latest-run state; create-task composer. |
| `memory-tab.tsx` | Project memory list with provenance badges (`verified_fact`/`inferred`/`user_rule`/`assumption`) + add-rule form. |
| `run-view.tsx` | The run cockpit: state header (provider/model/tokens/branch), live activity timeline (polls `events?after=seq`), plan panel, impact panel, diff viewer, verification panel, final result, approve/reject buttons, commit button. |
| `plan-panel.tsx` | Renders the `PlanView` — objective, assumptions, files modify/create/delete, API/DB changes, tests, risks, rollback; approve/reject actions before approval, rejection reason capture. |
| `impact-panel.tsx` | Renders the `ImpactView` — risk badge (LOW→CRITICAL), blast radius counts, affected files/services/APIs/tests, compatibility concerns with evidence citations. |
| `diff-viewer.tsx` | Per-file unified-diff viewer (additions/deletions stats, collapsible, syntax coloring) built on react-syntax-highlighter. |
| `badges.tsx` | Shared status/risk/classification badge primitives. |
| `provider-settings-dialog.tsx` | The plug-icon dialog: gateway toggle, base URL, key (password field, round-trips masked), label, per-role model inputs, **Test connection** (live probe → lists gateway models) and **Save & activate**, probe-status banner. |

### 4.12 `src/components/ui/` + `src/hooks/`

`src/components/ui/` holds 48 stock **shadcn/ui** primitives (button, dialog, tabs, table, toast, form, chart, …) — theme via `globals.css` tokens; only the ones imported by the dashboard are in the production bundle. `src/hooks/` contains the matching shadcn hooks: `use-mobile.ts` (viewport detection for responsive shells) and `use-toast.ts` (toast store). These are generated code; modify only the dashboard components that consume them.

### 4.13 `scripts/` — seed, demo data, and the test suite

| File | Purpose |
|---|---|
| `seed.ts` | Idempotent demo seed: `demo@brownfield.dev` / `demo1234` + the `legacy-shop` project wired to `sample:legacy-shop`. |
| `create-sample-repo.ts` | Rebuilds `sample-repos/legacy-shop` from scratch — 15 commits of realistic history (2015→2024) including the deliberate legacy artifacts (INC-2231 retry workaround, refund race, frozen IDs, sync-IO persistence, 17 tests). Run after experimenting inside the sample repo. |
| `test-parser.ts` | Smoke test: Tree-sitter loading + symbol/import/call extraction on fixture files. |
| `test-intelligence.ts` | E2E of the intelligence pipeline: index the sample repo (isolated SQLite) → graph queries → hybrid retrieval → impact analysis assertions. |
| `test-agent-e2e.ts` | Full agent-run E2E in a standalone Bun process against an isolated DB with `AGENT_PROVIDER=heuristic`: task → investigate → impact → plan → approve → implement → verify → diff/commit assertions. `TASK=` env selects the scenario. |
| `mock-9router.ts` | A minimal OpenAI-compatible gateway (port 20129): implements `/v1/models`, `/v1/chat/completions`, `/v1/embeddings`, records every request (path/auth/model/prompt chars/wantsJson), and answers planner prompts with a valid PlanSchema JSON. Standalone: `bun scripts/mock-9router.ts 20129`. |
| `test-9router-e2e.ts` | 9router integration E2E via the **env-var path**: boots the mock gateway, points `LLM_BASE_URL` at it, runs a full agent pipeline, and asserts LLM calls were routed (count, auth header, model field, plan actually parsed from the LLM response, token usage recorded, run COMPLETED). |
| `test-settings-run.ts` | 9router integration E2E via the **DB-settings path** (the UI flow): talks to the live API — save provider settings → create task → run → approve → assert provider/model on the run row. |

### 4.14 `sample-repos/legacy-shop/` — the demonstration brownfield repo

A deliberately messy 2015-era Node.js order backend. This is the agent's playground:

```
legacy-shop/
├── README.md, docs/architecture.md     era-appropriate docs for the agent to mine
├── package.json                        node --test runner, zero deps
├── src/
│   ├── app.js                          HTTP server + route registration (entry point)
│   ├── config/config.js                port/db settings
│   ├── db/database.js                  JSON-file persistence (sync IO, NFS workaround)
│   ├── db/users.json, products.json    seed data (integer IDs frozen at base 1000)
│   ├── lib/legacyIds.js                frozen ID contract (reporting ETL)
│   ├── lib/tokens.js                   auth token helpers
│   ├── routes/{auth,orders,products}.js  thin HTTP handlers
│   └── services/{auth,order,payment,product}Service.js
│       paymentService.js               ← THE scenario: double-refund race across an
│                                          awaited legacy-gateway call + INC-2231
│                                          setTimeout retry the agent must preserve
└── tests/*.test.js                     17 passing tests + TODO'd concurrency test
```

The point: greenfield generators look impressive on clean code. This repo forces the agent to discover constraints that exist only in git history and comments — and to preserve them.

### 4.15 Runtime artifacts (git-ignorable)

| Path | Purpose |
|---|---|
| `db/custom.db` | The main SQLite database (created by `db:push`, populated by seed + usage). |
| `db/test-*.db` | Isolated databases created/deleted by the E2E scripts. |
| `.agent-data/repos/<repoId>/` | Materialized repository clones. |
| `.agent-data/workspaces/<runId>/` | Per-run git worktrees + agent branches — inspect after a run, delete freely. |
| `dev.log`, `server.log` | tee'd stdout of `dev`/`start`. |
| `.next/` | Next.js build output. |

### 4.16 Not part of the app (workspace scaffolding)

These directories exist in this hosted workspace but are **not** required when you copy the project locally — exclude them and everything still runs:

- `skills/` — hosting-environment skill packs (unrelated to the agent product).
- `examples/websocket/` — framework sample code.
- `tests/*.sh` — sandbox runtime self-tests of the hosting environment.
- `Caddyfile` — preview reverse proxy.
- `download/` — screenshots captured during verification.

---

## 5. Key flows in detail

### 5.1 "Create task" → commit (the golden path)

```
POST /api/projects/[id]/tasks
  → Task row (open) → engine.startRun()
  → AgentRun row (CREATED, provider+model recorded)
  → runLoop:
     DISCOVERING     workspace = createWorkspace() → git worktree + agent/<id> branch
     UNDERSTANDING   hybridRetrieve() → focused context (files, symbols, git, tests)
     IMPACT_ANALYSIS analyzeImpact() → risk + blast radius + evidence  → stateData
     PLANNING        generatePlan() → Plan row (proposed)              → stateData
     WAITING_FOR_APPROVAL  ← run pauses; UI shows PlanPanel with Approve/Reject
     [user approves] POST /runs/[id]/approve → Plan.status=approved → loop resumes
     IMPLEMENTING    implement() → diffs (LLM → guarded rewrite → deterministic)
     VERIFYING       verifyAndRepair() → TestRun rows
     FIXING          (loop, max attempts, classified failures)
     FINAL_REVIEW    finalReview() → secret scan + unintended-change check
     COMPLETED       finalResult summary
  [user commits]     POST /runs/[id]/commit → git commit on the agent branch
```

### 5.2 LLM provider resolution

```
getProvider()
  ├─ AGENT_PROVIDER=heuristic?           → heuristic (tests / offline)
  ├─ gateway.configured && /models OK?   → OpenAICompatProvider   ← your 9router
  ├─ glm.available()?                    → GLMProvider            ← sandbox SDK
  └─ else                                → heuristic
(cached 60 s; resetProviderCache() on settings save)

chat() → POST {base}/chat/completions  { model? per-role, messages, response_format? }
embed() → gateway only if LLM_EMBEDDING_MODEL, else local deterministic embedder
```

---

## 6. Extension points

| To add… | Touch only |
|---|---|
| A new LLM vendor | implement `LLMProvider` in `src/server/llm/`, register it in `index.ts`'s chain |
| A new language grammar | `tree-sitter-loader.ts` (load) + `languages.ts` (extension map) |
| A container sandbox tier | replace `sandbox/executor.ts` (interface stays) |
| Postgres + pgvector | `prisma/schema.prisma` (swap datasource, JSON→vector columns) |
| WebSocket live events | replace the polling in `runs/[id]/events` + `run-view.tsx` |
| New agent tool | `agent/tools.ts` (gateway registry) |
| New dashboard tab | `components/dashboard/` + a view type in `lib/types.ts` |
