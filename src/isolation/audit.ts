// Post-attempt security audit: scans the worker_output events an attempt recorded and reports
// tool calls that touched a denied path or looked like outbound network traffic.
//
// This is after-the-fact detection on output that was already truncated (tool inputs are cut to
// 300 characters, results to 1200 before they are stored). It can miss things, and it is NOT
// enforcement: nothing here blocks a call. It only records, and it never throws on odd input.

export interface SecurityEvent { tool: string; command: string; reason: string }

export interface AttemptSecurity { deniedAttempts: number; networkCommands: number; events: SecurityEvent[] }

/** Local minimal copy of the worker event shape (see WorkerEvent in workers.ts); kept separate on purpose. */
interface WorkerLine { kind: string; text: string }

const MAX_EVENTS = 50;
const MAX_COMMAND = 300;
const TOOL_PREFIX = '▶ ';
const PATH_TOOLS: ReadonlySet<string> = new Set(['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'PowerShell']);
const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell']);
const INPUT_FIELDS = ['command', 'file_path', 'path', 'pattern'] as const;
const RESULT_TOOL = 'tool_result';

// A shell token boundary: unlike \b, '-', '.', '/' and '_' do not end a word, so 'ssh-keygen',
// '~/.ssh/' and 'github' never match 'ssh' or 'gh'.
const B = String.raw`(?:^|[\s;&|()\x60'"])`;
const E = String.raw`(?=$|[\s;&|()\x60'"])`;
const word = (w: string): RegExp => new RegExp(`${B}${w}${E}`, 'i');

const CURL = word('curl');
const CURL_SEND = /(?:^|\s)(?:-X\s*|--request[\s=]+)['"]?(?:POST|PUT)\b|(?:^|\s)(?:-d|-F|-T|--data(?:-[a-z]+)?|--form(?:-string)?|--upload-file|--json)(?=[\s=]|$)/i;
const WGET = word('wget');
const WGET_SEND = /--(?:post-data|post-file|body-data|body-file)\b|--method[\s=]+['"]?(?:POST|PUT)\b/i;
const PS_WEB = new RegExp(`${B}(Invoke-WebRequest|iwr|Invoke-RestMethod|irm)${E}`, 'i');
const PS_SEND = /-Method\s+['"]?(?:Post|Put)\b|-InFile\b/i;
const GIT_PUSH = new RegExp(`${B}git(?:\\s+-[^\\s]+(?:\\s+[^\\s-][^\\s]*)?)*\\s+push${E}`, 'i');
const PLAIN: readonly (readonly [string, RegExp])[] = [
  ['scp', word('scp')],
  ['sftp', word('sftp')],
  ['ssh', word('ssh')],
  ['rsync', word('rsync')],
  ['gh', word('gh(?:\\.exe)?')],
  ['ncat', word('ncat')],
  ['nc', word('nc')],
];

const PERMISSION_DENIED = /\bpermission\b[^\n]{0,60}?\bdenied\b|\bdenied permission\b|\bEACCES\b|\baccess is denied\b|haven't granted it/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isWorkerLine(v: unknown): v is WorkerLine {
  return isRecord(v) && typeof v.kind === 'string' && typeof v.text === 'string';
}

/** Splits a shell command into simple segments so flags are only checked against their own program. */
function segments(command: string): string[] {
  return command.split(/\|\||&&|[;|&\n]/);
}

/**
 * Returns a short label for the outbound network tool a shell command uses ('curl POST', 'git push',
 * 'ssh', ...), or null. The caller prefixes it with 'network: '.
 */
export function isOutboundCommand(command: string): string | null {
  if (typeof command !== 'string' || command.length === 0) return null;
  for (const seg of segments(command)) {
    const curl = CURL.exec(seg);
    if (curl && CURL_SEND.test(seg.slice(curl.index + curl[0].length))) return 'curl upload';
    const wget = WGET.exec(seg);
    if (wget && WGET_SEND.test(seg.slice(wget.index + wget[0].length))) return 'wget upload';
    const ps = PS_WEB.exec(seg);
    if (ps && PS_SEND.test(seg.slice(ps.index + ps[0].length))) return ps[1] ?? 'Invoke-WebRequest';
    if (GIT_PUSH.test(seg)) return 'git push';
    for (const [label, re] of PLAIN) if (re.test(seg)) return label;
  }
  return null;
}

/** Lowercases and folds every run of / or \ into one '/', so JSON-escaped Windows paths compare equal. */
function normalizePath(p: string): string {
  return p.toLowerCase().replace(/[\\/]+/g, '/');
}

function unescapeJsonFragment(s: string): string {
  try {
    const v: unknown = JSON.parse(`"${s}"`);
    return typeof v === 'string' ? v : s;
  } catch {
    return s.replace(/\\(.)/g, '$1').replace(/\\$/, '');
  }
}

/** Pulls the path-like fields out of the (possibly truncated) JSON tool input. */
function inputFields(json: string): Partial<Record<(typeof INPUT_FIELDS)[number], string>> {
  const out: Partial<Record<(typeof INPUT_FIELDS)[number], string>> = {};
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { parsed = undefined; }
  for (const f of INPUT_FIELDS) {
    if (isRecord(parsed)) {
      const v = parsed[f];
      if (typeof v === 'string') out[f] = v;
      continue;
    }
    // Truncated JSON: the value may lack its closing quote, so capture to the quote or the end.
    const m = new RegExp(`"${f}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*(?:\\\\)?)`).exec(json);
    if (m && m[1] !== undefined) out[f] = unescapeJsonFragment(m[1]);
  }
  return out;
}

export function auditAttempt(
  events: readonly { type: string; data: unknown }[],
  opts: { deniedPaths: readonly string[] },
): AttemptSecurity {
  const result: AttemptSecurity = { deniedAttempts: 0, networkCommands: 0, events: [] };
  const denied = (Array.isArray(opts?.deniedPaths) ? opts.deniedPaths : [])
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .map((p) => ({ raw: p, norm: normalizePath(p) }));
  // One entry per tool call seen, in order: true if it was already counted as a denied attempt.
  // Each tool result consumes one, so a blocked call and its "permission denied" reply count once.
  const pendingCalls: boolean[] = [];

  const record = (tool: string, command: string, reasons: string[]): void => {
    if (reasons.length === 0 || result.events.length >= MAX_EVENTS) return;
    result.events.push({ tool, command: command.slice(0, MAX_COMMAND), reason: reasons.join('; ') });
  };

  if (!Array.isArray(events)) return result;
  for (const ev of events) {
    if (!isRecord(ev) || ev.type !== 'worker_output' || !isWorkerLine(ev.data)) continue;
    const { kind, text } = ev.data;

    if (kind === 'tool') {
      for (const line of text.split('\n')) {
        if (!line.startsWith(TOOL_PREFIX)) continue;
        const body = line.slice(TOOL_PREFIX.length);
        const space = body.indexOf(' ');
        const tool = space === -1 ? body : body.slice(0, space);
        const fields = inputFields(space === -1 ? '' : body.slice(space + 1));
        const reasons: string[] = [];
        let wasDenied = false;

        if (PATH_TOOLS.has(tool)) {
          const haystacks = INPUT_FIELDS.map((f) => fields[f]).filter((v): v is string => v !== undefined).map(normalizePath);
          const hit = denied.find((d) => haystacks.some((h) => h.includes(d.norm)));
          if (hit) {
            result.deniedAttempts++;
            wasDenied = true;
            reasons.push(`denied path: ${hit.raw}`);
          }
        }
        const command = fields.command ?? '';
        if (SHELL_TOOLS.has(tool) && command) {
          const net = isOutboundCommand(command);
          if (net) {
            result.networkCommands++;
            reasons.push(`network: ${net}`);
          }
        }
        pendingCalls.push(wasDenied);
        record(tool, command || fields.file_path || fields.path || fields.pattern || '', reasons);
      }
    } else if (kind === 'command') {
      const alreadyCounted = pendingCalls.shift() ?? false;
      if (!alreadyCounted && PERMISSION_DENIED.test(text)) {
        result.deniedAttempts++;
        record(RESULT_TOOL, text, ['permission denied']);
      }
    }
  }
  return result;
}
