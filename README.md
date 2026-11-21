# Vizor Local — proof of concept

PoC of the runtime from *Local — implementation plan for a coding agent*: an orchestrator drafts a plan, the owner approves it once, a scheduler runs Claude Code workers in per-task worktrees, Local publishes PRs, repairs CI failures, and a checked merge authority merges only verified, in-scope PRs.

```bash
npm install
npm test                 # 34 tests: unit, recovery, step-1 (multi-project, planning, server), end-to-end
npm run demo             # scripted run against a disposable "Demo App" repo, prints evidence
node dist/src/cli.js demo --serve --approve-delay 15000   # same, with the dashboard (open the printed URL)
```

## Start it (Windows)

Double-click **Start Vizor Local.cmd** (first run also puts a *Vizor Local* shortcut on the desktop). It installs dependencies if needed, builds, copies bundled skills (unslop) to `%USERPROFILE%\.claude\skills`, starts the server with the Claude planner and workers, and opens the browser already signed in. Double-clicking again while it runs just opens the running one (one server per data folder).

## Step 3 features

- **Folder sync:** after each merge, the project folder is fast-forwarded to the local origin. Skipped (with the reason shown in Ship) if the folder is on another branch, has uncommitted changes to tracked files, or has its own commits.
- **Roadmap:** paste phases (separated by `---`) in the Plan view. Vizor drafts phase 1, and each next phase once every task of the previous phase has merged and no other work is running. Every plan still needs your approval. A failed or declined phase stops the roadmap until you retry it.
- **Push to GitHub (Ship):** connect a `github` remote, review the commits GitHub lacks, confirm, and Vizor pushes exactly that commit. Fast-forward only: refuses if GitHub has commits Local has not seen or if main changed since you reviewed. Uses your own git credentials; Vizor stores none.

## Using it on your own repos

```bash
vizor-local add <folder> --create-origin --ci "npm ci && npm test" --workers 2   # one project per folder
vizor-local projects                                                              # list projects, forge, CI command
vizor-local config <project> --ci "npm test" --workers 3                          # change settings later
vizor-local serve --orchestrator claude --worker claude                           # open the printed URL
```
(`vizor-local` = `node --disable-warning=ExperimentalWarning dist/src/cli.js`; data lives in `~/.local-poc`, override with `--data`.)

- **Forge per project.** Each project's "GitHub" is a local bare repo: its `origin` remote, or one created by `--create-origin` under `~/.local-poc/origins/<id>.git` (also runs `git init` + first commit if the folder is not a repo yet, with a default `.gitignore`). PRs/checks live in `~/.local-poc/forges/<id>.db`. A remote-URL origin is refused (GitHub adapter not built); that project gets no work and shows `forge unavailable`, other projects keep running.
- **CI command per project.** Run by the shell (`&&` works) in a clean clone of the exact SHA, 15-minute timeout, whole process tree killed on timeout. Workers and the planner are told to use exactly this command.
- **Planning runs in the background.** Sending a request returns at once; the dashboard shows *Drafting plan…* with elapsed time and the planner's latest step. Events: `plan_requested → plan_progress* → plan_ready | plan_declined | plan_failed`. A planner reply with no tasks is a decline (message only, no plan version). One request per project at a time.
- **Server.** Tries 4317, then the next free port. Every launch has a new key in the printed URL (stored as an HttpOnly cookie); requests without it, or with a foreign `Host`, are refused.
- **Upgrading from the first PoC build:** the old `~/.local-poc/forge.db` is adopted automatically by the project that has PRs; `--forge-origin` is no longer needed.

Requires Node ≥ 22.13 (uses built-in `node:sqlite`, no native driver) and git.

## What the demo proves (real git, real CI command, fake workers)

| Plan scenario | Result |
|---|---|
| Two independent tasks on one repo | `history-ui` and `rest-timer` run in parallel (cap 2), separate worktrees, branches and PRs |
| Third ready task, no free slot | Waits until a slot frees |
| CI failure → repair | `rest-timer` fails `local-ci`, one repair on the **same branch and PR**, fresh CI on the new head, merged |
| Duplicate CI delivery | Redelivered failure returns `duplicate`; exactly one repair key recorded |
| Base advances while PR is open | Second green PR is stale → controlled update from `main` → fresh CI → merged (old green check cannot approve the new head) |
| Dependency handoff | `history-export` starts only after `history-ui` merged **and** post-merge CI passed, from the merged SHA |
| Out-of-scope change | `readme-badge` edits `README.md` → never published, held with exact reason |
| Final `main` | 3 squash commits, all tests green |

## Layout

| File | Owns |
|---|---|
| `src/db.ts` | SQLite schema: projects, plans, tasks, attempts (one active per task, DB-enforced), repairs, events |
| `src/plan.ts` | Validation (cycles, missing deps, unsafe/overlapping scope), drafts, owner-only approval, versioning |
| `src/runner.ts` | Transactional claims, project + global caps, fair round-robin, launch, publish, repair loop, merge, restart reconciliation, controls |
| `src/merge.ts` | Merge authority — fails closed (17 hold codes) |
| `src/forge.ts` | `Forge` interface + `LocalForge` (bare repo, PRs, trusted CI per exact SHA, SHA-guarded squash merge) |
| `src/forges.ts` | `ForgeRegistry`: one forge per project, origin resolution, legacy `forge.db` adoption |
| `src/planning.ts` | Background planning with progress events |
| `src/projects.ts` | `add` (incl. `--create-origin`), `config`, launcher lookup |
| `src/workers.ts` | `ClaudeCodeWorkerFactory` (`claude -p --output-format stream-json`) and `FakeWorkerFactory` |
| `src/orchestrator.ts` | Claude-backed plan drafting (`--json-schema`, streamed for progress) and a canned one; cannot approve anything |
| `src/server.ts`, `public/index.html` | Local dashboard: chat, plans, task/run view, SSE replay by cursor, pause/cancel/retry/caps |
| `src/cli.ts` | `vizor-local demo | serve | add | config | projects | open .` |

## Status — implemented vs not

**Implemented and tested:** everything in the table above; restart cases (after claim, after PR publication, dead process with PR → adopt, dead process without result → held as uncertain, never relaunched); stale-check / head-moved / rename-both-paths / ambiguous / untrusted-check holds; cap lowering without killing active work; pause; event replay with no gaps; launcher lookup for paths with spaces.

**Verified live on Windows (Claude Code 2.1.328, first build):** real planner + workers drafted, coded, and merged 4 tasks across two plans.

**Implemented in step 1, tested here (Linux) but not yet on Windows:** per-project forges/CI, `--create-origin`, background planning, port fallback, launch key. Specifically unverified: the planner in `stream-json` mode with `--json-schema` (previous build used `json`; a fake CLI covers both result shapes), `taskkill` tree-kill on Windows, CI repair via `--resume` with real Claude.

**Not built (later phases):**
- GitHub `Forge` adapter (`gh`/REST), repo settings, rulesets, trusted checked-merge Actions workflow (Phase 1)
- Electron shell, preload bridge, tray, installer, `vizor-local` PATH launcher, single-instance focus (Phase 4)
- OS-level worker sandbox / dedicated runner account (Phase 2 note — worktrees only isolate the checkout)
- Process identity beyond PID (PID reuse), history archive/cleanup, real-concurrency measurement on your host
- `node:sqlite` inside Electron's bundled Node: unverified
