# AEGIS — Brownfield Engineering Agent

An AI agent that works on **existing** codebases. It investigates before it changes, plans before it patches, asks before it implements, and verifies before it reports success.

> **Understand first. Change second.**

---

## What it does

The defining feature: **the agent must understand an existing system before modifying it.** This is not a chatbot and not an LLM wrapper — repository intelligence (Tree-sitter symbol index, dependency graph, semantic index, git history) grounds every step.

The end-to-end workflow:

```
Create Project → Connect Repository → Repository Analysis (indexing)
   → System Map → Create Engineering Task
   → Agent Investigation (hybrid retrieval: semantic + keyword + symbol + graph + git + tests)
   → Impact Analysis (blast radius, risk LOW/MEDIUM/HIGH/CRITICAL, compatibility concerns)
   → Implementation Plan (objective, files, API/DB changes, tests, risks, rollback)
   → Human Approval  ← nothing changes in the repo before this
   → Implementation in an isolated git worktree
   → Verification (build / tests / lint / typecheck in a sandbox)
   → Failure Classification & Repair (agent_caused vs pre_existing vs flaky vs environment)
   → Final Review (diff, security scan, unintended-change detection)
   → Diff / Commit on an isolated branch
```

The built-in sample repository (`legacy-shop`) is a deliberately messy brownfield codebase — legacy VMS gateway workarounds documented only in git history, a known refund race condition, frozen ID contracts, hand-rolled 2015-era infrastructure — so you can watch the agent handle real constraints rather than greenfield code.

> 📐 For a **file-by-file deep dive** (every module explained), read [`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## Local setup & run

### Prerequisites

| Tool | Version | Why |
|---|---|---|
| **Bun** | 1.2+ | Runtime + package manager + test runner (`curl -fsSL https://bun.sh/install \| bash`) |
| **Git** | any recent | Worktree isolation, history tools, diffs — on Windows install [Git for Windows](https://git-scm.com/download/win) |
| Node.js | 21+ (22 recommended) | Runs the analyzed repo's test suite inside the sandbox (Node 21+ expands test-runner globs natively on Windows) |
| A git-capable LLM endpoint | optional | Your 9router / OpenRouter / LiteLLM / Ollama — otherwise the deterministic offline provider is used |

> **Windows, macOS, and Linux are all supported.** Process spawning goes through an explicit platform shell (`cmd.exe` on Windows, `bash`/`sh` on POSIX) — Bun's `execSync` default (`/bin/sh`) is deliberately never relied upon.
>
> Tree-sitter ships as native modules (`tree-sitter`, `tree-sitter-javascript`, `tree-sitter-typescript`, `tree-sitter-python`). They are listed in `trustedDependencies` and Bun compiles them automatically on `bun install`. On Linux you need a C toolchain (`apt install build-essential`); on macOS Xcode Command Line Tools suffice; on Windows the MSVC build tools that ship with `bun`/VS Build Tools handle it (if the native build fails, `npm rebuild` in a terminal with VS tools on PATH fixes it).

### 1 — Get the code

Copy or clone the project directory to your machine, e.g.:

```bash
git clone <your-fork-or-bundle-url> aegis
cd aegis
```

> The app code lives in `src/`, `prisma/`, `scripts/`, `sample-repos/` and the root config files. Directories such as `skills/`, `examples/`, `tests/*.sh`, `Caddyfile`, `db/test-*.db` and `download/` are workspace scaffolding/artifacts — they are **not** required at runtime (see ARCHITECTURE.md §"Not part of the app").

### 2 — Install dependencies

```bash
bun install
```

This also runs `prisma generate` post-install hooks and builds the native Tree-sitter grammars.

### 3 — Configure the environment

```bash
cp .env.example .env
```

Then edit `.env`:

```env
DATABASE_URL=file:./db/custom.db          # SQLite file; created in step 4
SESSION_SECRET=<openssl rand -hex 32>     # required in production
```

Ensure the directory for the SQLite file exists (`mkdir -p db`).

### 4 — Create the database schema

```bash
bun run db:push        # prisma db push — creates tables in the SQLite file
```

### 5 — Seed the demo account & sample project

```bash
bun scripts/seed.ts
#   user:    demo@brownfield.dev / demo1234
#   project: legacy-shop (sample repository)
```

### 6 — Start the dev server

```bash
bun run dev            # http://localhost:3000
```

Open <http://localhost:3000>, sign in with `demo@brownfield.dev` / `demo1234`, open the **legacy-shop** project, and click **Analyze repository**. Then create a task and watch the full workflow (see "Try these tasks" below).

### 7 — (Optional) connect your LLMs

Without any LLM the app still works end-to-end using the built-in deterministic provider. To use real models through your gateway, see the next section.

---

## Connecting your LLMs (9router / OpenRouter / LiteLLM / Ollama / vLLM)

You already have a 9router URL + key — yes, that's all you need. Two ways to connect:

**Option A — in the UI (recommended):** click the **plug icon** in the dashboard header → enable the gateway → paste your base URL (e.g. `http://localhost:20128/v1`) and master key → **Test connection** (lists the models your gateway serves) → **Save & activate**. Settings are stored in the database, take effect immediately (no restart), and are reloaded at every server boot. The API key never round-trips to the browser — the UI only shows a masked value.

**Option B — environment variables** (headless / CI / Docker): add to `.env`:

```env
LLM_BASE_URL=http://localhost:20128/v1   # your 9router endpoint (the /v1 is required)
LLM_API_KEY=your-master-key
LLM_PROVIDER_NAME=9router                # display label
# optional per-role routing:
# LLM_MODEL=...            LLM_FAST_MODEL=...
# LLM_REASONING_MODEL=...  LLM_CODING_MODEL=...
# LLM_EMBEDDING_MODEL=...  (leave unset to keep local embeddings — see note)
```

How the app picks the provider (priority chain, re-probed every 60 s):

```
gateway (9router, if configured & reachable)  →  GLM (sandbox SDK)  →  deterministic offline
```

Behavior details:

- **No model configured?** The `model` field is omitted from requests, so 9router's own routing (model combos / fallback chains) decides — one endpoint, all your subscriptions.
- **Per-role models**: `fast` (overview/quick calls), `reasoning` (planning, impact), `coding` (patch generation) can each be pinned to a different model.
- **Embeddings stay local** unless you set `LLM_EMBEDDING_MODEL`. This is deliberate: vectors must be consistent between indexing and querying. If you switch embedding models, **re-run repository analysis** so documents are re-embedded with the new model. Gateway embedding failures fall back to the local embedder automatically.
- **Runs are labeled**: each run records `provider` + `model` (e.g. `9router / your-fast-model`), visible in the run view.
- **Failsafe**: if the gateway goes down mid-run, the engine logs it and degrades to the next provider in the chain.

---

## Production build

```bash
bun run build          # next build (standalone output) + static assets
bun run start          # NODE_ENV=production, serves the standalone build
```

The standalone server honors the same `.env` (set real `SESSION_SECRET`, `DATABASE_URL`, and your gateway vars before building).

---

## Architecture at a glance

```
src/
├── app/                        Next.js 16 App Router
│   ├── page.tsx                the dashboard (single-page app shell)
│   └── api/                    REST endpoints (auth, projects, repos, tasks, runs, settings)
├── server/
│   ├── intelligence/           REPOSITORY INTELLIGENCE (the core): Tree-sitter parsing,
│   │                           symbol index, dependency graph, semantic + hybrid retrieval,
│   │                           impact analysis, git history tools, overview synthesis
│   ├── agent/                  ORCHESTRATOR: state-machine engine, planner, coder,
│   │                           verifier, tool gateway (20 tools), event log, patcher
│   ├── sandbox/                ISOLATION: ephemeral git worktrees + hardened executor
│   ├── llm/                    MODEL ABSTRACTION: OpenAI-compatible gateway (9router),
│   │                           GLM, deterministic fallback — one interface for all
│   └── api-helpers.ts          auth guard + background analysis jobs
├── lib/                        shared types & primitives (db, auth, session)
└── components/dashboard/       the developer dashboard UI
```

**Why these choices**

- **Single Next.js app, no microservices.** Orchestrator, intelligence, sandbox, and background jobs all live in one deployable process. Operationally simple, as an MVP should be.
- **SQLite + Prisma.** Zero external database dependency locally; the schema maps 1:1 onto the PostgreSQL + pgvector production design (embedding vectors are JSON columns today, `vector` columns on Postgres).
- **Local deterministic embeddings.** The `embedding` role is served by a local hashed-TF vectorizer, so semantic retrieval works fully offline and stays consistent. A real embedding provider slots into the same interface.
- **LLM abstraction.** Nothing outside `src/server/llm/` knows which vendor is in use. Set `AGENT_PROVIDER=heuristic` to run the entire system offline.

Full file-by-file documentation: **[`ARCHITECTURE.md`](./ARCHITECTURE.md)**.

---

## How to run the agent

1. **Create a project** (or use the seeded `legacy-shop` project).
2. **Connect a repository** — three source types:
   - `sample` — the built-in legacy-shop brownfield repo
   - `local` — an absolute path to a git repo on the server
   - `remote` — a `https://` or `git@` git URL
3. Wait for **repository analysis** (file walk → Tree-sitter parsing → graph → semantic index → git history). Progress is shown live.
4. **Create a task** describing the engineering change in plain language.
5. Watch the **live activity timeline** as the agent investigates, analyzes impact, and proposes a plan.
6. **Approve or reject the plan** — the approval gate is hard: no repository modification happens before approval.
7. After approval the agent implements in an **isolated git worktree** on its own branch, runs the test suite, classifies/repairs failures, and presents the **final diff + verification results**.
8. Optionally **Commit changes** — an explicit, user-triggered git commit on the agent branch.

### Try these tasks

| Task | What you should observe |
|---|---|
| `Add a product search API endpoint for searching products by name` | Clean routes→services layering discovered; route registered before `/:id`; new tests written; risk MEDIUM |
| `Fix the race condition in payment processing that causes double refunds` | Impact analysis flags the INC-2231 legacy workaround from git blame; plan explicitly preserves the retry block; risk HIGH; concurrency regression test generated |

## Using the sample project

The seeded `legacy-shop` project connects to `sample-repos/legacy-shop`. To rebuild its git history from scratch (e.g., after experimenting inside it):

```bash
node scripts/create-sample-repo.ts     # or: bun scripts/create-sample-repo.ts
```

The script recreates 15 commits (2015→2024) including the deliberate legacy artifacts:

- `HACK: keep setTimeout retry in paymentService — required for legacy VMS gateway (INC-2231)` — git-documented workaround
- known double-refund race (read-modify-write across an awaited gateway call)
- frozen integer ID contract (base 1000, reporting ETL)
- synchronous-IO persistence layer (NFS-era data-loss workaround)
- 17 passing tests + a TODO'd concurrency test the agent is expected to complete

---

## Running tests

```bash
# sample repository test suite (17 tests)
cd sample-repos/legacy-shop && node --test tests/*.test.js

# parser smoke test (Tree-sitter symbol extraction)
bun scripts/test-parser.ts

# repository intelligence pipeline E2E (index → graph → retrieval → impact)
bun scripts/test-intelligence.ts

# full agent run E2E with the deterministic provider (no LLM required)
bun scripts/test-agent-e2e.ts

# variant: race-condition task
TASK="Fix the race condition in payment processing" bun scripts/test-agent-e2e.ts

# 9router / gateway integration E2E (starts a mock gateway, asserts routing,
# auth headers, plan-from-LLM, usage accounting)
bun scripts/test-9router-e2e.ts

# gateway settings via the live API (DB-backed config path)
bun scripts/test-settings-run.ts

# lint
bun run lint
```

The E2E tests use isolated SQLite databases (`db/test-*.db`) and clean up after themselves. `test-9router-e2e.ts` and `test-settings-run.ts` are safe to run without a real 9router — they boot `scripts/mock-9router.ts` internally.

---

## Security model

- **Authentication**: scrypt password hashing, HMAC-signed session cookies, per-user project isolation on every query.
- **Dual-path auth**: session cookie (top-level site) + `Authorization: Bearer` fallback (embedded/iframe contexts where third-party cookies are blocked).
- **Sandbox**: the agent's tools run inside an isolated git worktree; command execution goes through an allowlist (node, git, npm, pytest, …), forbidden-pattern screening (no `sudo`, `curl`, `ssh`, command chaining or piping, absolute outside-workspace paths), per-command timeouts, output caps, `ulimit` CPU/memory/file-size ceilings on POSIX (Windows uses timeouts + caps via `cmd.exe`), and a **minimal environment** — only `PATH` and the OS-level variables required for process resolution; no host credentials or user configuration ever reach the agent.
- **Approval gates**: plans require explicit human approval; commits require an explicit user action; nothing auto-deploys; no protected-branch merging.
- **Audit logs**: auth events, project/repo/task creation, approvals, commits, and provider changes are recorded.
- **Secret scan**: the final review screens added lines for AWS keys, private keys, tokens, and hardcoded credentials.
- **Brownfield guard**: full-file rewrites that would delete git-documented legacy markers ("DO NOT REMOVE", "HACK", "INC-…") are rejected and re-requested with corrections.

## Observability

Every run produces a structured event log (`agent_events`): timestamps, phases (repository → investigation → impact → plan → approval → implementation → verification → fix → review), tool calls with argument/result summaries, model + token usage, errors, and the final result. The UI timeline renders this log live. Private chain-of-thought is never exposed or stored — only concise action summaries.

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | *(required)* | SQLite database location, e.g. `file:./db/custom.db` |
| `SESSION_SECRET` | dev secret | HMAC key for session tokens — **set this in production** |
| `AGENT_PROVIDER` | auto (gateway → GLM → heuristic) | `heuristic` forces the deterministic offline provider |
| `LLM_BASE_URL` | unset | Your gateway base URL (e.g. `http://localhost:20128/v1`) — **enables the gateway path** |
| `LLM_API_KEY` | unset | Gateway key, sent as `Authorization: Bearer` |
| `LLM_PROVIDER_NAME` | `gateway` | Display label (e.g. `9router`) |
| `LLM_MODEL` | unset | Default model for every role |
| `LLM_FAST_MODEL` / `LLM_REASONING_MODEL` / `LLM_CODING_MODEL` | unset | Per-role model overrides |
| `LLM_EMBEDDING_MODEL` | unset | Route embeddings through the gateway (else local deterministic) |
| `LLM_TIMEOUT_MS` | `180000` | Per-request timeout |
| `GLM_MODEL` | provider default | Override the GLM model (sandbox environments) |
| `PRISMA_LOG` | `error` | Set `query` to log all SQL |

No API keys are committed to the repository. UI-entered gateway settings are stored server-side only and masked in API responses.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `spawnSync /bin/sh ENOENT` after approving a plan | Fixed — the app now spawns an explicit platform shell. Update to the current code and restart `bun run dev`. (Old builds on Windows hit this because Bun's `execSync` defaults to `/bin/sh`, which doesn't exist there.) |
| `bun install` fails on tree-sitter | Install a C toolchain (`build-essential` / Xcode CLT / VS Build Tools) and re-run; the four tree-sitter packages are native modules |
| `Error: SQLite database does not exist` / weird schema errors | Ensure `DATABASE_URL` points to a writable path whose directory exists, then re-run `bun run db:push` |
| Login loops back to the login screen | Almost always an env issue: confirm the server restarted after you changed `SESSION_SECRET`/`.env`; clear the site's localStorage + cookies once |
| Agent runs show provider `heuristic` although a gateway is configured | The gateway probe failed — check the plug-icon dialog status banner, verify the URL ends in `/v1`, and that the key is valid; probe results are cached 60 s |
| Semantic search returns nothing after switching `LLM_EMBEDDING_MODEL` | Re-run repository analysis so documents are re-embedded with the new model |
| Port 3000 busy | `bun run dev -- -p 3001` (or edit `package.json`) |
| Agent branch conflicts on re-runs | Each run creates a unique branch (`agent/<runId-suffix>`); stale worktrees under `.agent-data/workspaces` can be deleted safely |

---

## Known limitations

- Remote repository cloning uses `--depth 50`; very large repos exceed the 5000-file index cap.
- The LLM diff path is best-effort: models produce imperfect unified diffs, so the coder degrades to full-file rewrites (legacy-guarded) and then to deterministic patterns. Every degradation is logged.
- Docker-level sandboxing (per spec §12's container tier) is represented by the hardened process sandbox (allowlist + ulimits + clean env); swapping in a container runtime means replacing `sandbox/executor.ts` only.
- Workspaces persist after runs for inspection; there is no automatic garbage collection yet.
- GitHub PR creation is stubbed at the "commit on branch" step — no OAuth app integration in this MVP.

## Next recommended improvements

1. PostgreSQL + pgvector migration (schema is designed for it) and real embedding provider.
2. Docker-container sandbox tier behind the existing executor interface.
3. GitHub App integration for PR creation from agent branches.
4. WebSocket push instead of event polling.
5. Language servers (LSP) for precise type-aware reference resolution on top of Tree-sitter.
6. Incremental re-indexing (currently full re-index per analysis).
7. Agent-driven tool-loop mode: let the planning LLM call tools iteratively instead of single-shot prompting.
