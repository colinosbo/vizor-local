// Per-attempt Claude Code settings that deny a worker access outside its worktree.
//
// Before each attempt, Local writes <dataDir>/isolation/<attemptId>/settings.json and
// starts the worker with `claude --settings <path>`.
//
// HONESTY NOTE: the command-pattern deny rules below are DEFENSE IN DEPTH, NOT A
// SECURITY BOUNDARY. They match what Claude usually types. They are easy to get
// around: other binaries (python, node -e, Invoke-Expression), scripts the worker
// writes and runs with node, encoded or variable-built commands, aliases and wrappers
// such as npx. The Claude Code docs say the same: a deny rule "isn't a security
// boundary around the program". Real isolation (OS users, sandboxing, network
// policy) is covered in docs/investigations/windows-isolation.md.
//
// Verified against `claude --help` (installed CLI) and the official docs
// (code.claude.com/docs/en/permissions, code.claude.com/docs/en/settings):
//   - `--settings <file-or-json>` loads extra settings for the session. It sits above
//     user/project/local settings and below managed settings.
//   - `permissions.deny` is an array of rule strings. Rules are checked in the order
//     deny, ask, allow, and "an allow rule can't carve an exception out of a deny rule".
//   - `Read(...)` / `Edit(...)` path rules: `//path` is absolute from the filesystem
//     root, `~/path` is home, and `/path` is relative to the SETTINGS FILE's directory
//     (so we never use it). On Windows, paths are normalized to POSIX form before
//     matching: `C:\Users\a` is written `//c/Users/a`. `**` matches across directories.
//   - `Bash(...)`: `*` may appear anywhere in the pattern. A trailing ` *` also matches
//     the bare command. Compound commands (&&, ||, ;, |, &) are split and a deny rule
//     applies if any subcommand matches.
//   - `PowerShell(...)` rules have the same shape as Bash rules. Matching is
//     case-insensitive and aliases (iwr, irm, curl in PS 5.1) are canonicalized.
//   - With -p, a settings file that fails validation is SILENTLY IGNORED (claude --help).
//     So the JSON shape here must stay exactly { permissions: { deny: string[] } }.
//
// UNVERIFIED (not stated in the docs or help; we hedge as noted):
//   - UNVERIFIED: whether `Read(<dir>)` without `/**` covers files inside the directory.
//     We emit both `X` and `X/**` for every path.
//   - UNVERIFIED: whether path-rule matching is case-insensitive on Windows. We keep
//     the original case and lowercase only the drive letter, as the doc example does.
//   - UNVERIFIED: how UNC paths (\\server\share) are written. We emit `//server/share`.
//   - UNVERIFIED: whether glob metacharacters in a real path ([ ] * ? !) need escaping.
//     We do not escape them.
//   - UNVERIFIED: whether a `*` in the MIDDLE of a Bash pattern can match empty text.
//     We emit each flag rule with and without the leading `<cmd> *`.
//   - UNVERIFIED: whether Bash(...) rule matching is case-sensitive. We emit the common
//     casings of PowerShell-style flags (-Method Post / POST, -InFile / -infile).
//   - UNVERIFIED: whether Read deny rules also stop the Grep and Glob tools.
//
// Trade-off on outbound commands: the docs support `*` in the middle of a Bash
// pattern, so we deny curl/wget/iwr/irm only with upload or POST/PUT flags and leave
// plain downloads (GET) allowed. The docs call argument-constraining patterns
// "fragile". For example `curl --json`, `-K config`, `--request=PATCH`, or flags built
// from variables get past these rules. scp, ssh, sftp, rsync, gh and git push are
// denied as whole commands.

import { mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface IsolationOptions {
  dataDir: string;
  attemptId: string;
  worktree: string;
  /** Defaults to os.homedir(). */
  homeDir?: string;
  otherProjectPaths: readonly string[];
}

export interface ClaudeSettings {
  permissions: { deny: string[] };
}

const HOME_SECRETS = ['.ssh', '.aws', '.azure', join('.config', 'gh'), '.git-credentials'] as const;
const ALWAYS_DENIED_DATA_ENTRIES = ['local.db', 'server.json', 'isolation'] as const;
const WORKTREES_DIR = 'worktrees';
const ISOLATION_DIR = 'isolation';
const SETTINGS_FILE = 'settings.json';
const PATH_TOOLS = ['Read', 'Edit'] as const;
const SHELL_TOOLS = ['Bash', 'PowerShell'] as const;

/** Commands denied outright, with any arguments. */
const WHOLE_COMMANDS = ['scp', 'ssh', 'sftp', 'rsync', 'gh'] as const;

/**
 * Flag fragments that send data out. Each one becomes `<cmd> <flag>*` and
 * `<cmd> * <flag>*`. The glued trailing `*` also covers forms like `-d@file`,
 * `--data-binary` and `-XPOST`.
 */
const CURL_FLAGS = [
  '-X POST', '-X PUT', '-XPOST', '-XPUT', '--request POST', '--request PUT', '--request=POST', '--request=PUT',
  '--data', '-d', '-F', '--form', '--upload-file', '-T',
] as const;
const WGET_FLAGS = ['--post-data', '--post-file', '--method=POST', '--method=PUT', '--method POST', '--method PUT', '--body-data', '--body-file'] as const;
const PS_WEB_FLAGS = [
  '-Method Post', '-Method POST', '-Method post', '-Method Put', '-Method PUT', '-Method put',
  '-InFile', '-infile', '-Infile',
] as const;
const UPLOAD_FLAGS_BY_COMMAND: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['curl', CURL_FLAGS],
  ['curl.exe', CURL_FLAGS],
  ['wget', WGET_FLAGS],
  ['Invoke-WebRequest', PS_WEB_FLAGS],
  ['iwr', PS_WEB_FLAGS],
  ['Invoke-RestMethod', PS_WEB_FLAGS],
  ['irm', PS_WEB_FLAGS],
];

/** Absolute, normalized form with no trailing separator. */
function normalizePath(p: string): string {
  const abs = resolve(p);
  return abs.length > 1 && (abs.endsWith('/') || abs.endsWith('\\')) && !/^[A-Za-z]:[\\/]$/.test(abs)
    ? abs.slice(0, -1)
    : abs;
}

/** Real path when it exists, so junctions and symlinks cannot hide containment. */
function realOrNormalized(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return normalizePath(p);
  }
}

function comparable(p: string): string {
  const n = normalizePath(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

/** True when `child` is `parent` or lies inside it. */
function isSameOrInside(child: string, parent: string): boolean {
  const rel = relative(comparable(parent), comparable(child));
  if (rel === '') return true;
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

/** Checks both the lexical and the real path, so either form counts. */
function containsOrEquals(parent: string, child: string): boolean {
  return (
    isSameOrInside(child, parent) ||
    isSameOrInside(realOrNormalized(child), realOrNormalized(parent))
  );
}

function listEntries(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function assertSafeAttemptId(attemptId: string): void {
  if (
    attemptId === '' ||
    attemptId === '.' ||
    attemptId === '..' ||
    /[\\/:]/.test(attemptId) ||
    attemptId.includes('\0')
  ) {
    throw new Error(`invalid attemptId for isolation settings: ${JSON.stringify(attemptId)}`);
  }
}

/** Converts an absolute native path to the `//...` rule form the docs show. */
function toRulePath(absPath: string): string {
  const forward = absPath.replace(/\\/g, '/');
  const drive = /^([A-Za-z]):(\/.*)?$/.exec(forward);
  if (drive) {
    const rest = (drive[2] ?? '').replace(/\/+$/, '');
    return `//${drive[1]!.toLowerCase()}${rest}`;
  }
  if (forward.startsWith('//')) return forward.replace(/\/+$/, ''); // UNC (UNVERIFIED form)
  return `/${forward}`.replace(/\/+$/, '');
}

/**
 * Directory and file paths the worker must not read or edit. Absolute and normalized.
 * No entry equals or contains the worktree.
 */
export function deniedPathsFor(opts: IsolationOptions): string[] {
  const home = normalizePath(opts.homeDir ?? homedir());
  const dataDir = normalizePath(opts.dataDir);
  const worktree = normalizePath(opts.worktree);
  const worktreesDir = join(dataDir, WORKTREES_DIR);

  const candidates: string[] = [
    ...HOME_SECRETS.map((s) => join(home, s)),
    ...opts.otherProjectPaths.map(normalizePath),
    // One sorted set, so the order does not change once 'isolation' exists on disk.
    ...[...new Set([...listEntries(dataDir), ...ALWAYS_DENIED_DATA_ENTRIES])]
      .filter((e) => e.toLowerCase() !== WORKTREES_DIR)
      .sort()
      .map((e) => join(dataDir, e)),
    ...listEntries(worktreesDir).map((e) => join(worktreesDir, e)),
  ];

  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of candidates) {
    // Denying the worktree or a folder that holds it would lock the worker out of its own checkout.
    if (containsOrEquals(p, worktree)) continue;
    const key = comparable(p);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(p);
  }
  return result;
}

function pathRules(paths: readonly string[]): string[] {
  const rules: string[] = [];
  for (const p of paths) {
    const rp = toRulePath(p);
    for (const tool of PATH_TOOLS) rules.push(`${tool}(${rp})`, `${tool}(${rp}/**)`);
  }
  return rules;
}

function commandPatterns(): string[] {
  const patterns: string[] = [];
  for (const cmd of WHOLE_COMMANDS) patterns.push(`${cmd} *`);
  patterns.push('git push *', 'git * push *');
  for (const [cmd, flags] of UPLOAD_FLAGS_BY_COMMAND) {
    for (const flag of flags) patterns.push(`${cmd} ${flag}*`, `${cmd} * ${flag}*`);
  }
  return patterns;
}

function commandRules(): string[] {
  const patterns = commandPatterns();
  return SHELL_TOOLS.flatMap((tool) => patterns.map((p) => `${tool}(${p})`));
}

/** Pure: same options and same filesystem state give the same settings. */
export function buildIsolationSettings(opts: IsolationOptions): ClaudeSettings {
  return { permissions: { deny: [...pathRules(deniedPathsFor(opts)), ...commandRules()] } };
}

export function settingsPathFor(dataDir: string, attemptId: string): string {
  return join(dataDir, ISOLATION_DIR, attemptId, SETTINGS_FILE);
}

/**
 * Writes the settings file under the data dir. Throws if the file would be equal to
 * or inside the worktree, because writing it there would dirty the worker's checkout.
 */
export function writeAttemptSettings(opts: IsolationOptions): { path: string; deniedPaths: string[] } {
  assertSafeAttemptId(opts.attemptId);
  const path = settingsPathFor(normalizePath(opts.dataDir), opts.attemptId);
  if (containsOrEquals(opts.worktree, path)) {
    throw new Error(
      `refusing to write isolation settings inside the worktree: ${path} is within ${normalizePath(opts.worktree)}`,
    );
  }
  const deniedPaths = deniedPathsFor(opts);
  const settings: ClaudeSettings = {
    permissions: { deny: [...pathRules(deniedPaths), ...commandRules()] },
  };
  mkdirSync(join(normalizePath(opts.dataDir), ISOLATION_DIR, opts.attemptId), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { path, deniedPaths };
}

/** Best effort: removes the attempt's settings folder. Never throws. */
export function removeAttemptSettings(dataDir: string, attemptId: string): void {
  try {
    assertSafeAttemptId(attemptId);
    rmSync(join(normalizePath(dataDir), ISOLATION_DIR, attemptId), { recursive: true, force: true });
  } catch {
    // Best effort by contract; a leftover file in the data dir is harmless.
  }
}
