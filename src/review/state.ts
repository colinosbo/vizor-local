// Latest review per task, shaped (snake_case) like the other /api/state rows.
import type { DB } from '../db.js';
import type { ReviewFinding, ReviewStatus } from './store.js';

export interface StateReview {
  task_id: string; project_id: string; pr_number: number; head_sha: string;
  status: ReviewStatus; findings: ReviewFinding[]; model: string; created_at: string;
}

interface RawReview {
  task_id: string; project_id: string; pr_number: number; head_sha: string;
  status: string; findings_json: string; model: string; created_at: string;
}

const SEVERITIES: readonly string[] = ['critical', 'high', 'medium', 'low'];
const STATUSES: readonly string[] = ['pending', 'passed', 'blocked', 'failed'];

function isStatus(x: unknown): x is ReviewStatus {
  return typeof x === 'string' && STATUSES.includes(x);
}

function isFinding(x: unknown): x is ReviewFinding {
  if (typeof x !== 'object' || x === null) return false;
  const f = x as Record<string, unknown>;
  return typeof f.severity === 'string' && SEVERITIES.includes(f.severity)
    && typeof f.file === 'string' && typeof f.line === 'number' && Number.isFinite(f.line)
    && typeof f.title === 'string' && typeof f.evidence === 'string' && typeof f.fix === 'string';
}

/** Same fail-closed guard as store.ts: bad findings or an unknown status read as findings [] with status 'failed'. */
function toStateReview(raw: RawReview): StateReview {
  let findings: ReviewFinding[] = [];
  let status: ReviewStatus = isStatus(raw.status) ? raw.status : 'failed';
  try {
    const parsed: unknown = JSON.parse(raw.findings_json);
    if (Array.isArray(parsed) && parsed.every(isFinding)) findings = parsed;
    else status = 'failed';
  } catch {
    status = 'failed';
  }
  return {
    task_id: raw.task_id, project_id: raw.project_id, pr_number: raw.pr_number, head_sha: raw.head_sha,
    status, findings, model: raw.model, created_at: raw.created_at,
  };
}

function hasReviewsTable(db: DB): boolean {
  return db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='reviews'").get() !== undefined;
}

/** Newest review per task (created_at DESC, id DESC); [] on a legacy DB without the reviews table. */
export function reviewsForState(db: DB): StateReview[] {
  if (!hasReviewsTable(db)) return [];
  const rows = db.prepare(
    `SELECT r.* FROM reviews r
     WHERE r.id = (SELECT r2.id FROM reviews r2 WHERE r2.task_id = r.task_id ORDER BY r2.created_at DESC, r2.id DESC LIMIT 1)
     ORDER BY r.created_at DESC, r.id DESC`,
  ).all() as unknown as RawReview[];
  return rows.map(toStateReview);
}
