export type TaskStatus =
  | 'pending' | 'ready' | 'running' | 'waiting_ci' | 'merging' | 'merged' | 'blocked' | 'cancelled';

export const IN_FLIGHT: TaskStatus[] = ['running', 'waiting_ci', 'merging'];
export const TERMINAL: TaskStatus[] = ['merged', 'cancelled'];

export interface PlanTask {
  key: string;
  title: string;
  prompt: string;
  acceptance: string;
  writeScope: string[];   // globs, e.g. "src/history/**"
  deps: string[];         // keys of tasks that must merge first
  model?: ModelChoice;    // which Claude model runs this task; absent = sonnet
  modelWhy?: string;      // one short sentence from the planner
}

export type ModelChoice = 'opus' | 'sonnet';
export const MODEL_CHOICES: ModelChoice[] = ['opus', 'sonnet'];

export interface PlanBody {
  summary: string;
  tasks: PlanTask[];
}

export interface Project {
  id: string; name: string; repo_path: string; base_branch: string;
  max_workers: number; paused: number;
  forge_origin: string | null;  // bare repo acting as this project's forge; null = use the checkout's origin remote
  auto_push?: number;            // 1 = push main to GitHub once every task has merged
  auto_pushed_sha?: string | null; // last main SHA the auto-pusher handled (pushed or failed)
  auto_push_error?: string | null;
  roadmap_paused: number;       // 1 = do not draft the next roadmap phase automatically
  auto_approve?: number;        // 1 = RoadmapService may approve roadmap plans that pass autoApproveDecision
  auto_approve_halted?: string | null; // set when a task failed/blocked; nothing auto-approves until the owner resumes
  ci_command: string;           // trusted CI command, run by the shell in a clean clone of the exact SHA
}

export const DEFAULT_CI = 'node --test';

export interface TaskRow {
  id: string; project_id: string; plan_id: number; key: string; title: string;
  prompt: string; acceptance: string; write_scope: string; deps: string;
  status: TaskStatus; hold_reason: string | null; branch: string; worktree: string | null;
  pr_number: number | null; head_sha: string | null; merge_sha: string | null;
  repair_count: number; local_retry_count: number; infra_retry_count: number;
  pending_repair: string | null; last_session_id: string | null;
  usage_retry_at: number | null;  // UTC epoch ms for a provider quota hold
  model?: ModelChoice | null;     // planner's pick for this task
  model_why?: string | null;
}

export interface AttemptRow {
  id: string; task_id: string; kind: 'initial' | 'repair' | 'retry';
  status: string; session_id: string | null; repair_key: string | null;
  base_sha: string | null; pid: number | null; exit_code: number | null; reason: string | null;
  ended_at: string | null;
}

export interface Check {
  id: number; sha: string; name: string;
  conclusion: 'pending' | 'success' | 'failure' | 'infra_error';
  workflow_ref: string; log: string;
}

export interface PullRequest {
  number: number; branch: string; base: string; headSha: string;
  state: 'open' | 'merged' | 'closed'; title: string; body: string; mergeSha: string | null;
}

export interface FileChange { status: string; paths: string[] } // renames carry both paths

export const taskMarker = (taskId: string) => `<!-- local-task:${taskId} -->`;
export const REQUIRED_CHECK = 'local-ci';
export const TRUSTED_WORKFLOW = 'trusted@main';
