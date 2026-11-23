# Why Lift Log "merges land in C:/Users/Colin/local-test/origin.git"

Report only. No source files were changed. The Lift Log registration itself lives in the local Local database, which this investigation did not open. The conclusion below comes from the code, plus the path in the message.

## Short answer

The message is a display of the project's **resolved forge origin**. In this build that origin is always a local bare repository. `resolveLocalOrigin()` in `src/forges.ts` throws for any remote URL, because the GitHub forge adapter is not built.

For Lift Log, the origin therefore resolves to `C:/Users/Colin/local-test/origin.git` in one of two ways:

1. `projects.forge_origin` was set to that path with `vizor-local configure --forge-origin` (`src/cli.ts:172`). It can also have been set through the `configureProject` call that the server makes.
2. `forge_origin` is NULL, and the checkout's `origin` remote is that path.

The second case is the likely one. The path is the same shape as the `origin.git` that `createTargetRepo` makes (`src/sandbox.ts:9`), and `local-test` looks like a scratch directory. A project registered against a checkout whose `origin` was a local bare repo keeps resolving to it.

This is intended PoC behaviour, not a bug. It is a confusing label, though, for a project the owner thinks of as a GitHub project.

## Code path

### Where the message is built
- `public/index.html:2546-2547`, in `renderProjects()`: `text: p.origin ? 'merges land in ' + p.origin : p.origin_error || ''`.
- `p.origin` and `p.origin_error` are computed server-side in `src/server.ts:107-108`, which runs `resolveLocalOrigin(p)` for each project in `/api/state`. The error text is shown instead when resolution throws.

### How the origin is chosen: `resolveLocalOrigin` (`src/forges.ts:13-22`)
1. `raw = p.forge_origin || git remote get-url origin` (run in `repo_path`).
2. If `raw` is empty, it throws "no origin remote and no forge origin configured".
3. If `raw` looks like a remote URL (`scheme://` or `user@host:`), it throws "…is a remote URL; the GitHub forge adapter is not built yet".
4. Otherwise `raw` is resolved to an absolute path. It must exist and be a bare git repository, or it throws.
5. It returns that path.

So the function can only ever return a local bare path. A GitHub URL can never be the origin.

### How it is stored
- Column: `projects.forge_origin TEXT` (`src/db.ts:19`, migrated at `src/db.ts:144`). The type comment is at `src/types.ts:29`: "null = use the checkout's origin remote".
- `addProject` (`src/projects.ts:28-71`) never writes `forge_origin`. It leaves the column NULL. It does require a usable origin:
  - If the checkout has no `origin` remote and `createOrigin` is set, it creates `<originsDir>/<id>.git` as a bare repo, adds it as `origin` and pushes the base branch (lines 48-61).
  - Line 63 calls `resolveLocalOrigin({... forge_origin: null})`. A checkout whose `origin` is a GitHub URL is therefore rejected at add time.
- `configureProject` (`src/projects.ts:87-90`) is the only writer. It validates with `resolveLocalOrigin`, so a GitHub URL is rejected there too (`test/step1.test.ts:68`).

### Where the origin is used
- `ForgeRegistry.get` (`src/forges.ts:29-43`) calls `resolveLocalOrigin` and builds a `LocalForge(origin, dbPath)` per project. PRs, checks and merges go through that forge, so a merge updates the bare repo's base branch.
- `src/sync.ts:9-28` runs `git fetch origin` in the owner's folder after a merge. It then fast-forwards the folder when it is clean. It uses the checkout's `origin` remote, which is the same bare repo in the case above.
- `src/merge.ts` has no origin logic. It works against the `Forge` it is handed.
- `src/setup.ts:36` sets the `origin` readiness flag to true when `project.origin` exists and has no error. `githubConnected` (`setup.ts:35`) checks a separate remote named `github`.

### Where GitHub comes in: a separate `github` remote
GitHub is reached only by the ship and auto-push flow, not by merges:
- `src/server.ts:206` handles `projects/<id>/github`, which calls `setGithubRemote` (`src/ship.ts:162-163`). That adds or updates a git remote named `github` in the checkout.
- `src/ship.ts:104` pushes the base SHA and a tag to `github`.
- `src/autopush.ts` pushes main to `github` once every task has merged, when `auto_push=1`.

The intended model is: tasks merge into the local bare origin, then the owner's folder is synced, then main is pushed to GitHub.

## Conditions that produce a local bare origin

Any of these resolves to a local path. All of them do so by design, because no other outcome exists:

| Condition | Result |
|---|---|
| `forge_origin` NULL, checkout `origin` is a local bare path | that path (the likely Lift Log case) |
| `forge_origin` set to a local bare path | that path |
| Project added with `--create-origin` and no `origin` remote | `<originsDir>/<id>.git` |
| `origin` or `forge_origin` is a GitHub or other URL | throws, and the UI shows the error instead of "merges land in" |

For Lift Log to show `local-test/origin.git`, its checkout's `origin` remote (or its `forge_origin`) points there. Run `git -C <lift-log checkout> remote -v` and `vizor-local` project listing (`src/cli.ts:109`) to confirm which of the two it is. That check was not run here.

## Intended or not?

Intended for the PoC. The comment above `resolveLocalOrigin` says so, and tests pin it. The message is accurate: merges do land in that bare repo, and GitHub only gets them through the `github` remote and auto-push or ship.

Two things are real problems:
- The wording "merges land in" is easy to read as "merges land in the project's real remote". It does not say the path is a local scratch repo, or that GitHub is a later push.
- A stale test-fixture origin can stay attached to a real project with no warning. It is valid, so it never errors.

## Options

None of these is applied.

1. **Leave the behaviour, repoint the project.** Create or choose the right bare repo, then `vizor-local configure <id> --forge-origin <bare path>`. This can also be done by changing the checkout's `origin`. Trade-offs: no code change and low risk. It still leaves the PoC two-hop model, and an old `<id>.db` forge keeps PRs tied to the old origin. `ForgeRegistry.get` swaps the forge when the origin changes.
2. **Clarify the UI text.** Change the label to something like "Local forge (merges land here, then push to GitHub)", and show the source (`forge_origin` or checkout `origin`). Trade-offs: tiny, `public/index.html` only, but it does not change where merges go. It needs the server to return the source, or two strings.
3. **Warn on suspicious origins.** In `/api/state` or setup, flag origins inside a temp or `local-test` directory, or ones that differ from the `github` remote's repo. Trade-offs: catches this class of mistake. The heuristics are fragile, and it adds a new setup state to test.
4. **Build the GitHub forge adapter.** Make `resolveLocalOrigin` stop rejecting URLs and let `ForgeRegistry` pick a GitHub-backed `Forge` (the `ForgeProvider` type already exists in `src/forge.ts`). Merges would then land on GitHub. Trade-offs: that is the real fix for "merges land on GitHub", but it is a large change. It touches auth, rate limits, the PR and check model, the `sync.ts` assumptions, and the tests that assert the rejection (`test/step1.test.ts:68,75`). It also drops the offline-friendly local model.
5. **Stop falling back to the checkout's `origin`.** Require `forge_origin` to be explicit, or have `addProject` always write it. Trade-offs: removes the silent inheritance behind this report. It needs a migration for existing rows and would break projects whose `origin` already works.

Recommendation: do option 1 now if the path is wrong, and option 2 as a small follow-up. Defer option 4 until GitHub-native merging is actually wanted.
