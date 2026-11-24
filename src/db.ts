import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

// Durable runtime state. Everything the dashboard shows is read from here (source of truth).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO settings(key, value) VALUES ('global_max_workers', '4');
-- '1' = check GitHub for a newer Vizor Local at startup, every 6 hours and on request; '0' = never.
INSERT OR IGNORE INTO settings(key, value) VALUES ('update_check_enabled', '1');

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_path TEXT NOT NULL UNIQUE,      -- canonical local checkout
  base_branch TEXT NOT NULL DEFAULT 'main',
  max_workers INTEGER NOT NULL DEFAULT 1 CHECK (max_workers BETWEEN 1 AND 6),
  paused INTEGER NOT NULL DEFAULT 0,
  forge_origin TEXT,
  ci_command TEXT NOT NULL DEFAULT 'node --test',
  auto_approve INTEGER NOT NULL DEFAULT 0,  -- owner setting; only RoadmapService acts on it
  auto_approve_halted TEXT,                 -- null = not halted; otherwise why
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  role TEXT NOT NULL CHECK (role IN ('user','orchestrator','system')),
  text TEXT NOT NULL,
  plan_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','approved','superseded')),
  body TEXT NOT NULL,
  approved_at TEXT,
  UNIQUE (project_id, version)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,                  -- stable across attempts
  project_id TEXT NOT NULL REFERENCES projects(id),
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  acceptance TEXT NOT NULL,
  write_scope TEXT NOT NULL,            -- JSON string[]
  deps TEXT NOT NULL,                   -- JSON string[] (task keys in same plan)
  status TEXT NOT NULL,                 -- pending|ready|running|waiting_ci|merging|merged|blocked|cancelled
  hold_reason TEXT,
  branch TEXT NOT NULL,
  worktree TEXT,
  pr_number INTEGER,
  head_sha TEXT,
  merge_sha TEXT,
  repair_count INTEGER NOT NULL DEFAULT 0,
  local_retry_count INTEGER NOT NULL DEFAULT 0,
  infra_retry_count INTEGER NOT NULL DEFAULT 0,
  pending_repair TEXT,                  -- JSON context for next repair attempt
  last_session_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (plan_id, key)
);

CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL CHECK (kind IN ('initial','repair','retry')),
  status TEXT NOT NULL,                 -- claimed|running|exited|succeeded|failed|cancelled|uncertain
  session_id TEXT,                      -- persisted BEFORE launch
  repair_key TEXT,
  base_sha TEXT,
  pid INTEGER,
  exit_code INTEGER,
  reason TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);
-- One active attempt per task, enforced by the database.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_attempt ON attempts(task_id)
  WHERE status IN ('claimed','running','exited');

CREATE TABLE IF NOT EXISTS repairs (
  key TEXT PRIMARY KEY,                 -- task:headSha:checkId  (idempotency)
  task_id TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  check_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS processed_checks (
  check_id INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  PRIMARY KEY (check_id, task_id)
);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  task_id TEXT,
  attempt_id TEXT,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS events_task ON events(task_id, seq);

CREATE TABLE IF NOT EXISTS phases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',   -- queued|drafting|review|running|done|failed
  plan_id INTEGER,
  error TEXT,
  approve_mode TEXT NOT NULL DEFAULT 'inherit',  -- inherit|off (validated in code)
  auto_note TEXT,                                -- why a phase in review needs the owner
  done_note TEXT,                                -- why a done phase finished without merged work (NULL = normal finish)
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A roadmap is one queue of phases. A project can run several roadmaps at once; each advances on its own.
CREATE TABLE IF NOT EXISTS roadmaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',   -- active|done|archived (validated in code)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

-- Push guard findings the owner explicitly allowed, one finding at a time. Never stores the secret.
CREATE TABLE IF NOT EXISTS push_overrides (
  project_id TEXT NOT NULL,
  finding_id TEXT NOT NULL,
  file TEXT NOT NULL,
  rule TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, finding_id)
);
`;

export function openDb(path: string): DB {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec(SCHEMA);
  ensureColumns(db, 'projects', { forge_origin: 'TEXT', ci_command: "TEXT NOT NULL DEFAULT 'node --test'", roadmap_paused: 'INTEGER NOT NULL DEFAULT 0',
    auto_push: 'INTEGER NOT NULL DEFAULT 0', auto_pushed_sha: 'TEXT', auto_push_error: 'TEXT',
    auto_approve: 'INTEGER NOT NULL DEFAULT 0', auto_approve_halted: 'TEXT',
    planner_model: "TEXT NOT NULL DEFAULT 'auto'", worker_model: "TEXT NOT NULL DEFAULT 'auto'" }); // 'auto' | 'sonnet' | 'opus'
  ensureColumns(db, 'attempts', { model: 'TEXT' });
  ensureColumns(db, 'tasks', { usage_retry_at: 'INTEGER', model: 'TEXT', model_why: 'TEXT' });
  ensureColumns(db, 'phases', { approve_mode: "TEXT NOT NULL DEFAULT 'inherit'", auto_note: 'TEXT', done_note: 'TEXT', roadmap_id: 'INTEGER' });
  // lineage: NULL = a plan drafted from chat; 'roadmap:<id>' = a plan drafted for that roadmap. Approving a plan
  // supersedes only earlier plans of the same lineage, so a chat plan and several roadmaps can run side by side.
  ensureColumns(db, 'plans', { lineage: 'TEXT' });
  adoptLegacyPhases(db);
  return db;
}

/**
 * Phases from builds before multiple roadmaps belong to no roadmap. Each project's loose phases become one
 * roadmap ('done' when every phase is done), and the plans those phases drafted join its lineage.
 */
export function adoptLegacyPhases(db: DB) {
  const loose = db.prepare('SELECT DISTINCT project_id FROM phases WHERE roadmap_id IS NULL').all() as { project_id: string }[];
  for (const { project_id } of loose) {
    tx(db, () => {
      const open = (db.prepare("SELECT COUNT(*) AS n FROM phases WHERE project_id=? AND roadmap_id IS NULL AND status<>'done'").get(project_id) as { n: number }).n;
      const r = db.prepare("INSERT INTO roadmaps(project_id, title, status, finished_at) VALUES (?, 'Roadmap', ?, ?) RETURNING id")
        .get(project_id, open ? 'active' : 'done', open ? null : new Date().toISOString()) as { id: number };
      db.prepare('UPDATE phases SET roadmap_id=? WHERE project_id=? AND roadmap_id IS NULL').run(r.id, project_id);
      db.prepare('UPDATE plans SET lineage=? WHERE id IN (SELECT plan_id FROM phases WHERE roadmap_id=? AND plan_id IS NOT NULL)').run(`roadmap:${r.id}`, r.id);
    });
  }
}

/** Additive migration for databases created by an older build (CREATE TABLE IF NOT EXISTS skips them). */
function ensureColumns(db: DB, table: string, cols: Record<string, string>) {
  const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
  for (const [name, def] of Object.entries(cols)) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
}

/** BEGIN IMMEDIATE so claims and capacity reservations are serialized across processes. */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function getSetting(db: DB, key: string): string | undefined {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined;
  return r?.value;
}

export function setSetting(db: DB, key: string, value: string) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}
