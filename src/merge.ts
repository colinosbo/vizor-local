import type { DB } from './db.js';
import type { Forge } from './forge.js';
import { allPaths } from './git.js';
import { SUPERSEDED_HOLD } from './plan.js';
import { inScope } from './scope.js';
import { REQUIRED_CHECK, TRUSTED_WORKFLOW, taskMarker, type Project, type TaskRow } from './types.js';

export type HoldCode =
  | 'plan_not_approved' | 'no_pr' | 'pr_missing' | 'pr_not_open' | 'wrong_base' | 'not_bot_branch' | 'unbound_pr'
  | 'head_moved' | 'files_unknown' | 'out_of_scope' | 'no_check' | 'check_pending' | 'check_failed'
  | 'ambiguous_checks' | 'untrusted_check' | 'stale' | 'freshness_unknown';

export interface MergeDecision { eligible: boolean; holds: { code: HoldCode; detail: string }[]; headSha?: string }

export interface MergeOptions {
  /**
   * Owner-only "Merge anyway". Relaxes plan_not_approved for exactly one case: the plan was superseded
   * while this task was in flight and the task is held for an owner decision. Every other check is unchanged.
   */
  ownerOverride?: boolean;
}

/**
 * Merge authority. Pure function of durable state + forge facts. Fails closed on any missing data.
 * A worker's claim of success is never an input here.
 */
export function evaluateMerge(db: DB, forge: Forge, task: TaskRow, project: Project, opts: MergeOptions = {}): MergeDecision {
  const holds: MergeDecision['holds'] = [];
  const hold = (code: HoldCode, detail: string): MergeDecision => { holds.push({ code, detail }); return { eligible: false, holds }; };

  const plan = db.prepare('SELECT status FROM plans WHERE id=?').get(task.plan_id) as { status: string } | undefined;
  const overridden = opts.ownerOverride === true && plan?.status === 'superseded'
    && task.status === 'blocked' && task.hold_reason === SUPERSEDED_HOLD;
  if (plan?.status !== 'approved' && !overridden) return hold('plan_not_approved', `plan ${task.plan_id} is ${plan?.status ?? 'missing'}`);
  if (!task.pr_number || !task.head_sha) return hold('no_pr', 'task has no PR/expected head');

  const pr = forge.getPr(task.pr_number);
  if (!pr) return hold('pr_missing', `PR #${task.pr_number} not found`);
  if (pr.state !== 'open') return hold('pr_not_open', `PR is ${pr.state}`);
  if (pr.base !== project.base_branch) return hold('wrong_base', `base ${pr.base} != ${project.base_branch}`);
  if (pr.branch !== task.branch || !pr.branch.startsWith('local/')) return hold('not_bot_branch', `branch ${pr.branch}`);
  if (!pr.body.includes(taskMarker(task.id))) return hold('unbound_pr', 'PR body lacks task marker');
  if (pr.headSha !== task.head_sha) return hold('head_moved', `PR head ${pr.headSha} != expected ${task.head_sha}`);

  const files = forge.prFiles(pr.number);
  if (!files) return hold('files_unknown', 'could not enumerate changed files');
  const scope = JSON.parse(task.write_scope) as string[];
  const out = allPaths(files).filter((p) => !inScope(p, scope));
  if (out.length) return hold('out_of_scope', `changed outside scope: ${out.join(', ')}`);

  const checks = forge.checksFor(pr.headSha).filter((c) => c.name === REQUIRED_CHECK);
  if (checks.length === 0) return hold('no_check', `no ${REQUIRED_CHECK} on ${pr.headSha.slice(0, 8)}`);
  if (checks.some((c) => c.workflow_ref !== TRUSTED_WORKFLOW)) return hold('untrusted_check', 'check from untrusted workflow');
  if (checks.some((c) => c.conclusion === 'pending')) return hold('check_pending', 'CI running');
  const concl = new Set(checks.filter((c) => c.conclusion !== 'infra_error').map((c) => c.conclusion));
  if (concl.size > 1) return hold('ambiguous_checks', `conflicting results on ${pr.headSha.slice(0, 8)}`);
  if (!concl.has('success')) return hold('check_failed', `${REQUIRED_CHECK} not green on ${pr.headSha.slice(0, 8)}`);

  const fresh = forge.isUpToDate(pr.number);
  if (fresh === null) return hold('freshness_unknown', 'could not compute branch freshness');
  if (!fresh) return hold('stale', `branch behind ${project.base_branch}`);

  return { eligible: true, holds, headSha: pr.headSha };
}
