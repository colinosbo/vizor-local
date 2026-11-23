// Push guard scanner: one refusal per rule family, the allowed negatives, stable ids and redaction.
// Every fake token and key header below is assembled at runtime so this file never trips the guard.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { DENYLIST, DENYLIST_GITIGNORE, filterOverridden, scanPush, SECRET_RULES, type PushFinding } from '../src/push-guard.js';

// Made-up identity: tests never depend on the machine's real user.
const FAKE_USER = 'qz' + 'fakeowner';
const WIN_HOME = ['C:', 'Users', FAKE_USER].join('\\');
const OPTS = { homeDir: WIN_HOME, username: FAKE_USER };

const TOKENS: Record<string, string> = {
  ghp: 'gh' + 'p_' + 'a1B2'.repeat(9),
  gho: 'gh' + 'o_' + 'Z9y8'.repeat(9),
  ghu: 'gh' + 'u_' + 'Qw3e'.repeat(9),
  ghs: 'gh' + 's_' + 'Rt5y'.repeat(9),
  ghr: 'gh' + 'r_' + 'Ui7o'.repeat(9),
  githubPat: 'github' + '_pat_' + '11ABCDEFG0'.repeat(2) + 'ab_' + 'xY12'.repeat(15),
  openai: 's' + 'k-' + 'Ab3dEf6hIj9lMn2pQr5tUv8xYz1bCd4fGh7jKl0nOp3r',
  openaiProj: 's' + 'k-proj-' + 'Ab3d_Ef6h-IjK9'.repeat(5),
  aws: 'AK' + 'IA' + 'ABCDEFGH23456789',
  awsSession: 'AS' + 'IA' + 'ZYXWVUTS98765432',
  google: 'AI' + 'za' + 'Sy' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6q',
  slackBot: 'xo' + 'xb-' + '123456789012-1234567890123-' + 'AbCdEfGhIjKlMnOpQrStUvWx',
  slackUser: 'xo' + 'xp-' + '123456789012-abcdefghijkl',
  slackHook: 'https://hooks.' + 'slack.com/services/' + 'T00000000/B00000000/' + 'X'.repeat(24),
};
const keyHeader = (kind: string) => '-----' + 'BEGIN ' + (kind ? kind + ' ' : '') + 'PRIVATE' + ' KEY' + (kind === 'PGP' ? ' BLOCK' : '') + '-----';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Temp repo with an empty base commit. `range()` covers everything committed after it. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'push-guard-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'Guard Test');
  git(dir, 'config', 'user.email', 'guard@example.invalid');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  return {
    dir,
    range: () => `${base}..HEAD`,
    commit(files: Record<string, string | Buffer | null>, msg = 'change') {
      for (const [p, content] of Object.entries(files)) {
        const full = join(dir, p);
        if (content === null) { rmSync(full); continue; }
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', msg);
      return git(dir, 'rev-parse', 'HEAD');
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function scanOne(files: Record<string, string | Buffer>, opts: Parameters<typeof scanPush>[2] = OPTS): Promise<PushFinding[]> {
  const r = makeRepo();
  try {
    r.commit(files);
    return await scanPush(r.dir, r.range(), opts);
  } finally { r.cleanup(); }
}

const rules = (fs: PushFinding[]) => fs.map((f) => f.rule).sort();

test('DENYLIST and its .gitignore form', () => {
  assert.deepEqual(DENYLIST, ['.env*', '*.pem', '*.key', '*.db', 'server.json', 'private/']);
  assert.deepEqual(DENYLIST_GITIGNORE.split('\n'), [...DENYLIST, '!.env.example']);
});

test('refuses each secret token family', async () => {
  const cases: [string, string][] = [
    ['ghp', 'github-token'], ['gho', 'github-token'], ['ghu', 'github-token'], ['ghs', 'github-token'], ['ghr', 'github-token'],
    ['githubPat', 'github-pat'],
    ['openai', 'openai-key'], ['openaiProj', 'openai-key'],
    ['aws', 'aws-access-key'], ['awsSession', 'aws-access-key'],
    ['google', 'google-api-key'],
    ['slackBot', 'slack-token'], ['slackUser', 'slack-token'], ['slackHook', 'slack-webhook'],
  ];
  const files: Record<string, string> = {};
  cases.forEach(([k], i) => { files[`src/f${i}.ts`] = `// line one\nconst v = "${TOKENS[k]}";\n`; });
  const r = makeRepo();
  try {
    const sha = r.commit(files);
    const found = await scanPush(r.dir, r.range(), OPTS);
    for (const [[k, rule], i] of cases.map((c, i) => [c, i] as const)) {
      const f = found.find((x) => x.file === `src/f${i}.ts`);
      assert.ok(f, `${k} should be found`);
      assert.equal(f.kind, 'secret');
      assert.equal(f.rule, rule, k);
      assert.equal(f.line, 2, k);
      assert.equal(f.commit, sha);
      assert.ok(f.reason.length > 0);
    }
    assert.equal(found.length, cases.length);
  } finally { r.cleanup(); }
});

test('refuses private-key blocks of every variant', async () => {
  for (const kind of ['', 'RSA', 'EC', 'OPENSSH', 'DSA', 'ENCRYPTED', 'PGP']) {
    const found = await scanOne({ 'notes/k.txt': `${keyHeader(kind)}\nMIIB\n` });
    assert.deepEqual(rules(found), ['private-key'], `variant "${kind}"`);
    assert.equal(found[0].reason, 'contains a private key');
  }
});

test('refuses each denylist pattern', async () => {
  const cases: [string, string][] = [
    ['.env', '.env*'], ['.env.local', '.env*'], ['config/x.pem', '*.pem'], ['x.key', '*.key'],
    ['data.db', '*.db'], ['server.json', 'server.json'], ['private/notes.txt', 'private/'], ['a/private/b/c.md', 'private/'],
  ];
  for (const [path, rule] of cases) {
    const found = await scanOne({ [path]: 'harmless\n' });
    assert.equal(found.length, 1, path);
    assert.equal(found[0].kind, 'denylist');
    assert.equal(found[0].rule, rule, path);
    assert.equal(found[0].file, path);
    assert.equal(found[0].line, undefined);
    assert.match(found[0].reason, rule === 'private/' ? /private\// : /^file name matches /);
  }
});

test('binary denylisted files are reported by path only', async () => {
  const found = await scanOne({ 'store/app.db': Buffer.from([0, 1, 2, 0, 255, 0]) });
  assert.equal(found.length, 1);
  assert.equal(found[0].rule, '*.db');
  assert.equal(found[0].excerpt, undefined);
});

test('allows example env files and non-private look-alikes', async () => {
  assert.deepEqual(await scanOne({
    '.env.example': 'A=1\n', '.env.sample': 'A=1\n', '.env.template': 'A=1\n',
    'privateer/x.txt': 'ok\n', 'src/private.ts': 'export {}\n', 'keys.md': 'ok\n',
  }), []);
});

test('refuses the home path in backslash, forward-slash and JSON-escaped forms', async () => {
  const fwd = WIN_HOME.replaceAll('\\', '/');
  const json = WIN_HOME.replaceAll('\\', '\\\\');
  for (const text of [WIN_HOME + '\\proj', fwd.toLowerCase() + '/proj', `{"p": "${json}\\\\proj"}`]) {
    const found = await scanOne({ 'cfg.txt': `x\n${text}\n` });
    assert.deepEqual(rules(found), ['home-path'], text);
    assert.equal(found[0].kind, 'personal');
    assert.equal(found[0].line, 2);
    assert.equal(found[0].reason, 'contains your home folder path');
  }
  // POSIX-style home too.
  const posix = await scanOne({ 'a.sh': `cd /home/${FAKE_USER}/work\n` }, { homeDir: `/home/${FAKE_USER}`, username: FAKE_USER });
  assert.deepEqual(rules(posix), ['home-path']);
});

test('refuses the username as a whole word, case-insensitively', async () => {
  const found = await scanOne({ 'README.md': `Written by ${FAKE_USER.toUpperCase()}.\n` });
  assert.deepEqual(rules(found), ['username']);
  assert.equal(found[0].reason, 'contains your username');
  assert.deepEqual(await scanOne({ 'README.md': `x${FAKE_USER}y and ${FAKE_USER}_2\n` }), []);
});

test('ignores short or generic usernames', async () => {
  assert.deepEqual(await scanOne({ 'a.txt': 'al was here\n' }, { homeDir: WIN_HOME, username: 'al' }), []);
  for (const u of ['root', 'Admin', 'runner', 'node', 'user']) {
    assert.deepEqual(await scanOne({ 'a.txt': `${u} was here\n` }, { homeDir: WIN_HOME, username: u }), [], u);
  }
});

test('ignores a short sk- string', async () => {
  assert.deepEqual(await scanOne({ 'a.ts': 'const k = "' + 's' + 'k-1";\nconst css = "sk-loading";\n' }), []);
});

test('a clean commit returns []', async () => {
  assert.deepEqual(await scanOne({ 'src/hello.ts': 'export const hello = "world";\n' }), []);
});

test('finds a secret added then deleted within the range', async () => {
  const r = makeRepo();
  try {
    const added = r.commit({ 'cfg.ts': `export const k = "${TOKENS.aws}";\n` }, 'add');
    r.commit({ 'cfg.ts': 'export const k = process.env.K;\n' }, 'remove');
    r.commit({ 'cfg.ts': null }, 'delete file');
    const found = await scanPush(r.dir, r.range(), OPTS);
    assert.deepEqual(rules(found), ['aws-access-key']);
    assert.equal(found[0].commit, added);
  } finally { r.cleanup(); }
});

test('ids are stable across rescans and later commits; excerpts are redacted', async () => {
  const r = makeRepo();
  try {
    const all = Object.values(TOKENS).concat(keyHeader('RSA'));
    r.commit({ 'leak.txt': all.join('\n') + '\n', '.env': 'A=1\n' });
    const first = await scanPush(r.dir, r.range(), OPTS);
    const again = await scanPush(r.dir, r.range(), OPTS);
    assert.deepEqual(first, again);
    for (const f of first) assert.match(f.id, /^[0-9a-f]{16}$/);
    assert.equal(new Set(first.map((f) => f.id)).size, first.length);

    // Same secret re-added in a new commit elsewhere in the file keeps its id.
    r.commit({ 'leak.txt': 'header\n\n' + all.join('\n') + '\n' + TOKENS.ghp + '\n' });
    const later = await scanPush(r.dir, r.range(), OPTS);
    for (const f of first) assert.ok(later.some((g) => g.id === f.id), `id ${f.rule} stable`);

    const json = JSON.stringify(first);
    for (const t of all) assert.ok(!json.includes(t), 'no field holds a full token');
    for (const f of first.filter((x) => x.kind === 'secret')) {
      assert.ok(f.excerpt, f.rule);
      assert.ok(f.excerpt.endsWith('…'));
      assert.ok(f.excerpt.length <= 5);
    }
  } finally { r.cleanup(); }
});

test('filterOverridden drops only the overridden ids', async () => {
  const found = await scanOne({ 'a.txt': TOKENS.ghp + '\n', 'b.pem': 'x\n' });
  assert.equal(found.length, 2);
  const pem = found.find((f) => f.rule === '*.pem')!;
  assert.deepEqual(filterOverridden(found, [pem.id]), found.filter((f) => f !== pem));
  assert.deepEqual(filterOverridden(found, new Set<string>()), found);
  assert.deepEqual(filterOverridden(found, found.map((f) => f.id)), []);
});

test('fails closed when the diff exceeds maxBytes', async () => {
  const found = await scanOne({ 'big.txt': 'clean line\n'.repeat(500) }, { ...OPTS, maxBytes: 1000 });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'secret');
  assert.equal(found[0].rule, 'too-large');
});

test('every secret rule is exercised', () => {
  assert.deepEqual(SECRET_RULES.map((r) => r.name).sort(),
    ['aws-access-key', 'github-pat', 'github-token', 'google-api-key', 'openai-key', 'private-key', 'slack-token', 'slack-webhook']);
});
