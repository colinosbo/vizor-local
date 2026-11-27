// Trusted check-run mapping for an exact commit SHA.
//
// Reads GitHub check runs for one SHA and maps them onto the Check shape the merge authority
// (src/merge.ts) understands. merge.ts only accepts name === REQUIRED_CHECK with
// workflow_ref === TRUSTED_WORKFLOW, and holds with untrusted_check when a REQUIRED_CHECK carries
// any other workflow_ref. So the trust decision is made here, once, and expressed in those two fields.
//
// Post-merge CI for dependency handoff uses this same function on the merged SHA on main:
// createChecksFor(opts)(mergeSha). No extra code path is needed; the trust rules are identical.
import { REQUIRED_CHECK, TRUSTED_WORKFLOW, type Check } from '../types.js';

// Declared locally: src/github/gh.ts is built in parallel and must not be imported here.
type GhCall = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) => unknown;

export interface ChecksOptions {
  repo: string;
  /** The project's github_check column, default 'ci'. */
  checkName: string;
  gh: GhCall;
}

const TRUSTED_APP = 'github-actions';
const PER_PAGE = 100;
/** GitHub returns at most 1000 check runs per ref; more pages than this means something is wrong. */
const MAX_PAGES = 10;
const LOG_CAP = 4000;

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/i;
// Credential shapes GitHub issues. Workflow output is attacker-influenced text; never echo a token.
const TOKEN_RE = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;

type Conclusion = Check['conclusion'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function optString(v: unknown): v is string | null | undefined {
  return v === undefined || v === null || typeof v === 'string';
}

/** An optional nested object: the record, undefined when absent, or false when present but malformed. */
function optRecord(v: unknown): Record<string, unknown> | undefined | false {
  if (v === undefined || v === null) return undefined;
  return isRecord(v) ? v : false;
}

/** Maps GitHub status + conclusion to the merge authority's vocabulary. Unknown values fail closed. */
function mapConclusion(status: string, conclusion: string | null | undefined): Conclusion {
  if (status !== 'completed') return 'pending';
  switch (conclusion) {
    case 'success':
      return 'success';
    case 'failure':
    case 'timed_out':
    case 'cancelled':
    case 'action_required':
      return 'failure';
    case 'stale':
    case 'startup_failure':
    case null:
    case undefined:
      return 'infra_error';
    default:
      // neutral, skipped and anything unrecognised fail closed.
      return 'failure';
  }
}

function buildLog(title: string | null | undefined, summary: string | null | undefined, url: string | null | undefined): string {
  const parts = [title, summary, url].filter((p): p is string => typeof p === 'string' && p.trim() !== '');
  const text = parts.join('\n').replace(TOKEN_RE, '[redacted]');
  return text.length > LOG_CAP ? text.slice(0, LOG_CAP - 1) + '…' : text;
}

/**
 * Maps one GitHub check run to a Check, or null when the run is malformed or belongs to another SHA.
 * - name === checkName from the github-actions app: REQUIRED_CHECK + TRUSTED_WORKFLOW.
 * - name === checkName from any other (or no) app: REQUIRED_CHECK + 'untrusted:<slug>', so merge holds.
 *   It is never dropped, or an impostor could hide behind a trusted check.
 * - any other name: 'github:<name>' + 'untrusted:<slug>'; informational, merge ignores it.
 */
export function mapCheckRun(run: unknown, sha: string, checkName: string, repo?: string): Check | null {
  if (!isRecord(run)) return null;
  const { id, name, head_sha, status, conclusion, app, output, html_url, details_url } = run;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null;
  if (typeof name !== 'string' || name === '') return null;
  if (typeof head_sha !== 'string' || head_sha.toLowerCase() !== sha.toLowerCase()) return null;
  if (typeof status !== 'string') return null;
  if (!optString(conclusion) || !optString(html_url)) return null;
  const appRec = optRecord(app);
  const outRec = optRecord(output);
  if (appRec === false || outRec === false) return null;

  const rawSlug = appRec?.slug;
  if (!optString(rawSlug)) return null;
  const slug = rawSlug ? rawSlug : 'unknown';
  const title = outRec?.title;
  const summary = outRec?.summary;
  if (!optString(title) || !optString(summary)) return null;

  const trusted = name === checkName && slug === TRUSTED_APP;
  const runId = typeof details_url === 'string' && trusted && repo &&
    details_url.toLowerCase().startsWith('https://github.com/' + repo.toLowerCase() + '/actions/runs/')
    ? Number(/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/(\d+)(?:[/?#]|$)/i.exec(details_url)?.[1])
    : NaN;
  return {
    ...(Number.isSafeInteger(runId) && runId > 0 ? { actionsRunId: runId } : {}),
    id,
    sha,
    name: name === checkName ? REQUIRED_CHECK : `github:${name}`,
    workflow_ref: trusted ? TRUSTED_WORKFLOW : `untrusted:${slug}`,
    conclusion: mapConclusion(status, conclusion),
    log: buildLog(title, summary, html_url),
  };
}

/**
 * Returns a checksFor(sha) that lists every check run on that exact SHA (all pages) and maps each.
 * Throws on a malformed page or an invalid sha/repo rather than returning a partial list: a missing
 * page could hide an impostor run.
 */
export function createChecksFor(opts: ChecksOptions): (sha: string) => Check[] {
  const { repo, checkName, gh } = opts;
  if (!REPO_RE.test(repo)) throw new Error(`invalid repo: ${repo}`);
  if (checkName === '') throw new Error('checkName must not be empty');

  return (sha: string): Check[] => {
    if (!SHA_RE.test(sha)) throw new Error(`invalid sha: ${sha}`);
    const checks: Check[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = gh('GET', `/repos/${repo}/commits/${sha}/check-runs?per_page=${PER_PAGE}&page=${page}`);
      if (!isRecord(res) || !Array.isArray(res.check_runs)) {
        throw new Error(`malformed check-runs response for ${sha.slice(0, 8)} page ${page}`);
      }
      const runs: unknown[] = res.check_runs;
      for (const run of runs) {
        const check = mapCheckRun(run, sha, checkName, repo);
        if (check) checks.push(check);
      }
      const total = typeof res.total_count === 'number' ? res.total_count : undefined;
      if (runs.length < PER_PAGE || (total !== undefined && page * PER_PAGE >= total)) return checks;
    }
    throw new Error(`more than ${MAX_PAGES * PER_PAGE} check runs on ${sha.slice(0, 8)}`);
  };
}
