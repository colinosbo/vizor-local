import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DB } from './db.js';
import { emit } from './events.js';
import { resolveLocalOrigin } from './forges.js';
import { git, revParse } from './git.js';
import { DEFAULT_CI, type Project } from './types.js';

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
}

export const projectId = (name: string) => name.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30);

/** Bind a local checkout. Verifies it is a git checkout with a usable forge origin and the base branch. */
export function addProject(db: DB, repoPath: string, opts: AddProjectOpts = {}): Project {
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
    if (!existsSync(join(path, '.gitignore'))) writeFileSync(join(path, '.gitignore'), 'node_modules/\n.env\n.env.*\n*.db\n');
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

  db.prepare('INSERT INTO projects(id, name, repo_path, base_branch, max_workers, ci_command) VALUES (?,?,?,?,?,?)')
    .run(id, name, path, base, opts.maxWorkers ?? 1, opts.ciCommand?.trim() || DEFAULT_CI);
  emit(db, { projectId: id, type: 'project_added', data: { path, remote, base, ci: opts.ciCommand ?? DEFAULT_CI } });
  return db.prepare('SELECT * FROM projects WHERE id=?').get(id) as unknown as Project;
}

/** Owner-only project settings. */
export function configureProject(db: DB, id: string, c: { ciCommand?: string; maxWorkers?: number; forgeOrigin?: string | null; autoPush?: boolean }): Project {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(id) as unknown as Project | undefined;
  if (!p) throw new Error(`unknown project ${id}`);
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
  emit(db, { projectId: id, type: 'project_configured', data: c });
  return db.prepare('SELECT * FROM projects WHERE id=?').get(id) as unknown as Project;
}

/** `vizor-local .` — open the project bound to the current checkout, or report that setup is needed. */
export function findProjectForPath(db: DB, cwd: string): Project | { setupNeeded: string } {
  let top: string;
  try { top = canonicalPath(git(canonicalPath(cwd), ['rev-parse', '--show-toplevel'])); }
  catch { return { setupNeeded: `${cwd} is not inside a git checkout` }; }
  const p = db.prepare('SELECT * FROM projects WHERE repo_path=?').get(top) as unknown as Project | undefined;
  return p ?? { setupNeeded: top };
}
