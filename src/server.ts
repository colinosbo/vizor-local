import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { DB } from './db.js';
import { setSetting } from './db.js';
import { emit, eventsAfter, subscribe, type EventRow } from './events.js';
import { resolveLocalOrigin } from './forges.js';
import { approvePlan, PlanInFlightError } from './plan.js';
import type { PlanningService } from './planning.js';
import { addProject, configureProject } from './projects.js';
import type { RoadmapService } from './roadmap.js';
import { pushNow, pushToGithub, setGithubRemote, shipStatus } from './ship.js';
import { folderStatus, syncCheckout } from './sync.js';
import type { Runner } from './runner.js';

const page = fileURLToPath(new URL('../../public/index.html', import.meta.url));

export interface ServerOpts {
  port?: number;            // preferred port; the next free one is used if it is taken
  token?: string;           // per-launch secret; random if omitted
  originsDir?: string;      // where `add project` may create local forge origins
  roadmap?: RoadmapService;
}
export interface RunningServer { server: Server; port: number; url: string; token: string; close(): Promise<void> }

/** Try `port`, then the next 20, then any free port. Avoids EADDRINUSE when another app holds 4317. */
function listen(server: Server, port: number): Promise<number> {
  const tryPort = (p: number) => new Promise<number>((resolve, reject) => {
    const onErr = (e: NodeJS.ErrnoException) => { server.off('listening', onOk); reject(e); };
    const onOk = () => { server.off('error', onErr); resolve((server.address() as { port: number }).port); };
    server.once('error', onErr); server.once('listening', onOk);
    server.listen(p, '127.0.0.1');
  });
  return (async () => {
    for (const p of [...Array.from({ length: 21 }, (_, i) => port + i), 0]) {
      try { return await tryPort(p); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' && (e as NodeJS.ErrnoException).code !== 'EACCES') throw e; }
    }
    throw new Error('no free port');
  })();
}

/**
 * Dashboard API, bound to 127.0.0.1. Every request needs the per-launch token (cookie, set by opening
 * the printed URL once) and a Host of 127.0.0.1/localhost on our port — so other local apps, other
 * browser tabs and DNS-rebinding pages cannot drive Local.
 */
export async function startServer(db: DB, runner: Runner, planning: PlanningService, opts: ServerOpts = {}): Promise<RunningServer> {
  const token = opts.token ?? randomBytes(24).toString('base64url');
  let port = 0;
  const cookieName = () => `local_token_${port}`; // cookies are not port-scoped; one name per instance
  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage) => new Promise<any>((resolve) => {
    let s = ''; req.on('data', (d) => { s += d; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); } });
  });
  const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const cookieToken = (req: IncomingMessage) => {
    for (const part of (req.headers.cookie ?? '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === cookieName()) return decodeURIComponent(v.join('='));
    }
    return '';
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      const host = req.headers.host ?? '';
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return json(res, 403, { error: 'bad host' });
      // First visit: /?t=<token> sets an HttpOnly cookie and drops the token from the address bar.
      const t = url.searchParams.get('t');
      if (req.method === 'GET' && url.pathname === '/' && t) {
        if (!same(t, token)) return json(res, 401, { error: 'wrong token; use the URL printed by `serve`' });
        res.writeHead(302, { location: '/', 'set-cookie': `${cookieName()}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/` });
        return res.end();
      }
      if (!same(cookieToken(req), token)) {
        if (url.pathname === '/') { res.writeHead(401, { 'content-type': 'text/plain' }); return res.end('Open the full URL printed in the terminal (it contains a one-time key).'); }
        return json(res, 401, { error: 'unauthorized' });
      }
      if (req.method !== 'GET') {
        const origin = req.headers.origin ?? '';
        if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return json(res, 403, { error: 'bad origin' });
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'json only' });
      }
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline'" });
        return res.end(readFileSync(page));
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        return json(res, 200, {
          projects: (db.prepare('SELECT * FROM projects ORDER BY created_at').all() as any[]).map((p) => {
            try { return { ...p, origin: resolveLocalOrigin(p), origin_error: null }; }
            catch (e) { return { ...p, origin: null, origin_error: String((e as Error).message ?? e) }; }
          }),
          plans: db.prepare('SELECT id, project_id, version, status, body FROM plans ORDER BY id').all(),
          tasks: db.prepare('SELECT * FROM tasks ORDER BY project_id, plan_id, rowid').all(),
          attempts: db.prepare('SELECT * FROM attempts ORDER BY started_at').all(),
          messages: db.prepare('SELECT * FROM messages ORDER BY id').all(),
          settings: db.prepare('SELECT * FROM settings').all(),
          planning: planning.list(),
          phases: db.prepare('SELECT * FROM phases ORDER BY project_id, position, id').all(),
          lastSeq: (db.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM events').get() as { s: number }).s,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        // SSE with replay from Last-Event-ID / ?after= so reconnects have no gaps or duplicates.
        let cursor = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0) || 0;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        const send = (e: EventRow) => { if (e.seq <= cursor) return; cursor = e.seq; res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`); };
        for (const e of eventsAfter(db, cursor, {}, 5000)) send(e);
        const unsub = subscribe(send);
        req.on('close', unsub);
        return;
      }
      if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'ship') {
        const p = runner.project(parts[2]) ?? fail(`unknown project ${parts[2]}`);
        const ship = await shipStatus(p, { fetch: url.searchParams.get('fetch') !== '0' });
        let folder = null; try { folder = folderStatus(p); } catch { /* folder missing */ }
        return json(res, 200, { ...ship, folder });
      }
      if (req.method === 'POST' && parts[0] === 'api') {
        const body = await readBody(req);
        const [, a, id, action] = parts;
        if (a === 'projects' && !id) {
          const p = addProject(db, String(body.path ?? ''), { maxWorkers: Number(body.maxWorkers ?? 1), ciCommand: body.ciCommand ? String(body.ciCommand) : undefined,
            name: body.name ? String(body.name) : undefined, createOrigin: !!body.createOrigin, createFolder: !!body.createFolder, originsDir: opts.originsDir });
          return json(res, 200, p);
        }
        if (a === 'projects' && action === 'chat') {
          const r = planning.start(runner.project(id) ?? fail(`unknown project ${id}`), String(body.text ?? ''));
          return json(res, 202, r);
        }
        if (a === 'projects' && action === 'clear-chat') {
          const project = runner.project(id) ?? fail(`unknown project ${id}`);
          if (planning.list().some((request) => request.projectId === project.id)) {
            return json(res, 409, { error: 'Wait for planning to finish before clearing chat' });
          }
          const { changes } = db.prepare('DELETE FROM messages WHERE project_id=?').run(project.id);
          if (changes) emit(db, { projectId: project.id, type: 'chat_cleared' });
          return json(res, 200, { ok: true });
        }
        if (a === 'projects' && action === 'config') {
          return json(res, 200, configureProject(db, id, { ciCommand: body.ciCommand !== undefined ? String(body.ciCommand) : undefined,
            maxWorkers: body.maxWorkers !== undefined ? Number(body.maxWorkers) : undefined, autoPush: body.autoPush !== undefined ? !!body.autoPush : undefined }));
        }
        if (a === 'projects' && action === 'push-now') {
          const p = runner.project(id) ?? fail('unknown project');
          const r = await pushNow(db, p);
          db.prepare('UPDATE projects SET auto_push_error=NULL WHERE id=?').run(p.id);
          return json(res, 200, r);
        }
        if (a === 'projects' && action === 'push') return json(res, 200, await pushToGithub(db, runner.project(id) ?? fail('unknown project'), String(body.sha ?? '')));
        if (a === 'projects' && action === 'github') { await setGithubRemote(db, runner.project(id) ?? fail('unknown project'), String(body.url ?? '')); return json(res, 200, { ok: true }); }
        if (a === 'projects' && action === 'sync') return json(res, 200, syncCheckout(db, runner.project(id) ?? fail('unknown project')));
        if (a === 'projects' && action === 'roadmap') return json(res, 200, (opts.roadmap ?? fail('roadmap not enabled')).add(id, String(body.text ?? '')));
        if (a === 'projects' && action === 'roadmap-pause') { (opts.roadmap ?? fail('roadmap not enabled')).pause(id, !!body.paused); return json(res, 200, { ok: true }); }
        if (a === 'phases' && action === 'retry') { (opts.roadmap ?? fail('roadmap not enabled')).retry(Number(id)); return json(res, 200, { ok: true }); }
        if (a === 'phases' && action === 'remove') { (opts.roadmap ?? fail('roadmap not enabled')).remove(Number(id)); return json(res, 200, { ok: true }); }
        if (a === 'plans' && action === 'approve') {
          // Owner-only route. Only a strict JSON boolean `true` forces; "true", 1, etc. do not.
          try { approvePlan(db, Number(id), body?.force === true ? { force: true } : {}); }
          catch (e) { if (e instanceof PlanInFlightError) return json(res, 409, { error: e.message, inFlight: e.tasks }); throw e; }
          return json(res, 200, { ok: true });
        }
        if (a === 'projects' && action === 'pause') { runner.pause(id, !!body.paused); return json(res, 200, { ok: true }); }
        if (a === 'projects' && action === 'workers') { configureProject(db, id, { maxWorkers: Number(body.maxWorkers) }); return json(res, 200, { ok: true }); }
        if (a === 'settings' && id === 'global') { setSetting(db, 'global_max_workers', String(Math.max(1, Math.min(12, Number(body.globalMaxWorkers) || 1)))); return json(res, 200, { ok: true }); }
        if (a === 'attempts' && action === 'cancel') { runner.cancel(id); return json(res, 200, { ok: true }); }
        if (a === 'tasks' && action === 'retry') { runner.retry(id); return json(res, 200, { ok: true }); }
        if (a === 'tasks' && action === 'merge-anyway') {
          // Owner-only route: merges a task held by plan supersession if every other merge check passes.
          try { return json(res, 200, { ok: true, ...runner.mergeAnyway(id) }); }
          catch (e) { return json(res, 400, { error: String((e as Error).message ?? e) }); }
        }
      }
      json(res, 404, { error: 'not found' });
    } catch (e) { json(res, 400, { error: String((e as Error).message ?? e) }); }
  });
  port = await listen(server, opts.port ?? 4317);
  const close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  return { server, port, url: `http://127.0.0.1:${port}/?t=${token}`, token, close };
}

function fail(msg: string): never { throw new Error(msg); }
