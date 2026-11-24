import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { killTree } from './forge.js';
import { git } from './git.js';
import { isModelDefault, type PlanBody, type Project } from './types.js';

/**
 * The orchestrator turns a feature request into a DRAFT plan. It cannot approve plans,
 * change permissions or touch the scheduler: it only returns data that deterministic code validates.
 * An empty task list means the orchestrator declined (wrong repo, unclear request…); no plan is created.
 */
export type Progress = (text: string) => void;
export interface Orchestrator { draft(project: Project, request: string, onProgress?: Progress): Promise<{ reply: string; plan: PlanBody }> }

export const PLAN_SCHEMA = {
  type: 'object', required: ['reply', 'plan'],
  properties: {
    reply: { type: 'string' },
    plan: { type: 'object', required: ['summary', 'tasks'], properties: {
      summary: { type: 'string' },
      tasks: { type: 'array', items: { type: 'object', required: ['key', 'title', 'prompt', 'acceptance', 'writeScope', 'deps', 'model', 'modelWhy'], properties: {
        key: { type: 'string' }, title: { type: 'string' }, prompt: { type: 'string' }, acceptance: { type: 'string' },
        model: { type: 'string', enum: ['opus', 'sonnet'] }, modelWhy: { type: 'string' },
        writeScope: { type: 'array', items: { type: 'string' } }, deps: { type: 'array', items: { type: 'string' } } } } } } },
  },
};

export function plannerPrompt(project: Project, files: string, request: string): string {
  const maxWorkers = project.max_workers ?? 1;
  return `You are the orchestrator for the repository below. Draft a plan for the feature request.
Planning rules (parallel first):
a. List every task's exact write scope before deciding deps. Two tasks may run in parallel only if their scopes share no file.
b. New code goes in new files: each new module, endpoint, view or component gets its own file, and each task adds its own test file. Never append a feature to a shared file when a new file can hold it.
c. Shared touchpoints (src/server.ts, src/db.ts, src/cli.ts, route tables, navigation, design tokens, shared test helpers) get one owner: a single integration task, usually last, that depends on the tasks it wires together.
d. Write contracts into the task prompts: when one task needs a field, table column, function signature or endpoint another task creates, state its exact name and shape in both prompts so they can run in parallel. Add a dep only when a task truly needs the other's merged code.
e. Aim for about ${maxWorkers} tasks per wave (this project's worker limit); more width adds nothing.
f. If the longest dependency chain is more than 4 tasks, find the file that forces it and restructure (split that file first in its own task) instead of accepting the chain.
g. One concern per task, so a retry or a usage-limit pause costs little.
h. End the plan summary with: tasks per wave, longest chain, and one line explaining each chain that remains.
Each task needs a kebab-case key, prompt, acceptance criteria, writeScope, deps, model and modelWhy. Never include secrets or CI/merge workflow files in scope.
Model: pick the Claude model that runs each task, and give modelWhy as one short sentence.
- "opus" for work that needs real problem solving: new architecture or data models, tricky algorithms, concurrency or state machines, security-sensitive logic, cross-cutting refactors, debugging unclear failures.
- "sonnet" for well-specified work: UI layout and styling, copy and docs, config, simple CRUD, renames, tests for existing behavior, small isolated edits.
When unsure, pick "sonnet". A task whose CI fails is repaired on "opus" automatically, so do not pick opus just in case.

How changes are verified: Local's trusted CI runs exactly this command in a clean checkout of each PR: ${project.ci_command}
Write acceptance criteria that this command can check. Never tell workers to run \`node --test <directory>\` (a directory argument fails on Node 22+);
use the CI command above, or \`node --test\` with no path, or explicit test file paths.
Skills: every task that creates or changes UI must say in its prompt: "Use the unslop skill (read its SKILL.md and follow it)." Name other skills from .claude/skills/ when they fit.
If the request does not fit this repository, return an empty tasks array and explain why in reply.

Files:
${files}

Feature request (user text):
<request>${request}</request>`;
}

/** Turn one stream-json line into a short progress note for the planning screen. */
export function planningNote(j: any): string | null {
  if (j?.type === 'system' && j.subtype === 'init') return 'Planner started';
  if (j?.type !== 'assistant') return null;
  for (const c of j.message?.content ?? []) {
    if (c.type === 'tool_use' && c.name !== 'StructuredOutput') {
      const target = c.input?.file_path ?? c.input?.pattern ?? c.input?.path ?? '';
      return `${c.name} ${String(target)}`.trim().slice(0, 160);
    }
    if (c.type === 'text' && c.text?.trim()) return c.text.trim().split('\n')[0].slice(0, 160);
  }
  return null;
}

/** Planner CLI argv. A project planner_model of 'sonnet' or 'opus' adds --model; 'auto' lets the CLI choose. */
export function plannerArgs(project: Pick<Project, 'planner_model'>, prompt: string, preArgs: string[] = []): string[] {
  const args = [...preArgs, '-p', prompt, '--output-format', 'stream-json', '--verbose',
    '--json-schema', JSON.stringify(PLAN_SCHEMA), '--permission-mode', 'default', '--allowedTools', 'Read', 'Glob', 'Grep'];
  const model = project.planner_model;
  if (isModelDefault(model) && model !== 'auto') args.push('--model', model);
  return args;
}

/**
 * Claude Code CLI in print mode, read-only tools, streamed so the dashboard can show progress.
 * The final `result` line carries `structured_output` (verified with --output-format json on 2.1.328);
 * the StructuredOutput tool_use fallback covers CLI versions that only stream it as a tool call (unverified).
 */
export class ClaudeOrchestrator implements Orchestrator {
  constructor(private bin = 'claude', private preArgs: string[] = [], private timeoutMs = 10 * 60_000) {}
  draft(project: Project, request: string, onProgress?: Progress) {
    const files = git(project.repo_path, ['ls-files']).split('\n').slice(0, 300).join('\n');
    const args = plannerArgs(project, plannerPrompt(project, files, request), this.preArgs);
    return new Promise<{ reply: string; plan: PlanBody }>((resolve, reject) => {
      const c = spawn(this.bin, args, { cwd: project.repo_path, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      let err = '', result: any = null, toolPayload: any = null, timedOut = false;
      const timer = setTimeout(() => { timedOut = true; killTree(c); }, this.timeoutMs);
      createInterface({ input: c.stdout! }).on('line', (line) => {
        let j: any; try { j = JSON.parse(line); } catch { return; }
        if (j.type === 'result') result = j;
        if (j.type === 'assistant') for (const x of j.message?.content ?? []) if (x.type === 'tool_use' && x.name === 'StructuredOutput') toolPayload = x.input;
        const note = planningNote(j); if (note) onProgress?.(note);
      });
      c.stderr!.on('data', (d) => (err = (err + d).slice(-2000)));
      c.on('error', (e) => { clearTimeout(timer); reject(e); });
      c.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) return reject(new Error(`planner timed out after ${Math.round(this.timeoutMs / 60000)} min`));
        if (result?.is_error) return reject(new Error(`planner error: ${String(result.result ?? result.subtype).slice(0, 300)}`));
        if (code !== 0) return reject(new Error(`planner exited ${code}: ${err.slice(-500)}`));
        try {
          const payload = result?.structured_output ?? toolPayload ?? JSON.parse(result?.result);
          if (!payload?.plan || !Array.isArray(payload.plan.tasks)) throw new Error('missing plan');
          resolve(payload);
        } catch { reject(new Error('planner returned no structured plan: ' + String(result?.result ?? '').slice(0, 300))); }
      });
    });
  }
}

/** Deterministic orchestrator for demos/tests. */
export class CannedOrchestrator implements Orchestrator {
  constructor(private plan: PlanBody) {}
  async draft(_p: Project, _r: string, onProgress?: Progress) {
    onProgress?.('Reading the repository');
    return { reply: `Drafted ${this.plan.tasks.length} tasks. Review and approve to start.`, plan: this.plan };
  }
}
