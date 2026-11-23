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
npm ci
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

## Updates

Vizor Local checks GitHub for a newer version of itself. This is the only time it contacts the internet on its own.

- **What it contacts:** `https://github.com/colinosbo/vizor-local`, when Vizor starts, every 6 hours while it runs, and when you click Check for updates.
- **What it fetches:** the `main` branch of that repository, with plain `git fetch`. It stores it under a private ref (`refs/vizor/upstream`) in the install folder. It adds no git remote, changes no git settings, and sends no account details, extra headers or query strings. Your own git sign-in is not used for this.
- **What it does with it:** it counts how many commits you are behind and shows their titles. Nothing is installed until you click Update.
- **Turn it off:** in the dashboard's update settings, or send `POST /api/update/settings` with `{"checkEnabled": false}`. This stops both the automatic and the manual check. It is stored as `update_check_enabled` in the local database.

Clicking Update only works for a git clone with no local changes, that is strictly behind GitHub, while no worker is running. Vizor copies its database to `~/.local-poc/backups/` (the last 3 are kept), closes, fast-forwards the folder, runs `npm ci` and the build, and starts again. If any step fails it goes back to the version you had, rebuilds it, starts it and shows you the error. After an update you can go back to the previous version once. A copy installed from a zip cannot update itself; download the new version from the repository instead.

The update source can only be changed when Vizor starts, with `serve --update-upstream <url>` or the `VIZOR_UPDATE_UPSTREAM` environment variable. Nothing in the dashboard or its API can change it.

## More

Details on the CLI, per-project settings, internals and what is not built yet: [docs/reference.md](docs/reference.md).

## Third-party

The bundled unslop skill (`skills/unslop`) was created by Damir Sokolovsky ([@heydamir](https://github.com/heydamir)) and is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Source: https://github.com/heydamir/unslop. The copy in this repository was modified (it inlines the Tokens and Signs references) and stays under CC BY 4.0. See [NOTICE.md](NOTICE.md).

The rest of the repository is MIT licensed, see [LICENSE](LICENSE).
