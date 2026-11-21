import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { getSetting, setSetting, type DB } from './db.js';
import { emit } from './events.js';
import { LocalForge, type Forge } from './forge.js';
import { git } from './git.js';
import type { Project } from './types.js';

/**
 * Where a project's forge lives. PoC: a local bare repo (the project's forge_origin, or else the
 * checkout's `origin` remote when that is a local path). Remote URLs need the GitHub adapter (not built).
 */
export function resolveLocalOrigin(p: Pick<Project, 'id' | 'repo_path' | 'forge_origin'>): string {
  const raw = p.forge_origin || git(p.repo_path, ['remote', 'get-url', 'origin'], { allowFail: true });
  if (!raw) throw new Error(`project ${p.id}: no origin remote and no forge origin configured`);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^[^/\\]+@[^:]+:/.test(raw))
    throw new Error(`project ${p.id}: origin ${raw} is a remote URL; the GitHub forge adapter is not built yet`);
  const path = isAbsolute(raw) ? raw : resolve(p.repo_path, raw);
  if (!existsSync(path) || git(path, ['rev-parse', '--is-bare-repository'], { allowFail: true }) !== 'true')
    throw new Error(`project ${p.id}: forge origin ${path} is not a bare git repository`);
  return path;
}

/** One forge per project, created on first use, each with its own PR/check database. */
export class ForgeRegistry {
  private forges = new Map<string, { origin: string; forge: LocalForge }>();
  constructor(private db: DB, private dataDir: string) { mkdirSync(join(dataDir, 'forges'), { recursive: true }); }

  get = (projectId: string): Forge => {
    const p = this.db.prepare('SELECT * FROM projects WHERE id=?').get(projectId) as unknown as Project | undefined;
    if (!p) throw new Error(`unknown project ${projectId}`);
    const origin = resolveLocalOrigin(p);
    let entry = this.forges.get(projectId);
    if (entry && entry.origin !== origin) { entry.forge.close(); entry = undefined; } // origin reconfigured
    if (!entry) {
      const dbPath = join(this.dataDir, 'forges', `${projectId}.db`);
      this.adoptLegacy(projectId, dbPath);
      entry = { origin, forge: new LocalForge(origin, dbPath) };
      this.forges.set(projectId, entry);
    }
    entry.forge.ciCommand = p.ci_command; // owner can change it at any time; applies to the next CI run
    return entry.forge;
  };

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

  all() { return [...this.forges.values()].map((e) => e.forge); }
  async idle() { for (const f of this.all()) await f.idle(); }
  close() { for (const f of this.all()) f.close(); this.forges.clear(); }
}
