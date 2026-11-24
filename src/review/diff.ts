// The PR diff the reviewer sees: base...head (changes since the merge base), read from the project checkout.
import { execFile } from 'node:child_process';

const MAX_DIFF_BYTES = 16 * 1024 * 1024;

function git(repoPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: repoPath, windowsHide: true, maxBuffer: MAX_DIFF_BYTES }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]} failed: ${String(stderr || err.message).trim().slice(0, 300)}`));
      else resolve(stdout);
    });
  });
}

/** Unified diff and changed paths of headSha against its merge base with baseRef. Throws when git fails. */
export async function prDiff(repoPath: string, baseRef: string, headSha: string): Promise<{ diff: string; changedFiles: string[] }> {
  if (baseRef.startsWith('-') || headSha.startsWith('-')) throw new Error('refusing a ref that looks like an option');
  const range = `${baseRef}...${headSha}`;
  const [diff, names] = await Promise.all([
    git(repoPath, ['diff', '--no-color', '--no-ext-diff', range, '--']),
    git(repoPath, ['diff', '--name-only', '--no-ext-diff', range, '--']),
  ]);
  return { diff, changedFiles: names.split(/\r?\n/).filter((n) => n !== '') };
}
