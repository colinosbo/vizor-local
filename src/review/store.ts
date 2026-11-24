// Durable review results, keyed by exact PR head SHA, plus the per-project review gate setting.
import type { DB } from '../db.js';

export type ReviewSeverity = 'critical' | 'high' | 'medium' | 'low';
// Must stay structurally identical to Finding in src/review/reviewer.ts.
export interface ReviewFinding { severity: ReviewSeverity; file: string; line: number; title: string; evidence: string; fix: string }
export type ReviewStatus = 'pending' | 'passed' | 'blocked' | 'failed';
export type ReviewGate = 'off' | 'report' | 'block';
export interface ReviewRow {
  id: number; projectId: string; taskId: string; prNumber: number; headSha: string;
  status: ReviewStatus; findings: ReviewFinding[]; model: string; createdAt: string;
}

const SEVERITIES: readonly string[] = ['critical', 'high', 'medium', 'low'];
const STATUSES: readonly string[] = ['pending', 'passed', 'blocked', 'failed'];
const GATES: readonly string[] = ['off', 'report', 'block'];

export function isReviewGate(x: unknown): x is ReviewGate {
  return typeof x === 'string' && GATES.includes(x);
}

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

export function hasBlockingFinding(findings: readonly ReviewFinding[]): boolean {
  return findings.some((f) => f.severity === 'critical' || f.severity === 'high');
}

/** Additive and idempotent: creates the reviews table and the projects.review_gate column. */
export function migrateReviews(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','passed','blocked','failed')),
    findings_json TEXT NOT NULL DEFAULT '[]',
    model TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(task_id, head_sha)
  );
  CREATE INDEX IF NOT EXISTS reviews_task_created ON reviews(task_id, created_at);`);
  if (!projectsHasGateColumn(db)) db.exec("ALTER TABLE projects ADD COLUMN review_gate TEXT NOT NULL DEFAULT 'report'");
}

function projectsHasGateColumn(db: DB): boolean {
  const cols = db.prepare('PRAGMA table_info(projects)').all() as { name: string }[];
  return cols.some((c) => c.name === 'review_gate');
}

interface RawReview {
  id: number; project_id: string; task_id: string; pr_number: number; head_sha: string;
  status: string; findings_json: string; model: string; created_at: string;
}

/** Fail closed: unparseable findings or an unknown status read back as findings [] with status 'failed'. */
function toRow(raw: RawReview): ReviewRow {
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
    id: raw.id, projectId: raw.project_id, taskId: raw.task_id, prNumber: raw.pr_number, headSha: raw.head_sha,
    status, findings, model: raw.model, createdAt: raw.created_at,
  };
}

export function putReview(db: DB, r: {
  projectId: string; taskId: string; prNumber: number; headSha: string;
  status: ReviewStatus; findings: ReviewFinding[]; model: string;
}): ReviewRow {
  const raw = db.prepare(
    `INSERT INTO reviews(project_id, task_id, pr_number, head_sha, status, findings_json, model)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(task_id, head_sha) DO UPDATE SET
       pr_number=excluded.pr_number, status=excluded.status, findings_json=excluded.findings_json, model=excluded.model
     RETURNING *`,
  ).get(r.projectId, r.taskId, r.prNumber, r.headSha, r.status, JSON.stringify(r.findings), r.model) as unknown as RawReview;
  return toRow(raw);
}

export function getReview(db: DB, taskId: string, headSha: string): ReviewRow | undefined {
  const raw = db.prepare('SELECT * FROM reviews WHERE task_id=? AND head_sha=?').get(taskId, headSha) as RawReview | undefined;
  return raw && toRow(raw);
}

export function latestReview(db: DB, taskId: string): ReviewRow | undefined {
  const raw = db.prepare('SELECT * FROM reviews WHERE task_id=? ORDER BY created_at DESC, id DESC LIMIT 1').get(taskId) as RawReview | undefined;
  return raw && toRow(raw);
}

/** 'report' for a legacy DB without the column; 'block' (strictest) for a missing project or invalid value. */
export function getReviewGate(db: DB, projectId: string): ReviewGate {
  if (!projectsHasGateColumn(db)) return 'report';
  const row = db.prepare('SELECT review_gate FROM projects WHERE id=?').get(projectId) as { review_gate: unknown } | undefined;
  return row && isReviewGate(row.review_gate) ? row.review_gate : 'block';
}

export function setReviewGate(db: DB, projectId: string, gate: ReviewGate): void {
  if (!isReviewGate(gate)) throw new Error(`invalid review gate: ${String(gate)}`);
  db.prepare('UPDATE projects SET review_gate=? WHERE id=?').run(gate, projectId);
}
