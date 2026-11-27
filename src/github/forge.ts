import { execFileSync } from 'node:child_process';
import { HeadMovedError, type Forge } from '../forge.js';
import { revParse } from '../git.js';
import type { Check, FileChange, PullRequest } from '../types.js';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Synchronous GitHub REST call. Errors it throws carry a string `kind`:
 * 'not_authenticated' | 'not_found' | 'rate_limited' | 'conflict' | 'failed' | 'timeout'.
 */
type GhCall = (method: HttpMethod, path: string, body?: unknown) => unknown;

export interface GitHubForgeOptions {
  /** 'owner/name' */
  repo: string;
  /** The project's local, non-bare checkout. */
  repoPath: string;
  gh: GhCall;
  checksFor: (sha: string) => Check[];
  /** Defaults to `https://github.com/${repo}.git`; tests point it at a local bare repo. */
  remoteUrl?: string;
}

const PAGE_SIZE = 100;
const FETCH_NAMESPACE = 'refs/remotes/vizor-github';

// ---- REST payload guards -------------------------------------------------

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isOptionalString = (v: unknown): v is string | null | undefined => v === null || v === undefined || isString(v);

interface RestPull {
  number: number;
  state: string;
  title: string;
  body: string | null;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string };
}

function isRestPull(v: unknown): v is RestPull {
  if (!isObject(v)) return false;
  const { number, state, title, body, merged_at, merge_commit_sha, head, base } = v;
  return typeof number === 'number' && Number.isInteger(number)
    && isString(state) && isString(title)
    && isOptionalString(body) && isOptionalString(merged_at) && isOptionalString(merge_commit_sha)
    && isObject(head) && isString(head.ref) && isString(head.sha)
    && isObject(base) && isString(base.ref);
}

interface RestFile { filename: string; status: string; previous_filename?: string }

function isRestFile(v: unknown): v is RestFile {
  return isObject(v) && isString(v.filename) && isString(v.status) && isOptionalString(v.previous_filename);
}

function isCompare(v: unknown): v is { behind_by: number } {
  return isObject(v) && typeof v.behind_by === 'number';
}

function isMergeResult(v: unknown): v is { sha: string } {
  return isObject(v) && isString(v.sha) && v.sha.length > 0;
}

function asPull(v: unknown, what: string): RestPull {
  if (!isRestPull(v)) throw new Error(`GitHub returned an unexpected payload for ${what}`);
  return v;
}

function asArray(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`GitHub returned a non-array payload for ${what}`);
  return v;
}

function errorKind(e: unknown): unknown {
  return isObject(e) || e instanceof Error ? (e as { kind?: unknown }).kind : undefined;
}

function toPullRequest(p: RestPull): PullRequest {
  const merged = Boolean(p.merged_at);
  return {
    number: p.number,
    branch: p.head.ref,
    base: p.base.ref,
    headSha: p.head.sha,
    state: merged ? 'merged' : p.state === 'closed' ? 'closed' : 'open',
    title: p.title,
    body: p.body ?? '',
    mergeSha: merged ? p.merge_commit_sha ?? null : null,
  };
}

function toFileChange(f: RestFile): FileChange {
  switch (f.status) {
    case 'added': return { status: 'A', paths: [f.filename] };
    case 'removed': return { status: 'D', paths: [f.filename] };
    case 'renamed': return { status: 'R', paths: [f.previous_filename ?? f.filename, f.filename] };
    default: return { status: 'M', paths: [f.filename] };
  }
}

// ---- git plumbing ---------------------------------------------------------

/** process.env without anything that could carry a GitHub token. git's own credential helper still works. */
function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    const key = k.toUpperCase();
    if (key.startsWith('GH_') || key.startsWith('GITHUB_') || key.startsWith('LOCAL_PUBLISH')) continue;
    env[k] = v;
  }
  env.GIT_TERMINAL_PROMPT = '0'; // never block on an interactive credential prompt
  return env;
}

/** Remove userinfo (`user:token@`) from any URL in a piece of text. */
function redact(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@');
}

function runGit(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, env: scrubbedEnv(), encoding: 'utf8', timeout: 60_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

// ---- the forge ------------------------------------------------------------

export class GitHubForge implements Forge {
  private readonly repo: string;
  private readonly repoPath: string;
  private readonly gh: GhCall;
  private readonly injectedChecksFor: (sha: string) => Check[];
  private readonly remoteUrl: string;

  constructor(opts: GitHubForgeOptions) {
    this.repo = opts.repo;
    this.repoPath = opts.repoPath;
    this.gh = opts.gh;
    this.injectedChecksFor = opts.checksFor;
    this.remoteUrl = opts.remoteUrl ?? `https://github.com/${opts.repo}.git`;
  }

  private get pulls() { return `/repos/${this.repo}/pulls`; }

  baseSha(base: string): string | null {
    const ref = `${FETCH_NAMESPACE}/${base}`;
    try {
      runGit(this.repoPath, ['fetch', '--quiet', '--no-tags', this.remoteUrl, `+refs/heads/${base}:${ref}`]);
    } catch {
      return null;
    }
    return revParse(this.repoPath, ref);
  }

  createPr(p: { branch: string; base: string; title: string; body: string }): PullRequest {
    const res = this.gh('POST', this.pulls, { head: p.branch, base: p.base, title: p.title, body: p.body });
    return toPullRequest(asPull(res, 'create pull request'));
  }

  getPr(n: number): PullRequest | null {
    let res: unknown;
    try {
      res = this.gh('GET', `${this.pulls}/${n}`);
    } catch (e) {
      if (errorKind(e) === 'not_found') return null;
      throw e;
    }
    return toPullRequest(asPull(res, `pull request #${n}`));
  }

  findPrByMarker(marker: string): PullRequest | null {
    let best: RestPull | null = null;
    for (let page = 1; ; page++) {
      const items = asArray(this.gh('GET', `${this.pulls}?state=all&per_page=${PAGE_SIZE}&page=${page}`), 'pull request list');
      for (const item of items) {
        const pr = asPull(item, 'pull request list');
        if (pr.body?.includes(marker) && (!best || pr.number < best.number)) best = pr;
      }
      if (items.length < PAGE_SIZE) break;
    }
    return best ? toPullRequest(best) : null;
  }

  prFiles(n: number): FileChange[] | null {
    try {
      const changes: FileChange[] = [];
      for (let page = 1; ; page++) {
        const items = asArray(this.gh('GET', `${this.pulls}/${n}/files?per_page=${PAGE_SIZE}&page=${page}`), 'pull request files');
        for (const item of items) {
          if (!isRestFile(item)) return null;
          changes.push(toFileChange(item));
        }
        if (items.length < PAGE_SIZE) return changes;
      }
    } catch {
      return null;
    }
  }

  isUpToDate(n: number): boolean | null {
    try {
      const pr = this.getPr(n);
      if (!pr || !pr.headSha) return null;
      const cmp = this.gh('GET', `/repos/${this.repo}/compare/${pr.base}...${pr.headSha}`);
      return isCompare(cmp) ? cmp.behind_by === 0 : null;
    } catch {
      return null;
    }
  }

  checksFor(sha: string): Check[] {
    return this.injectedChecksFor(sha);
  }

  notifyPush(branch: string): void {
    try {
      runGit(this.repoPath, ['push', '--quiet', this.remoteUrl, `+refs/heads/${branch}:refs/heads/${branch}`]);
    } catch (e) {
      const stderr = isObject(e) && isString(e.stderr) ? e.stderr.trim() : '';
      // Neither the remote URL nor git's own message may echo credentials.
      throw new Error(`git push of ${branch} to ${this.repo} failed${stderr ? `: ${redact(stderr)}` : ''}`);
    }
  }

  /** GitHub Actions runs on push; there is nothing to trigger. */
  triggerCi(_sha: string): number {
    return 0;
  }

  rerunCi(check: Check): boolean {
    if (!check.actionsRunId) return false;
    this.gh('POST', '/repos/' + this.repo + '/actions/runs/' + check.actionsRunId + '/rerun');
    return true;
  }

  merge(n: number, expectedHeadSha: string): string {
    let res: unknown;
    try {
      res = this.gh('PUT', `${this.pulls}/${n}/merge`, { merge_method: 'squash', sha: expectedHeadSha });
    } catch (e) {
      if (errorKind(e) === 'conflict') throw new HeadMovedError(`PR #${n} head is no longer ${expectedHeadSha}`);
      throw e;
    }
    if (!isMergeResult(res)) throw new Error(`GitHub returned an unexpected payload merging PR #${n}`);
    return res.sha;
  }

  closePr(n: number): void {
    this.gh('PATCH', `${this.pulls}/${n}`, { state: 'closed' });
  }

  async idle(): Promise<void> {}

  close(): void {}
}
