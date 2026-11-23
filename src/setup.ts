import { existsSync } from 'node:fs';
import type { DB } from './db.js';
import { git } from './git.js';

/** Read-only setup checklist for one project, shown by the dashboard. Never throws. */
export interface ProjectSetup {
  gitRepo: boolean;
  origin: boolean;
  testCommand: boolean;
  testsPassOnMain: boolean;
  githubConnected: boolean;
  autoPush: boolean;
  planApproved: boolean;
  firstMerge: boolean;
  complete: boolean;
}

export interface SetupProjectInput {
  id: string;
  repo_path: string;
  ci_command?: string | null;
  auto_push?: number | null;
  /** Result already computed by /api/state; reused so the origin is not resolved twice. */
  origin?: string | null;
  origin_error?: string | null;
}

const safe = (fn: () => boolean): boolean => { try { return fn(); } catch { return false; } };

/** At most two synchronous git calls (work-tree check, github remote), no fetches. */
export function projectSetup(db: DB, project: SetupProjectInput): ProjectSetup {
  const repo = project.repo_path;
  const gitRepo = safe(() => !!repo && existsSync(repo)
    && git(repo, ['rev-parse', '--is-inside-work-tree'], { allowFail: true }) === 'true');
  const githubConnected = gitRepo && safe(() => git(repo, ['remote', 'get-url', 'github'], { allowFail: true }) !== '');
  const origin = !!project.origin && !project.origin_error;
  const testCommand = typeof project.ci_command === 'string' && project.ci_command.trim() !== '';
  const autoPush = project.auto_push === 1;

  // A task only reaches 'merged' after the post-merge check (the test command run on the merge
  // result that lands on the base branch) succeeds; the runner records that same moment as a
  // 'task_merged' event carrying `postMergeCheck`. Either one proves tests passed on main.
  const firstMerge = safe(() => !!db.prepare("SELECT 1 FROM tasks WHERE project_id=? AND status='merged' LIMIT 1").get(project.id));
  const testsPassOnMain = firstMerge
    || safe(() => !!db.prepare("SELECT 1 FROM events WHERE project_id=? AND type='task_merged' LIMIT 1").get(project.id));

  // Plan statuses are draft | approved | superseded. A draft can be superseded without ever being
  // approved (roadmap discard), so a superseded plan only counts when it has an approved_at.
  const planApproved = safe(() => !!db.prepare(
    "SELECT 1 FROM plans WHERE project_id=? AND (status='approved' OR (status='superseded' AND approved_at IS NOT NULL)) LIMIT 1",
  ).get(project.id));

  const complete = gitRepo && origin && testCommand && testsPassOnMain && githubConnected && planApproved;
  return { gitRepo, origin, testCommand, testsPassOnMain, githubConnected, autoPush, planApproved, firstMerge, complete };
}

/** Last-resort value if projectSetup itself ever failed: /api/state must never break on setup. */
export const EMPTY_SETUP: ProjectSetup = {
  gitRepo: false, origin: false, testCommand: false, testsPassOnMain: false, githubConnected: false,
  autoPush: false, planApproved: false, firstMerge: false, complete: false,
};
