import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

// Release hygiene for 'Start Vizor Local.cmd': bundled skills are copied only after consent that is asked
// once and saved under %USERPROFILE%\.local-poc, never as an unconditional top-level step, and the file is CRLF.

const raw = fs.readFileSync(path.join(process.cwd(), 'Start Vizor Local.cmd'), 'utf8');
const lines = raw.split(/\r?\n/);

const isComment = (l: string) => /^\s*(rem\b|::)/i.test(l);
const isEcho = (l: string) => /^\s*(?:>\s*"[^"]*"\s*)?echo\b/i.test(l);
/** Command lines that copy something with 'skills' in them (echo text and comments excluded). */
const copiesSkills = (l: string) =>
  !isComment(l) && !isEcho(l) && /\b(xcopy|robocopy|copy)\b/i.test(l) && /skills/i.test(l);

const mainExit = lines.findIndex((l) => /^\s*exit\s+\/b\s+0\b/i.test(l));
const firstLabelAfterMain = lines.findIndex((l, i) => i > mainExit && /^\s*:[A-Za-z_]/.test(l));

test('the main flow ends with exit /b 0 followed by label subroutines', () => {
  assert.ok(mainExit > 0, 'main flow has an exit /b 0');
  assert.ok(firstLabelAfterMain > mainExit, 'a :label follows the main exit /b 0');
});

test('the old unconditional skills xcopy with /Y is gone', () => {
  assert.ok(!/xcopy\s+"%~dp0skills"\s+"%USERPROFILE%\\\.claude\\skills\\"[^\r\n]*\/Y/i.test(raw));
  for (const [i, l] of lines.entries()) {
    if (i < firstLabelAfterMain) assert.ok(!(copiesSkills(l) && /\/Y\b/i.test(l)), `line ${i + 1}: ${l}`);
  }
});

test('every skills copy sits in a label subroutine or an if guard', () => {
  const copyLines = lines.map((l, i) => ({ l, i })).filter(({ l }) => copiesSkills(l));
  assert.ok(copyLines.length > 0, 'the launcher can still install skills');
  for (const { l, i } of copyLines) {
    const guarded = /^\s*if\b/i.test(l) || i > firstLabelAfterMain;
    assert.ok(guarded, `line ${i + 1} copies skills at top level: ${l}`);
  }
});

test('the main flow hands skills to a subroutine', () => {
  const main = lines.slice(0, mainExit).filter((l) => !isComment(l));
  assert.ok(main.some((l) => /^\s*call\s+:\w+.*skills/i.test(l)), 'main flow calls the skills subroutine');
});

test('consent is kept in an answer file under .local-poc', () => {
  assert.ok(raw.includes('.local-poc'), 'references the Vizor data folder');
  assert.match(raw, /skills-consent\.txt/i);
  assert.match(raw, /mkdir\s+"%CONSENT_DIR%"/i, 'creates the data folder when missing');
  assert.match(raw, />\s*"%CONSENT_FILE%"\s*echo yes/i, 'saves yes');
  assert.match(raw, />\s*"%CONSENT_FILE%"\s*echo never/i, 'saves never');
  assert.match(raw, /set \/p ANSWER=<"%CONSENT_FILE%"/i, 'reads the saved answer');
  assert.match(raw, /Delete[^\r\n]*CONSENT_FILE[^\r\n]*/i, 'tells the user that deleting the file asks again');
});

test('asks once with install / not now / never, and lists what will be copied and where', () => {
  assert.match(raw, /\bchoice\s+\/c\s+YNX\b/i);
  assert.match(raw, /not now/i);
  assert.match(raw, /never ask again/i);
  assert.match(raw, /if \/i "%ANSWER%"=="never" goto/i, 'a saved never skips the prompt');
  assert.match(raw, /if \/i "%ANSWER%"=="yes" goto/i, 'a saved yes skips the prompt');
  assert.match(raw, /for \/d %%S in \("%SKILLS_SRC%\\\*"\) do echo/i, 'lists each skill folder by name');
  assert.match(raw, /%USERPROFILE%\\\.claude\\skills/i, 'names the destination');
});

test('existing skills are only replaced after a separate yes, defaulting to no', () => {
  assert.match(raw, /if exist "%SKILLS_DEST%\\%SKILL_NAME%\\" goto/i);
  assert.match(raw, /set \/p "REPLACE=[^"]*\[y\/N\]/i, 'per-skill prompt defaults to no');
  const overwrite = lines.findIndex((l) => copiesSkills(l) && /\/Y\b/i.test(l));
  const ask = lines.findIndex((l) => /set \/p "REPLACE=/i.test(l));
  assert.ok(ask > 0 && overwrite > ask, 'the only /Y copy comes after the per-skill question');
  assert.match(raw, /echo Copied skill:/i);
  assert.match(raw, /echo Skipped skill:/i);
});

test('the other launcher steps are unchanged', () => {
  for (const step of [
    'where node >nul 2>nul',
    'where git >nul 2>nul',
    'where claude >nul 2>nul',
    'call npm install || goto fail',
    'call npm run build || goto fail',
    'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\make-shortcut.ps1"',
    'dist\\src\\cli.js serve --orchestrator claude --worker claude --open',
    ':fail',
  ]) assert.ok(raw.includes(step), step);
});

test('every line ends in CRLF', () => {
  assert.ok(raw.endsWith('\r\n'), 'last line ends in CRLF');
  const bare = [...raw.matchAll(/(?<!\r)\n/g)].length;
  assert.strictEqual(bare, 0, 'no LF without a preceding CR');
});
