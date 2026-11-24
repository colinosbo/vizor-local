import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isGitInstall, type CommandRunner } from './update.js';

export interface VersionInfo { version: string; sha: string | null; date: string | null; label: string }

const cache = new Map<string, VersionInfo>();

function readPackageVersion(root: string): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
      const v = (parsed as { version: unknown }).version;
      if (typeof v === 'string' && v !== '') return v;
    }
  } catch { /* fall through */ }
  return 'unknown';
}

interface GitFacts { sha: string | null; date: string | null }
const NO_GIT: GitFacts = { sha: null, date: null };

async function readGit(root: string, runner: CommandRunner): Promise<GitFacts> {
  try {
    const rev = await runner.run('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: root });
    if (rev.code !== 0) return NO_GIT;
    const log = await runner.run('git', ['log', '-1', '--format=%cI', 'HEAD'], { cwd: root });
    if (log.code !== 0) return NO_GIT;
    const sha = rev.stdout.trim();
    const date = log.stdout.trim();
    return { sha: /^[0-9a-f]{7,}$/.test(sha) ? sha : null, date: date === '' ? null : date };
  } catch {
    return NO_GIT;
  }
}

export async function readVersion(root: string, runner: CommandRunner): Promise<VersionInfo> {
  const hit = cache.get(root);
  if (hit) return hit;
  const version = readPackageVersion(root);
  const { sha, date } = isGitInstall(root) ? await readGit(root, runner) : NO_GIT;
  const base = version === 'unknown' ? 'version unknown' : `v${version}`;
  const info: VersionInfo = { version, sha, date, label: sha !== null ? `${base} · ${sha}` : base };
  cache.set(root, info);
  return info;
}

/** For tests only. */
export function resetVersionCache(): void { cache.clear(); }
