# Vizor Local lifecycle recovery plan

## 1. Project onboarding and base authority

- Add a GitHub source to Projects and the CLI. Accept a repository URL or owner/repo, clone to an empty destination, or link a compatible checkout after proving shared history. Keep existing remotes and uncommitted files. Report unrelated history before registration.
- Use the configured repository and base branch for planner snapshots, worktrees, publication, PR freshness, review and folder sync. Local forge projects keep their local authority. Expose local versus GitHub drift in Ship.
- Hold dispatch when the authoritative base is missing. Record the draft and actual attempt base SHAs. Revalidate scope at approval when the base advances. For a stale branch, merge the base into the task worktree, check scope, publish the resulting head and verify it again. Keep a pending head record across a crash. Conflicts need a scoped worktree resolution or a revised plan when the fix spans tasks.

## 2. Execution, CI and merge recovery

- Keep durable identity across task, attempt, PR head and squash commit. Journal local squash candidates before changing the base ref. Reconcile a known merge intent after restart and start missing verification.
- Route Retry by failure stage. Resume failed publication from the successful worker output. Resume post-merge verification on the same SHA. When a fix or revert lands on main, let the owner request verification of an authoritative base descendant.
- Track the reason and elapsed time for checks, wait with bounded polling, reject wrong check sources and conflicting head results, and surface moved or closed PRs. Rerun GitHub Actions when the check identifies a run and the account can rerun it. Keep dependent tasks held until verification passes.
- Keep cancellation and graph rerouting explicit. A cancelled prerequisite whose output is required needs replacement work before downstream execution is safe.

## 3. Planning and roadmaps

- Draft from a verified detached checkout so owner work in progress cannot skew a plan. Check malformed task data and oversized requests before dispatch.
- Persist chat requests and roadmap progress. Recover interrupted chat requests and persist one automatic retry for transient planner failures. Keep manual retry available after exhaustion. Store a roadmap draft and its phase binding together.
- Show the wait reason in Run, check actions on the task, and planner retry information in the plan timeline. Distinguish a phase that shipped work from one whose tasks were all cancelled.

## 4. Verification and rollout

- Test interrupted merge publication, missing CI, fresh verification after a failed squash check, closed and moved PRs, planner restart, malformed drafts, and unresolved bases. Check that independent work still starts and dependents wait for verified results.
- Exercise GitHub onboarding on an existing checkout and an empty destination. Confirm GitHub Actions produces the selected check on PR commits and base pushes. Verify that protected branches require CI and up-to-date branches according to the repository's policy.
- Run npm test. Ship the changes through a branch and PR before updating the local instance. Back up its database as part of the normal update flow. Review the first shared-repository run through its post-merge check.
- Follow-up coverage should inject a restart between each real Git side effect, including branch push before PR creation and base push before PR state recording. Cross-scope code repair and restarting work after a revert still require a new approved task.
