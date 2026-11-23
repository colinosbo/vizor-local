# Vizor Local

You describe what to build. Vizor drafts a plan, it waits for your approval (unless you turn on per-project auto-approve for roadmap phases, which only covers small, safe plans), and Claude Code workers build it in parallel. Each task becomes a pull request, CI checks it, and passing PRs merge on their own.

## Install with an AI agent

Paste this into Claude Code (or any coding agent) opened in an empty folder:

```
Clone https://github.com/colinosbo/vizor-local, then read its README and package.json.
Check that Node 22.13+, git and Claude Code are installed, and tell me if any are missing.
Run the install and start steps from the README, run the tests, and report the URL it prints
and anything that failed. Do not change any files outside the cloned folder.
```

## Install it yourself

You need Windows, [Node 22.13+](https://nodejs.org), [git](https://git-scm.com) and [Claude Code](https://claude.com/claude-code), signed in.

1. Clone this repo.
2. Double-click `Start Vizor Local.cmd`. It installs, builds and opens the app in your browser.
3. Go to Projects, add a folder, and set the CI command (for example `npm test`).
4. Describe what you want built, read the plan, and approve it. Plans wait for you unless you turn on auto-approve for the project (see below).

Double-click again later and it reopens the one that is running. A desktop shortcut is created on first run.

## Run it by hand

```
npm install
npm run build
node --disable-warning=ExperimentalWarning dist/src/cli.js serve --orchestrator claude --worker claude --open
```

`npm test` builds and runs the test suite (41 tests).

## What it does

- Plans first. Nothing runs until a plan is approved. Plans wait for you unless you turn on per-project auto-approve. Even then, Local approves a roadmap phase's plan only when: that phase isn't set to "off"; auto-approve isn't halted; every earlier phase is done and merged; no task is pending or running; the plan is valid; it has at most 8 tasks; and it can't touch merge or plan code, package.json, CI config, `.github/`, `.claude/` or `skills/`. It never forces past in-flight work. A failed or blocked task halts auto-approve until you resume it. The planner itself can never approve.
- One git worktree per task, so workers never touch each other.
- Each task gets a PR in a local forge, with CI run on the exact commit.
- CI failures are repaired on the same branch, up to 2 times.
- A PR merges only if CI passed and it stayed inside its task's scope.
- Roadmaps: paste phases and Vizor plans each one when the last finishes.
- Optional push to GitHub, by button or automatically after a phase. Fast-forward only.

## Where your data goes

Everything lives in `~/.local-poc` on your machine. Vizor pushes to GitHub only when you click Push or turn on auto-push for a project, using your own git sign-in. It stores no credentials.

## More

Details on the CLI, per-project settings, internals and what is not built yet: [docs/reference.md](docs/reference.md).
