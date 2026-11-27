import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { getSetting, setSetting, type DB } from './db.js';
import { emit } from './events.js';
import { LocalForge, type Forge } from './forge.js';
import { createChecksFor } from './github/checks.js';
import { GitHubForge } from './github/forge.js';
import { createGh, ghAuthStatus, type GhOptions } from './github/gh.js';
import { executionRemote, git } from './git.js';
import { DEFAULT_GITHUB_CHECK, isGithubRepo, type ForgeStatus, type Project } from './types.js';

/**
 * Where a local project's forge lives: a local bare repo (the project's forge_origin, or else the
 * checkout's `origin` remote when that is a local path). Remote URLs need forge_kind 'github'.
 */
export function resolveLocalOrigin(p: Pick<Project, 'id' | 'repo_path' | 'forge_origin'>): string {
  const raw = p.forge_origin || git(p.repo_path, ['remote', 'get-url', 'origin'], { allowFail: true });
  if (!raw) throw new Error(`project ${p.id}: no origin remote and no forge origin configured`);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^[^/\\]+@[^:]+:/.test(raw))
    throw new Error(`project ${p.id}: origin ${raw} is a remote URL; the GitHub forge adapter is not built into local forges (run: config ${p.id} --forge github --repo owner/name)`);
  const path = isAbsolute(raw) ? raw : resolve(p.repo_path, raw);
  if (!existsSync(path) || git(path, ['rev-parse', '--is-bare-repository'], { allowFail: true }) !== 'true')
    throw new Error(`project ${p.id}: forge origin ${path} is not a bare git repository`);
  return path;
}

export const GH_AUTH_PROBLEM = 'forge unavailable: run gh auth login';
const AUTH_TTL_MS = 60_000;

type AuthResult = { ok: true } | { ok: false; problem: string };

export interface ForgeRegistryOptions {
  /** Passed to createGh and ghAuthStatus; tests point `bin` at a fake gh script. */
  gh?: GhOptions;
}

type Entry =
  | { kind: 'local'; key: string; forge: LocalForge }
  | { kind: 'github'; key: string; forge: GitHubForge };

/** The settings a cached GitHub forge was built from; any change rebuilds it. */
const githubKey = (repo: string, check: string, repoPath: string) => `github:${repo}:${check}:${repoPath}`;

function githubRepoOf(p: Project): string {
  const repo = p.github_repo ?? '';
  if (!isGithubRepo(repo)) throw new Error(`project ${p.id}: forge github needs a repo as owner/name (run: config ${p.id} --forge github --repo owner/name)`);
  return repo;
}

/** One forge per project, created on first use. Local forges each keep their own PR/check database. */
export class ForgeRegistry {
  private forges = new Map<string, Entry>();
  private auth: { at: number; result: AuthResult } | null = null;
  private readonly ghOpts: GhOptions;

  constructor(private db: DB, private dataDir: string, opts: ForgeRegistryOptions = {}) {
    mkdirSync(join(dataDir, 'forges'), { recursive: true });
    this.ghOpts = opts.gh ?? {};
  }

  private project(projectId: string): Project {
    const p = this.db.prepare('SELECT * FROM projects WHERE id=?').get(projectId) as unknown as Project | undefined;
    if (!p) throw new Error(`unknown project ${projectId}`);
    return p;
  }

  /** `gh auth status`, cached for about a minute so the runner's ticks and /api/state do not spawn gh constantly. */
  private ghAuth(): AuthResult {
    const now = Date.now();
    if (!this.auth || now - this.auth.at >= AUTH_TTL_MS) this.auth = { at: now, result: ghAuthStatus(this.ghOpts) };
    return this.auth.result;
  }

  /** Replace the cached entry, closing the previous forge (its settings changed). */
  private put(projectId: string, entry: Entry) {
    this.forges.get(projectId)?.forge.close();
    this.forges.set(projectId, entry);
  }

  get = (projectId: string): Forge => {
    const p = this.project(projectId);
    return p.forge_kind === 'github' ? this.github(p) : this.local(p);
  };

  private local(p: Project): LocalForge {
    const origin = resolveLocalOrigin(p);
    const key = `local:${origin}`;
    const cached = this.forges.get(p.id);
    let forge: LocalForge;
    if (cached?.kind === 'local' && cached.key === key) forge = cached.forge;
    else {
      const dbPath = join(this.dataDir, 'forges', `${p.id}.db`);
      this.adoptLegacy(p.id, dbPath);
      forge = new LocalForge(origin, dbPath);
      this.put(p.id, { kind: 'local', key, forge });
    }
    forge.ciCommand = p.ci_command; // owner can change it at any time; applies to the next CI run
    return forge;
  }

  private github(p: Project): GitHubForge {
    const repo = githubRepoOf(p);
    const check = p.github_check || DEFAULT_GITHUB_CHECK;
    // Only this project's lookup fails; the runner keeps serving every other project.
    const auth = this.ghAuth();
    if (!auth.ok) throw new Error(GH_AUTH_PROBLEM);
    const key = githubKey(repo, check, p.repo_path);
    const cached = this.forges.get(p.id);
    if (cached?.kind === 'github' && cached.key === key) return cached.forge;
    const gh = createGh(this.ghOpts);
    const remote = executionRemote(p);
    const remoteUrl = remote === 'origin' ? git(p.repo_path, ['remote', 'get-url', 'origin']) : remote;
    const forge = new GitHubForge({ repo, repoPath: p.repo_path, remoteUrl, gh, checksFor: createChecksFor({ repo, checkName: check, gh }) });
    this.put(p.id, { kind: 'github', key, forge });
    return forge;
  }

  /** Forge health for /api/state. Never throws: any failure becomes ready:false with the message in `problem`. */
  forgeStatus(projectId: string): ForgeStatus {
    let p: Project;
    try { p = this.project(projectId); }
    catch (e) { return { kind: 'local', repo: null, check: DEFAULT_GITHUB_CHECK, ready: false, problem: errorText(e) }; }
    const kind = p.forge_kind === 'github' ? 'github' : 'local';
    const base = { kind, repo: p.github_repo ?? null, check: p.github_check || DEFAULT_GITHUB_CHECK } as const;
    try {
      // A local forge is ready when its origin resolves; opening its database is left to the runner.
      if (kind === 'local') resolveLocalOrigin(p);
      else this.github(p);
      return { ...base, ready: true, problem: null };
    } catch (e) {
      return { ...base, ready: false, problem: errorText(e) };
    }
  }

  /**
   * Builds before step 1 kept every PR in <data>/forge.db (single-project). Hand it to the one project
   * that already has PRs, once, so its existing tasks keep finding their PRs by marker.
   */
  private adoptLegacy(projectId: string, dbPath: string) {
    const legacy = join(this.dataDir, 'forge.db');
    if (existsSync(dbPath) || !existsSync(legacy) || getSetting(this.db, 'legacy_forge_adopted')) return;
    const owners = this.db.prepare('SELECT DISTINCT project_id FROM tasks WHERE pr_number IS NOT NULL').all() as { project_id: string }[];
    if (owners.length !== 1 || owners[0].project_id !== projectId) return;
    for (const sfx of ['', '-wal', '-shm']) if (existsSync(legacy + sfx)) renameSync(legacy + sfx, dbPath + sfx);
    setSetting(this.db, 'legacy_forge_adopted', projectId);
    emit(this.db, { projectId, type: 'legacy_forge_adopted', data: { from: legacy, to: dbPath } });
  }

  all(): (LocalForge | GitHubForge)[] { return [...this.forges.values()].map((e) => e.forge); }
  async idle() { for (const f of this.all()) await f.idle(); }
  close() { for (const f of this.all()) f.close(); this.forges.clear(); }
}

function errorText(e: unknown): string {
  return String(e instanceof Error ? e.message : e).slice(0, 400);
}
