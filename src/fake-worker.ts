// Child process used by FakeWorkerFactory. Emits Claude-like stream-json lines and applies scripted edits.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { FakeStep } from './workers.js';

const step = JSON.parse(process.argv[2]) as FakeStep & { sessionId: string; kind: string };
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n');
const say = (text: string) => out({ type: 'assistant', session_id: step.sessionId, message: { content: [{ type: 'text', text }] } });

out({ type: 'system', subtype: 'init', session_id: step.sessionId });
say(step.say ?? `(${step.kind}) applying scripted change`);
// Names only, never values: lets tests check which variables reach a worker.
if (step.printEnv) say(JSON.stringify(Object.keys(process.env)));
for (const [p, content] of Object.entries(step.files)) {
  const abs = resolve(process.cwd(), p);
  if (!abs.startsWith(process.cwd())) throw new Error('path escapes worktree');
  out({ type: 'assistant', session_id: step.sessionId, message: { content: [{ type: 'tool_use', name: content === null ? 'Delete' : 'Write', input: { file_path: p } }] } });
  if (content === null) rmSync(abs, { force: true });
  else { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, content); }
}
out({ type: 'user', session_id: step.sessionId, message: { content: [{ type: 'tool_result', content: 'node --test: (simulated) ok' }] } });
setTimeout(() => {
  out({ type: 'result', subtype: step.exitCode ? 'error' : 'success', is_error: !!step.exitCode, session_id: step.sessionId, result: 'done' });
  process.exit(step.exitCode ?? 0);
}, step.sleepMs ?? 50);
