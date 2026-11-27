import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { DB } from './db.js';
import { emit } from './events.js';
import { resolveLocalOrigin } from './forges.js';
import { fetchBase, git, githubRepoFromRemote, revParse } from './git.js';
import { DENYLIST_GITIGNORE } from './push-guard.js';
import { DEFAULT_CI, DEFAULT_GITHUB_CHECK, FORGE_KINDS, isForgeKind, isGithubRepo, isModelDefault, MODEL_DEFAULTS,
  type ForgeKind, type ModelDefault, type Project } from './types.js';

export const MODEL_DEFAULT_ERROR = (field: string) => `${field} must be one of ${MODEL_DEFAULTS.join(', ')}`;

export function canonicalPath(p: string): string {
  const r = realpathSync.native(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

export interface AddProjectOpts {
  expectedRemote?: string; baseBranch?: string; maxWorkers?: number; name?: string;
  ciCommand?: string;
  /** Create what is missing: `git init` + first commit if the folder is not a repo, and a local bare forge origin. */
  createOrigin?: boolean;
  originsDir?: string;
  /** Create the project folder (recursively) when it does not exist yet. Requires createOrigin. */
  createFolder?: boolean;
  githubRepo?: string;
  githubCheck?: string;
}

export const projectId = (name: string) => name.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30);

/** Bind a local checkout. Verifies it is a git checkout with a usable forge origin and the base branch. */
export function addProject(db: DB, repoPath: string, opts: AddProjectOpts = {}): Project {
  if (!repoPath.trim()) throw new Error('project folder is required');
  if (opts.githubRepo !== undefined) return addGitHubProject(db, repoPath, opts);
  if (opts.createFolder && !opts.createOrigin) throw new Error('createFolder requires createOrigin');
  if (opts.createFolder && !existsSync(repoPath)) mkdirSync(repoPath, { recursive: true });
  if (!existsSync(repoPath)) throw new Error(`${repoPath} does not exist`);
  const path = canonicalPath(repoPath);
  const name = opts.name ?? basename(path);
  const id = projectId(name);
  const base = opts.baseBranch ?? 'main';
  if (db.prepare('SELECT 1 FROM projects WHERE id=? OR repo_path=?').get(id, path)) throw new Error(`project ${id} (or this checkout) is already registered`);

  const top = git(path, ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (!top) {
    if (!opts.createOrigin) throw new Error(`${path} is not a git checkout (pass --create-origin to initialise it)`);
    git(path, ['init', '--quiet', '-b', base]);
    if (!existsSync(join(path, '.gitignore'))) writeFileSync(join(path, '.gitignore'), `node_modules/\n${DENYLIST_GITIGNORE}\n`);
    git(path, ['add', '-A']);
    git(path, ['commit', '--quiet', '--allow-empty', '-m', 'Initial commit (Local)']);
  } else if (canonicalPath(top) !== path) throw new Error(`${path} is not the root of a git checkout (root: ${top})`);
  if (!revParse(path, `refs/heads/${base}`) && !revParse(path, `refs/remotes/origin/${base}`)) throw new Error(`branch ${base} not found in ${path}`);

  let remote = git(path, ['remote', 'get-url', 'origin'], { allowFail: true });
  if (!remote) {
    if (!opts.createOrigin) throw new Error('checkout has no origin remote (pass --create-origin to create a local forge origin)');
    if (!opts.originsDir) throw new Error('originsDir required to create an origin');
    mkdirSync(opts.originsDir, { recursive: true });
    const bare = join(opts.originsDir, `${id}.git`);
    if (existsSync(bare)) throw new Error(`${bare} already exists`);
    git(opts.originsDir, ['init', '--quiet', '--bare', '-b', base, bare]);
    git(path, ['remote', 'add', 'origin', bare]);
    git(path, ['push', '--quiet', 'origin', `refs/heads/${base}:refs/heads/${base}`]);
    git(path, ['branch', '--quiet', `--set-upstream-to=origin/${base}`, base], { allowFail: true });
    remote = bare;
    emit(db, { projectId: id, type: 'forge_origin_created', data: { bare } });
  }
  if (opts.expectedRemote && remote !== opts.expectedRemote) throw new Error(`origin is ${remote}, expected ${opts.expectedRemote}`);
  resolveLocalOrigin({ id, repo_path: path, forge_origin: null }); // fail now, not at first merge
  git(path, ['fetch', '--quiet', 'origin']);
  if (!revParse(path, `origin/${base}`)) throw new Error(`origin/${base} not found (push ${base} to origin first)`);

  // New projects get the strictest review gate; rows from before the gate existed keep the migration's 'report'.
  db.prepare("INSERT INTO projects(id, name, repo_path, base_branch, max_workers, ci_command, review_gate) VALUES (?,?,?,?,?,?,'block')")
    .run(id, name, path, base, opts.maxWorkers ?? 1, opts.ciCommand?.trim() || DEFAULT_CI);
  emit(db, { projectId: id, type: 'project_added', data: { path, remote, base, ci: opts.ciCommand ?? DEFAULT_CI } });
  return db.prepare('SELECT * FROM projects WHERE id=?').get(id) as unknown as Project;
}

/** Clone into an empty destination or attach a checkout whose origin identifies the same repository. */
function addGitHubProject(db: DB, repoPath: string, opts: AddProjectOpts): Project {
  const input = opts.githubRepo!.trim();
  const repo = githubRepoFromRemote(input) ?? input;
  if (!isGithubRepo(repo)) throw new Error('Enter a GitHub repository as owner/name or a github.com repository URL');
  const check = opts.githubCheck?.trim() || DEFAULT_GITHUB_CHECK;
  if (check.length > 100 || /[\r\n]/.test(check)) throw new Error('required check must be a single line of at most 100 characters');
  const path = resolve(repoPath);
  const name = opts.name ?? basename(path);
  const id = projectId(name);
  const registeredPath = existsSync(path) ? canonicalPath(path) : process.platform === 'win32' ? path.toLowerCase() : path;
  if (db.prepare('SELECT 1 FROM projects WHERE id=? OR repo_path=?').get(id, registeredPath)) {
    throw new Error('This project name or folder is already registered');
  }
  if (opts.baseBranch) git(process.cwd(), ['check-ref-format', 'refs/heads/' + opts.baseBranch]);
  const top = existsSync(path) ? git(path, ['rev-parse', '--show-toplevel'], { allowFail: true }) : '';
  if (top) {
    if (canonicalPath(top) !== canonicalPath(path)) throw new Error('Choose the root of the checkout');
  } else {
    if (existsSync(path) && readdirSync(path).length) throw new Error('Choose an empty folder or a checkout of this GitHub repository');
    mkdirSync(dirname(path), { recursive: true });
    const branch = opts.baseBranch ? ['--branch', opts.baseBranch] : [];
    git(dirname(path), ['clone', '--quiet', ...branch, '--', 'https://github.com/' + repo + '.git', path]);
  }
  const url = 'https://github.com/' + repo + '.git';
  const origin = git(path, ['config', '--get', 'remote.origin.url'], { allowFail: true });
  const sameOrigin = githubRepoFromRemote(origin)?.toLowerCase() === repo.toLowerCase();
  const defaultRef = sameOrigin ?
    git(path, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true }).replace(/^origin\//, '') :
    /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(git(path, ['ls-remote', '--symref', '--', url, 'HEAD']))?.[1];
  const base = opts.baseBranch || defaultRef || 'main';
  const sha = fetchBase(path, base, sameOrigin ? 'origin' : url);
  if (top && !git(path, ['merge-base', 'HEAD', sha], { allowFail: true })) {
    throw new Error('This checkout has no common history with the GitHub repository. Choose an empty folder to clone it');
  }
  if (!origin) git(path, ['remote', 'add', 'origin', url]);
  db.prepare(`INSERT INTO projects(id,name,repo_path,base_branch,max_workers,ci_command,forge_kind,github_repo,github_check,review_gate)
    VALUES (?,?,?,?,?,?,'github',?,?,'block')`)
    .run(id, name, canonicalPath(path), base, opts.maxWorkers ?? 1, opts.ciCommand?.trim() || DEFAULT_CI, repo, check);
  emit(db, { projectId: id, type: 'project_added', data: { forge: 'github', repo, base } });
  return db.prepare('SELECT * FROM projects WHERE id=?').get(id) as unknown as Project;
}

/** Owner-only project settings. */
export function configureProject(db: DB, id: string, c: { ciCommand?: string; maxWorkers?: number; forgeOrigin?: string | null; autoPush?: boolean; autoApprove?: boolean;
  plannerModel?: ModelDefault; workerModel?: ModelDefault; forgeKind?: ForgeKind; githubRepo?: string; githubCheck?: string }): Project {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(id) as unknown as Project | undefined;
  if (!p) throw new Error(`unknown project ${id}`);
  const forge = validateForgeSettings(p, c);
  if ((c.forgeOrigin !== undefined && c.forgeOrigin !== p.forge_origin ||
       forge && (forge.kind !== p.forge_kind || forge.repo !== p.github_repo || forge.check !== p.github_check)) &&
      db.prepare("SELECT 1 FROM tasks WHERE project_id=? AND status NOT IN ('merged','cancelled')").get(id)) {
    throw new Error('Finish or cancel open tasks before changing their forge or required check');
  }
  if (c.autoApprove !== undefined && typeof c.autoApprove !== 'boolean') throw new Error('autoApprove must be true or false');
  // Validate both before writing either, so a bad value never leaves a half-applied update.
  if (c.plannerModel !== undefined && !isModelDefault(c.plannerModel)) throw new Error(MODEL_DEFAULT_ERROR('planner_model'));
  if (c.workerModel !== undefined && !isModelDefault(c.workerModel)) throw new Error(MODEL_DEFAULT_ERROR('worker_model'));
  if (c.plannerModel !== undefined) db.prepare('UPDATE projects SET planner_model=? WHERE id=?').run(c.plannerModel, id);
  if (c.workerModel !== undefined) db.prepare('UPDATE projects SET worker_model=? WHERE id=?').run(c.workerModel, id);
  // Takes effect immediately: RoadmapService re-reads this column on every tick and approves synchronously,
  // so there is never a queued auto-approval left to survive turning it off.
  if (c.autoApprove !== undefined) db.prepare('UPDATE projects SET auto_approve=? WHERE id=?').run(c.autoApprove ? 1 : 0, id);
  if (c.ciCommand !== undefined) {
    const ci = c.ciCommand.trim();
    if (!ci || ci.length > 500 || /[\r\n]/.test(ci)) throw new Error('CI command must be one line, 1–500 chars');
    db.prepare('UPDATE projects SET ci_command=? WHERE id=?').run(ci, id);
  }
  if (c.maxWorkers !== undefined) db.prepare('UPDATE projects SET max_workers=? WHERE id=?').run(Math.max(1, Math.min(6, Math.floor(c.maxWorkers) || 1)), id);
  if (c.forgeOrigin !== undefined) {
    resolveLocalOrigin({ id, repo_path: p.repo_path, forge_origin: c.forgeOrigin });
    db.prepare('UPDATE projects SET forge_origin=? WHERE id=?').run(c.forgeOrigin, id);
  }
  if (c.autoPush !== undefined) db.prepare('UPDATE projects SET auto_push=?, auto_push_error=NULL WHERE id=?').run(c.autoPush ? 1 : 0, id);
  if (forge) db.prepare('UPDATE projects SET forge_kind=?, github_repo=?, github_check=? WHERE id=?').run(forge.kind, forge.repo, forge.check, id);
  emit(db, { projectId: id, type: 'project_configured', data: c });
  return db.prepare('SELECT * FROM projects WHERE id=?').get(id) as unknown as Project;
}

/**
 * Resolves the forge columns after applying `c` to `p`, or null when `c` touches none of them.
 * Throws before anything is written: bad kind, malformed owner/name, empty check, or github with no repo.
 */
function validateForgeSettings(p: Project, c: { forgeKind?: unknown; githubRepo?: unknown; githubCheck?: unknown }):
  { kind: ForgeKind; repo: string | null; check: string } | null {
  if (c.forgeKind === undefined && c.githubRepo === undefined && c.githubCheck === undefined) return null;
  if (c.forgeKind !== undefined && !isForgeKind(c.forgeKind)) throw new Error(`forge must be one of ${FORGE_KINDS.join(', ')}`);
  if (c.githubRepo !== undefined && (typeof c.githubRepo !== 'string' || !isGithubRepo(c.githubRepo.trim())))
    throw new Error('repo must look like owner/name');
  if (c.githubCheck !== undefined) {
    const ok = typeof c.githubCheck === 'string' && c.githubCheck.trim() !== '' && c.githubCheck.length <= 100 && !/[\r\n]/.test(c.githubCheck);
    if (!ok) throw new Error('check must be one line, 1–100 chars');
  }
  const kind: ForgeKind = isForgeKind(c.forgeKind) ? c.forgeKind : p.forge_kind === 'github' ? 'github' : 'local';
  const repo = typeof c.githubRepo === 'string' ? c.githubRepo.trim() : p.github_repo ?? null;
  const check = typeof c.githubCheck === 'string' ? c.githubCheck.trim() : p.github_check || DEFAULT_GITHUB_CHECK;
  if (kind === 'github' && !repo) throw new Error('forge github needs a repo (--repo owner/name)');
  return { kind, repo, check };
}

/** `vizor-local .` — open the project bound to the current checkout, or report that setup is needed. */
export function findProjectForPath(db: DB, cwd: string): Project | { setupNeeded: string } {
  let top: string;
  try { top = canonicalPath(git(canonicalPath(cwd), ['rev-parse', '--show-toplevel'])); }
  catch { return { setupNeeded: `${cwd} is not inside a git checkout` }; }
  const p = db.prepare('SELECT * FROM projects WHERE repo_path=?').get(top) as unknown as Project | undefined;
  return p ?? { setupNeeded: top };
}
