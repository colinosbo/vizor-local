# Real isolation for Local workers on Windows

Report only. No source files were changed.

## Verification status (read this first)

This report was meant to check every external claim against Microsoft Learn, the Docker docs and the Claude Code docs. **UNVERIFIED:** in the session that wrote it, the Microsoft Learn tools and the web search tool were both denied, and no page could be fetched. So **no external claim below is verified, and none has a citation.** Every statement about Windows, WSL, Docker, Windows Sandbox or Claude Code is marked **UNVERIFIED**. Where this report states something without that marker, it comes from this repo's code and is cited by file and line.

The pages to check first are listed under "Sources to check". They are leads, not citations. Someone with fetch access should walk the report, confirm or correct each marked claim, and replace the marker with the URL.

Edition support is not guessed. Wherever a source would have to say which Windows 11 edition works, the answer is **UNVERIFIED**. The dev machine that Local runs on reports Windows 11 Home (session environment), so Home is the edition that matters most.

## Short answer

The Phase 5 allowlist and deny rules are defense in depth. `src/isolation/env.ts:1-7` says the same thing: workers still run as the same OS account and can read anything that account can read. Real isolation means a different security principal (a user account) or a different kernel or VM boundary.

Provisional ranking, pending verification:

1. **Claude Code's built-in sandbox** is the cheapest to try. Whether it supports native Windows at all is **UNVERIFIED**, and it does not cover the CI command, which is not a Claude Code tool call.
2. **WSL2 or Docker** is the best fit for running both the worker and `npm ci && npm test` behind one boundary, if the edition and install questions check out.
3. **A dedicated low-privilege account** is the only option that keeps native Windows paths and tools. Its blocker is spawning into it without storing a password.
4. **Windows Sandbox** is a poor fit for a long-running, many-task orchestrator. Edition support is **UNVERIFIED**.

## What Local runs today (repo facts)

- Worktrees live under `<data dir>/worktrees/<task id>` (`src/runner.ts:245`, `src/cli.ts:128`).
- The worker is a child process started with `spawn(this.bin, args, { cwd: ctx.worktree, env, ... })` (`src/workers.ts:89`).
- CI is `spawn(this.ciCommand, { cwd: dir, env, shell: true, ... })` (`src/forge.ts:124`).
- Both inherit the Local server's account. That account holds the owner's git credentials, `~/.claude` sign-in and any `gh` token.
- `buildWorkerEnv` passes `CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_BASE_URL` through (`src/isolation/env.ts:37-42`). Any isolation option has to decide how those reach the worker.

A real boundary has to cover **both** the worker and the CI process. CI runs project code (`npm ci` install scripts, tests) that the worker may have modified, so it is the more dangerous of the two.

## Option 1: a dedicated low-privilege local Windows account

### Works on Home and Pro?
Local user accounts exist on every Windows edition, so creating the account is not the question. The spawn mechanisms below are where edition could matter. **UNVERIFIED:** whether `CreateProcessWithLogonW`, scheduled tasks, S4U and services behave identically on Home and Pro.

### Can Node spawn into it without a stored password?
Node's `child_process` has no `runas` option, so this needs a native helper, `runas.exe`, `schtasks` or PowerShell.

| Mechanism | Needs password? | Notes |
|---|---|---|
| `CreateProcessWithLogonW` | Yes, on every call (as recalled). **UNVERIFIED** | Local would have to store or prompt for the password. This is the case to avoid. |
| `runas /savecred` | Stores the credential in the user's vault. **UNVERIFIED** | Defeats the goal, because the owner's account can then read it. |
| Scheduled task registered to run as the worker account | Registration needs the password or an S4U logon type. **UNVERIFIED** | After registration, `schtasks /run` needs no password. Output has to travel through files, since a task has no stdio pipe back to Node. |
| S4U logon (`LOGON32_LOGON_S4U` or a task principal with logon type S4U) | No password, but the token has no network credentials and may not be usable for a full interactive-style process. **UNVERIFIED** | Local file work, git and Node may be fine. Anything needing network SSO is not. |
| A Windows service running as the worker account | Setting the account normally needs the password once. **UNVERIFIED** | The service then runs headless. Local would talk to it over a named pipe or a localhost port. A service is also a standing, privileged install, which is a heavy ask for a developer tool. |

Best candidate, pending verification: a scheduled task or service created once by an elevated setup step (the password is typed once and never stored by Local), after which Local triggers it with no secret. Whether that avoids storing the password is **UNVERIFIED** for each variant.

### Worktrees across the boundary
- **Path mapping:** none needed. Paths stay `C:\Users\...`. The worker account needs read and write on the worktree and read access to the repository's `.git` directory. Worktrees under `~/.local-poc` belong to the owner, so an ACL grant (`icacls`) or a data dir the worker account can reach is required. **UNVERIFIED** against Microsoft docs.
- **Ownership and `safe.directory`:** git refuses to operate in a directory owned by another user unless `safe.directory` lists it. **UNVERIFIED** (git docs, not fetched). Windows ownership and git's check interact in ways that need testing. Setting `safe.directory` in the worker account's own gitconfig is the likely fix.
- **Performance:** native NTFS, so no mount penalty.

### CI command and `node_modules`
`npm ci && npm test` works if the worker account has Node and git on `PATH` and can write the worktree. `node_modules` lives in the worktree, on NTFS, as today. A fresh account also needs its own npm cache (`%LOCALAPPDATA%\npm-cache`), so the first run is slow.

### Claude Code sign-in
The account has its own `~/.claude`, so it would need its own login. The practical routes are `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` in the worker env, which `buildWorkerEnv` already passes through. Whether the token can be generated for headless use is **UNVERIFIED** (Claude Code docs, not fetched). A token passed this way is readable by the worker, which is the same exposure as today but without the owner's other credentials.

### What breaks
- The worker cannot see the owner's `gh`, git credential manager or SSH keys. For merges that is a feature. Pushing to GitHub stays in Local, outside the worker.
- Tools installed per user (nvm, Volta, a user-level Node) are invisible to the new account.
- Setup needs an admin once.
- It does not stop network access, and does not limit CPU or memory.

## Option 2: Windows Sandbox

### Works on Home and Pro?
**UNVERIFIED.** Recalled but not checked: Windows Sandbox is not offered on Home. Do not rely on this, since Home is the dev machine's edition. If it is not available, the option is out for the project's main user.

### Can Node spawn into it without a password?
The `wsb` command-line tool and `.wsb` configuration files are the expected route. **UNVERIFIED** for the exact subcommands (start, exec, stop, share and so on), whether commands can be run non-interactively, and whether output can be read back. If `wsb exec` or similar exists, no password is involved. That is **UNVERIFIED**.

### Worktrees across the boundary
- **Path mapping:** `.wsb` files describe mapped folders (host path to sandbox path, read-only or writable). **UNVERIFIED.** Each task would map its own worktree.
- **Ownership and `safe.directory`:** mapped files probably appear owned by the sandbox's user, so `safe.directory` is likely needed. **UNVERIFIED.**
- **Performance:** mapped folders go through a virtualization layer. Speed for `npm ci` over thousands of small files is unknown. **UNVERIFIED.**

### CI command and `node_modules`
The sandbox starts from a clean Windows image, so Node and git would have to be installed or mapped in on every start. `node_modules` would live inside the sandbox if installed there (lost on close), or in the mapped worktree if installed there (back on the host, writable by the worker). Whether state persists between runs is **UNVERIFIED**.

### Claude Code sign-in
Nothing persists, so credentials have to be injected each run, through the env vars above or a mapped credentials folder. A mapped folder defeats the point. **UNVERIFIED** for the exact mechanism.

### What breaks
Start-up cost per task. Whether more than one sandbox can run at once is **UNVERIFIED** (recalled as one at a time). That alone would serialize Local's parallel workers.

## Option 3: WSL2 or Docker

### Works on Home and Pro?
**UNVERIFIED** for both. Recalled but not checked: WSL2 is available on Home and Pro, and Docker Desktop supports Home through its WSL 2 backend. Docker Desktop's license terms for a commercial user are also **UNVERIFIED**.

### Can Node spawn into it without a password?
- **`wsl.exe`:** `wsl.exe -d <distro> -- <command>` runs a command in a distro as the current Windows user. No password is needed. **UNVERIFIED** for the exact flags (`--user`, `--cd`, exit-code passthrough). Node can spawn `wsl.exe` like any other binary.
- **`docker run`:** works through the Docker CLI against the daemon. No Windows password. **UNVERIFIED.** Access to the Docker daemon is effectively root on the host, so the user running Local needs it, but the container does not.

### Worktrees across the boundary
- **Path mapping:** WSL sees Windows drives as `/mnt/c/...`, and `wslpath` converts. Docker takes a bind mount (`-v C:\path:/work`) or a volume. **UNVERIFIED** for the exact syntax. Git worktrees store absolute paths in `.git` files, so a worktree created by Windows git (`C:\...\.git\worktrees\x`) will not resolve inside Linux git. The fix is to create and run the worktree entirely inside the Linux side, or to run Windows git on the host only.
- **Ownership and `safe.directory`:** files on a Windows mount appear owned by the mapped Linux user in WSL. In Docker, the in-container user may not match, so `safe.directory` (`git config --global --add safe.directory /work`) is likely needed. **UNVERIFIED.**
- **Performance:** cross-OS file access (Linux tools on `/mnt/c`, or a Docker bind mount of a Windows path) is commonly reported as much slower than the Linux filesystem. Microsoft's guidance is to keep Linux-tool projects on the Linux filesystem. **UNVERIFIED** (this is the claim to confirm in `learn.microsoft.com/windows/wsl/filesystems`). For `npm ci` this matters a lot.

### CI command and `node_modules`
`npm ci && npm test` runs as normal inside a Linux environment with Node installed. Putting `node_modules` on the Linux filesystem (inside the distro, or a named Docker volume) avoids the mount penalty. It also keeps Windows-built native modules from colliding with Linux ones. A Windows `node_modules` and a Linux one cannot share a directory.

This also changes the test environment. The project is tested on Linux, not Windows, so a Windows-only bug would not show up there. CI may be Linux already, in which case this is a wash. That is a question for the project, not verified here.

### Claude Code sign-in
Inside WSL or a container, Claude Code needs its own config and login. Options are an env var (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`), or a mounted `~/.claude` folder. Mounting it exposes the owner's session to the worker. **UNVERIFIED** (Claude Code docs, not fetched).

### What breaks
- **WSL2 itself is weak isolation by default.** Recalled but not checked: a distro can reach Windows files through `/mnt/c` and can run Windows binaries through interop. Both can be turned off in `wsl.conf`. **UNVERIFIED.** A WSL distro without those switched off is not a security boundary against the owner's files.
- **Docker is stronger.** A container sees only what is mounted, and network and resources can be limited. **UNVERIFIED.**
- Virtualization must be enabled in firmware.
- Windows-only tooling is not available inside.
- Docker needs the daemon running, and the Home-edition path depends on WSL 2.

## Option 4: Claude Code's built-in sandbox setting

### Works on Home and Pro?
**UNVERIFIED.** Recalled but not checked: Claude Code's sandboxing uses OS-level mechanisms (Seatbelt on macOS, bubblewrap on Linux and WSL2), and native Windows support may not exist. If it needs WSL2, then edition support is the WSL question above. Do not rely on this recall.

### Can Node spawn into it without a password?
Nothing to spawn into. It is a Claude Code setting, enabled in settings or by command. **UNVERIFIED** for the setting names and the exact behaviour. No Windows account or password is involved.

### Worktrees across the boundary
There is no boundary to cross. The worker still runs in the worktree. What matters is which paths the sandbox allows writing to (the worktree, and probably the git directory for commits). A worktree's `.git` file points back to the main repository's `.git/worktrees/...`, which sits outside the worktree. Whether the sandbox allows writes there is **UNVERIFIED**, and it is the first thing to test. Ownership and `safe.directory` do not change, because the user does not change. Performance is native, as today.

### CI command and `node_modules`
**This is the main gap.** A Claude Code sandbox covers what Claude Code runs. Local's CI step (`src/forge.ts:124`) is spawned by Local, not by Claude Code, so it would not be sandboxed at all. `node_modules` stays in the worktree. Whether `npm ci` works inside the sandbox when the worker runs it itself (network allowlist for the registry, cache directory writes) is **UNVERIFIED**.

### Claude Code sign-in
Unchanged. The worker keeps whatever it has today, through `CLAUDE_CONFIG_DIR` or the token env vars. Whether the sandbox blocks the worker's own read of those files is **UNVERIFIED**.

### What breaks
- It restricts Claude Code's own tool calls only. The CI process and anything else Local spawns are outside it.
- Excluded commands and escape hatches in the setting are **UNVERIFIED**. The report cannot say how strongly they are enforced.
- It runs under the same account, so credentials the account can read are still reachable unless the sandbox denies those paths. **UNVERIFIED.**

## Comparison

Every cell that is not a repo fact depends on an unchecked claim, so read them as hypotheses.

| | 1. Low-privilege account | 2. Windows Sandbox | 3. WSL2 / Docker | 4. Claude Code sandbox |
|---|---|---|---|---|
| Home support | **UNVERIFIED** | **UNVERIFIED** | **UNVERIFIED** | **UNVERIFIED** |
| Pro support | **UNVERIFIED** | **UNVERIFIED** | **UNVERIFIED** | **UNVERIFIED** |
| Spawn without stored password | Unclear: scheduled task, S4U or service might, `CreateProcessWithLogonW` does not (**UNVERIFIED**) | `wsb` CLI, no password expected (**UNVERIFIED**) | Yes expected for `wsl.exe` and `docker run` (**UNVERIFIED**) | Not applicable |
| Worktree handling | Native paths, needs ACLs and `safe.directory` | Mapped folders, `safe.directory` likely | `/mnt/c` or bind mount, `.git` path rewrite problem, `safe.directory` likely | No boundary, `.git` outside the worktree is the test |
| Mounted-drive performance | Native | Unknown | Slow on Windows mounts (**UNVERIFIED**), fast on the Linux side | Native |
| CI covered | Yes, if CI is spawned the same way | Yes, if run inside | Yes, if run inside | No, CI is outside it (repo fact) |
| `node_modules` | In the worktree | In the sandbox or the mapped worktree | On the Linux side or a volume | In the worktree |
| Claude sign-in | Own login or token env | Inject every run | Token env or mounted config | Unchanged |
| Isolation strength | Account boundary, no network or resource limits | VM boundary (**UNVERIFIED**) | Container strong, plain WSL weak (**UNVERIFIED**) | Same account, partial |
| Main risk | Spawning without a stored password | Edition, one-at-a-time, start cost | Linux-vs-Windows test drift, path rewrite | Does not cover CI |

## Recommendation for the next phase

1. **Do not build anything yet.** The report cannot support a build decision, because none of the edition or spawn claims is verified. Run a verification pass first: fetch the pages under "Sources to check" and close out each **UNVERIFIED** marker. That is a small, bounded task.
2. **Likely first target: Docker or WSL2, running both the worker and CI inside one container.** It is the only option where a single boundary can plausibly cover the worker and the CI process, it needs no Windows password, and Home support is likely through WSL 2. Treat each of those as a hypothesis. Prototype one task end to end on the dev machine (Windows 11 Home): create the worktree on the Linux side, run `npm ci && npm test`, run Claude Code with a token env var, and measure `npm ci` time against the native baseline.
3. **Fallback if Docker is ruled out: a dedicated account driven by a scheduled task or service**, created once by an elevated setup step. Do not use `CreateProcessWithLogonW` or `runas /savecred`, because both put a password in Local's or the owner's reach.
4. **Treat Claude Code's sandbox as a cheap extra layer, not the boundary.** It cannot cover CI. Turn it on in addition to option 3 if the verification pass shows it works on the target setup.
5. **Drop Windows Sandbox** unless verification shows Home support and concurrent instances. Both are doubtful, and the per-task start cost fits the orchestrator poorly.

Whatever is chosen, the owner's credentials (git, `gh`, `~/.claude`, SSH keys) should stay outside the boundary, and pushing to GitHub should stay in Local, never in the worker.

## Sources to check

These are leads for the verification pass. None was fetched.

- Windows Sandbox: overview, `wsb` CLI and `.wsb` configuration pages under `learn.microsoft.com/windows/security/application-security/application-isolation/windows-sandbox/`
- WSL: `learn.microsoft.com/windows/wsl/install`, `.../filesystems`, `.../wsl-config` (interop, automount)
- `CreateProcessWithLogonW`, `LogonUser` logon types (including S4U) and Task Scheduler principals: Win32 API pages on `learn.microsoft.com`
- Docker Desktop for Windows install and WSL 2 backend requirements: `docs.docker.com/desktop/setup/install/windows-install/`
- Claude Code sandboxing, settings and environment variables: `code.claude.com/docs/en/sandboxing`, `.../settings`, `.../env-vars`
- git `safe.directory`: `git-scm.com/docs/git-config`
