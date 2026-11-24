import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BASE_ENV_ALLOWLIST, buildWorkerEnv, isSecretName, SIGN_IN_ALLOWLIST } from '../src/isolation/env.js';

const SECRET_NAMES = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AZURE_CLIENT_SECRET',
  'OPENAI_API_KEY',
  'MY_SERVICE_TOKEN',
  'DB_PASSWORD',
  'STRIPE_SECRET',
  'SOME_API_KEY',
] as const;

function fixture(): Record<string, string | undefined> {
  const src: Record<string, string | undefined> = {
    Path: 'C:\\Windows\\system32;C:\\Program Files\\nodejs',
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Temp',
    USERPROFILE: 'C:\\Users\\dev',
    NODE_OPTIONS: '--inspect',
    RANDOM_VAR: 'x',
    HOME: undefined,
    ANTHROPIC_API_KEY: 'sk-ant-test',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test',
    ANTHROPIC_BASE_URL: 'https://proxy.example',
    CLAUDE_CONFIG_DIR: 'C:\\cfg',
  };
  for (const n of SECRET_NAMES) src[n] = `secret-${n}`;
  return src;
}

test('every secret-like name is absent from the result', () => {
  const env = buildWorkerEnv(fixture(), [...SECRET_NAMES]);
  for (const n of SECRET_NAMES) {
    assert.equal(n in env, false, `${n} leaked`);
    assert.equal(isSecretName(n), true, `${n} not screened`);
  }
});

test('Path keeps its casing and value', () => {
  const src = fixture();
  const env = buildWorkerEnv(src);
  assert.equal(env.Path, src.Path);
  assert.equal('PATH' in env, false);
  assert.equal(env.SystemRoot, 'C:\\Windows');
});

test('names on no list are absent, and undefined values are skipped', () => {
  const env = buildWorkerEnv(fixture());
  assert.equal('NODE_OPTIONS' in env, false);
  assert.equal('RANDOM_VAR' in env, false);
  assert.equal('HOME' in env, false);
});

test('SIGN_IN_ALLOWLIST names survive the secret screen', () => {
  const src = fixture();
  const env = buildWorkerEnv(src);
  for (const n of SIGN_IN_ALLOWLIST) {
    assert.equal(env[n], src[n], `${n} missing`);
    assert.equal(isSecretName(n), false);
  }
});

test('extraAllow admits harmless names but cannot re-admit GITHUB_TOKEN', () => {
  const env = buildWorkerEnv(fixture(), ['GITHUB_TOKEN', 'github_token', 'random_var']);
  assert.equal('GITHUB_TOKEN' in env, false);
  assert.equal(env.RANDOM_VAR, 'x');
});

test('the source object is unchanged', () => {
  const src = fixture();
  const before = structuredClone(src);
  buildWorkerEnv(src, ['RANDOM_VAR']);
  assert.deepEqual(src, before);
});

test('base allowlist covers the names the task requires', () => {
  for (const n of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ComSpec', 'PATHEXT']) {
    assert.ok(BASE_ENV_ALLOWLIST.includes(n), n);
  }
});
