import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { ModelChoice, TaskRow } from './types.js';

export interface WorkerEvent { kind: 'text' | 'tool' | 'command' | 'result' | 'stderr' | 'system'; text: string }

export interface WorkerContext {
  task: TaskRow;
  attemptId: string;
  attemptNumber: number;          // 1-based count of attempts for this task
  kind: 'initial' | 'repair' | 'retry';
  worktree: string;
  prompt: string;
  sessionId: string;              // persisted before launch
  resumeSessionId?: string;       // previous session to resume for repairs
  model?: ModelChoice;            // Claude model alias for this attempt
  timeoutMs: number;
}

export interface WorkerResult { exitCode: number | null; timedOut: boolean; cancelled: boolean; sessionId?: string; error?: string }

export interface WorkerHandle {
  pid: number;
  onEvent(cb: (e: WorkerEvent) => void): void;
  done: Promise<WorkerResult>;
  cancel(): void;
}

/**
 * Which model runs an attempt. The planner picks per task (default sonnet).
 * A repair means CI already failed once, so it escalates to opus.
 */
export function modelFor(task: Pick<TaskRow, 'model'>, kind: 'initial' | 'repair' | 'retry'): ModelChoice {
  if (kind === 'repair') return 'opus';
  return task.model === 'opus' ? 'opus' : 'sonnet';
}

export interface WorkerFactory { name: string; start(ctx: WorkerContext): WorkerHandle }

/** Shared child-process supervision: bounded time, cancel, line-structured output. */
function supervise(child: ChildProcess, timeoutMs: number, parse: (line: string) => WorkerEvent | null): WorkerHandle {
  const cbs: ((e: WorkerEvent) => void)[] = [];
  const buffered: WorkerEvent[] = [];
  const fire = (e: WorkerEvent) => { if (cbs.length) cbs.forEach((c) => c(e)); else buffered.push(e); };
  let sessionId: string | undefined, error: string | undefined;
  let timedOut = false, cancelled = false;
  createInterface({ input: child.stdout! }).on('line', (l) => {
    try {
      const j = JSON.parse(l);
      if (j?.session_id) sessionId = j.session_id;
      if (j?.type === 'result' && j.is_error) error = String(j.result ?? j.subtype).slice(0, 300);
    } catch { /* not json */ }
    const e = parse(l); if (e) fire(e);
  });
  createInterface({ input: child.stderr! }).on('line', (l) => fire({ kind: 'stderr', text: l }));
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
  const done = new Promise<WorkerResult>((resolve) => {
    child.on('error', (err) => { fire({ kind: 'stderr', text: String(err) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code, timedOut, cancelled, sessionId, error }); });
  });
  return {
    pid: child.pid ?? -1,
    onEvent(cb) { cbs.push(cb); buffered.splice(0).forEach(cb); },
    done,
    cancel() { cancelled = true; child.kill('SIGTERM'); },
  };
}

/**
 * Real worker: Claude Code CLI in print mode with structured stream output.
 * The worker edits/tests inside its worktree only; it does NOT commit, push or open PRs — Local publishes.
 * NOTE: argv flags verified against `claude --help` (v2.1.x); unattended auth must be verified on the host.
 */
export class ClaudeCodeWorkerFactory implements WorkerFactory {
  name = 'claude-code';
  constructor(private bin = 'claude', private allowedTools = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(npm test:*)', 'Bash(npm ci:*)', 'Bash(npm run:*)', 'Bash(node --test:*)', 'Bash(node:*)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Skill']) {}
  start(ctx: WorkerContext): WorkerHandle {
    const args = ['-p', ctx.prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
      '--allowedTools', ...this.allowedTools];
    if (ctx.model) args.push('--model', ctx.model);
    if (ctx.resumeSessionId) args.push('--resume', ctx.resumeSessionId);
    else args.push('--session-id', ctx.sessionId);
    // Publisher secrets are stripped from the worker environment.
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^(GH_|GITHUB_|LOCAL_PUBLISH)/.test(k)) delete env[k];
    const child = spawn(this.bin, args, { cwd: ctx.worktree, env, stdio: ['ignore', 'pipe', 'pipe'] });
    return supervise(child, ctx.timeoutMs, parseClaudeStreamLine);
  }
}

export function parseClaudeStreamLine(line: string): WorkerEvent | null {
  let j: any;
  try { j = JSON.parse(line); } catch { return { kind: 'text', text: line }; }
  if (j.type === 'system') return { kind: 'system', text: `session ${j.session_id ?? ''} ${j.subtype ?? ''}`.trim() };
  if (j.type === 'assistant') {
    const parts = (j.message?.content ?? []).map((c: any) =>
      c.type === 'text' ? c.text : c.type === 'tool_use' ? `▶ ${c.name} ${JSON.stringify(c.input).slice(0, 300)}` : '').filter(Boolean);
    const isTool = (j.message?.content ?? []).some((c: any) => c.type === 'tool_use');
    return parts.length ? { kind: isTool ? 'tool' : 'text', text: parts.join('\n') } : null;
  }
  if (j.type === 'user') {
    const r = (j.message?.content ?? []).find((c: any) => c.type === 'tool_result');
    if (!r) return null;
    const content = typeof r.content === 'string' ? r.content : JSON.stringify(r.content);
    return { kind: 'command', text: content.slice(0, 1200) };
  }
  if (j.type === 'result') return { kind: 'result', text: `${j.subtype ?? 'result'}${j.is_error ? ' (error)' : ''}: ${String(j.result ?? '').slice(0, 1000)}` };
  return null;
}

/** Scripted edits for deterministic tests and demos. A real child process, so pids/restarts are real. */
export interface FakeStep { files: Record<string, string | null>; exitCode?: number; sleepMs?: number; say?: string }
export type FakeScenario = Record<string, FakeStep[]>; // task key -> step per attempt number

export class FakeWorkerFactory implements WorkerFactory {
  name = 'fake';
  private script = fileURLToPath(new URL('./fake-worker.js', import.meta.url));
  constructor(public scenario: FakeScenario) {}
  start(ctx: WorkerContext): WorkerHandle {
    const steps = this.scenario[ctx.task.key] ?? [];
    const step = steps[Math.min(ctx.attemptNumber, steps.length) - 1] ?? { files: {}, say: 'nothing scripted' };
    const child = spawn(process.execPath, [this.script, JSON.stringify({ ...step, sessionId: ctx.sessionId, kind: ctx.kind })],
      { cwd: ctx.worktree, stdio: ['ignore', 'pipe', 'pipe'] });
    return supervise(child, ctx.timeoutMs, parseClaudeStreamLine);
  }
}
