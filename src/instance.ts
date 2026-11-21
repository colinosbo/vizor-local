import { spawn } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAlive } from './runner.js';

/** One server per data folder: two would both schedule the same tasks. */
export function readRunning(dataDir: string): { pid: number; url: string } | null {
  try {
    const j = JSON.parse(readFileSync(join(dataDir, 'server.json'), 'utf8'));
    return j.pid !== process.pid && isAlive(j.pid) ? j : null;
  } catch { return null; }
}

export function claimInstance(dataDir: string, url: string) {
  const file = join(dataDir, 'server.json');
  writeFileSync(file, JSON.stringify({ pid: process.pid, url }), { mode: 0o600 });
  const release = () => { try { const j = JSON.parse(readFileSync(file, 'utf8')); if (j.pid === process.pid) rmSync(file, { force: true }); } catch { /* gone */ } };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => { release(); process.exit(0); });
}

export function openBrowser(url: string) {
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch { /* the URL is printed anyway */ }
}
