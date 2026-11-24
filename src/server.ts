import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { DB } from './db.js';
import { setSetting } from './db.js';
import { countUncommitted } from './git.js';
import { emit, eventsAfter, subscribe, type EventRow } from './events.js';
import { planCancel } from './cancel.js';
import { resolveLocalOrigin } from './forges.js';
import { approvePlan, PlanInFlightError } from './plan.js';
import type { PlanningService } from './planning.js';
import { addProject, configureProject, MODEL_DEFAULT_ERROR } from './projects.js';
import { isModelDefault } from './types.js';
import type { RoadmapService } from './roadmap.js';
import { EMPTY_SETUP, projectSetup } from './setup.js';
import { clearOverride, overrideFinding, PushBlockedError, pushNow, pushToGithub, setGithubRemote, shipStatus } from './ship.js';
import { folderStatus, syncCheckout } from './sync.js';
import type { Runner } from './runner.js';
import type { UpdateService } from './update.js';

const page = fileURLToPath(new URL('../../public/index.html', import.meta.url));

export interface ServerOpts {
  port?: number;            // preferred port; the next free one is used if it is taken
  token?: string;           // per-launch secret; random if omitted
  originsDir?: string;      // where `add project` may create local forge origins
  roadmap?: RoadmapService;
  update?: UpdateService;   // self-update for Vizor Local; routes answer 404 without it
}

/** The update source is fixed at launch. Any body that tries to name one is refused outright. */
const mentionsUpstream = (body: unknown) =>
  typeof body === 'object' && body !== null && Object.keys(body).some((k) => /upstream/i.test(k));
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
            let row: any;
            try { row = { ...p, origin: resolveLocalOrigin(p), origin_error: null }; }
            catch (e) { row = { ...p, origin: null, origin_error: String((e as Error).message ?? e) }; }
            let setup = EMPTY_SETUP;
            try { setup = projectSetup(db, row); } catch { /* setup is advisory; never fail /api/state */ }
            let uncommitted_files = 0;
            try { uncommitted_files = countUncommitted(p.repo_path); } catch { /* folder missing: nothing to count */ }
            return { ...row, setup, uncommitted_files };
          }),
          // Every plan version, superseded and task-less ones included. plans has no created_at column, so it
          // comes from the plan_drafted event (null if the event is gone); phase_id is the phase that owns the plan.
          plans: db.prepare(
            `SELECT pl.id, pl.project_id, pl.version, pl.status, pl.body, pl.approved_at,
               (SELECT MIN(e.ts) FROM events e WHERE e.type='plan_drafted' AND e.project_id=pl.project_id
                  AND json_extract(e.data,'$.planId')=pl.id) AS created_at,
               (SELECT ph.id FROM phases ph WHERE ph.plan_id=pl.id ORDER BY ph.id LIMIT 1) AS phase_id,
               (SELECT COUNT(*) FROM tasks t WHERE t.plan_id=pl.id) AS task_count
             FROM plans pl ORDER BY pl.id`).all(),
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
        const ship = await shipStatus(p, { fetch: url.searchParams.get('fetch') !== '0', db });
        let folder: (ReturnType<typeof folderStatus> & { dirtyFiles: number }) | null = null;
        try { const f = folderStatus(p); folder = { ...f, dirtyFiles: f.dirty ? countUncommitted(p.repo_path) : 0 }; } catch { /* folder missing */ }
        return json(res, 200, { ...ship, folder });
      }
      if (req.method === 'GET' && url.pathname === '/api/update/status') {
        if (!opts.update) return json(res, 404, { error: 'not found' });
        return json(res, 200, await opts.update.status());
      }
      if (req.method === 'POST' && parts[0] === 'api') {
        const body = await readBody(req);
        const [, a, id, action] = parts;
        if ((a === 'settings' || a === 'update') && mentionsUpstream(body)) {
          return json(res, 400, { error: 'The update source can only be set when Vizor Local starts (--update-upstream or VIZOR_UPDATE_UPSTREAM).' });
        }
        if (a === 'update') {
          const u = opts.update;
          if (!u || action !== undefined) return json(res, 404, { error: 'not found' });
          if (id === 'check') {
            if (!u.checkEnabled()) return json(res, 409, { error: 'The update check is turned off.', reason: 'check-disabled', status: await u.status() });
            await u.check();
            return json(res, 200, await u.status());
          }
          if (id === 'apply' || id === 'revert') {
            // Nothing from the body is used: the target SHA comes from the server's own fetch or the updater's record.
            const r = await u.apply(id === 'apply' ? 'update' : 'revert');
            return r.ok ? json(res, 202, r) : json(res, r.status, { error: r.message, reason: r.reason });
          }
          if (id === 'dismiss-error') { u.dismissError(); return json(res, 200, { ok: true }); }
          if (id === 'settings') {
            if (typeof body.checkEnabled !== 'boolean') return json(res, 400, { error: 'checkEnabled must be true or false' });
            u.setCheckEnabled(body.checkEnabled);
            return json(res, 200, await u.status());
          }
          return json(res, 404, { error: 'not found' });
        }
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
          // autoApprove is strict: only a JSON boolean is accepted ("true", 1 etc. are rejected).
          if (body.autoApprove !== undefined && typeof body.autoApprove !== 'boolean') return json(res, 400, { error: 'autoApprove must be true or false' });
          for (const field of ['planner_model', 'worker_model'] as const) {
            if (body[field] !== undefined && !isModelDefault(body[field])) return json(res, 400, { error: MODEL_DEFAULT_ERROR(field) });
          }
          return json(res, 200, configureProject(db, id, { ciCommand: body.ciCommand !== undefined ? String(body.ciCommand) : undefined,
            maxWorkers: body.maxWorkers !== undefined ? Number(body.maxWorkers) : undefined, autoPush: body.autoPush !== undefined ? !!body.autoPush : undefined,
            autoApprove: body.autoApprove, plannerModel: body.planner_model, workerModel: body.worker_model }));
        }
        if (a === 'projects' && action === 'auto-approve-resume') { (opts.roadmap ?? fail('roadmap not enabled')).resumeAutoApprove(id); return json(res, 200, { ok: true }); }
        if (a === 'phases' && action === 'approve-mode') return json(res, 200, (opts.roadmap ?? fail('roadmap not enabled')).setApproveMode(Number(id), body.mode));
        if (a === 'projects' && action === 'push-now') {
          const p = runner.project(id) ?? fail('unknown project');
          const r = await pushNow(db, p);
          db.prepare('UPDATE projects SET auto_push_error=NULL WHERE id=?').run(p.id);
          return json(res, 200, r);
        }
        if (a === 'projects' && action === 'push') return json(res, 200, await pushToGithub(db, runner.project(id) ?? fail('unknown project'), String(body.sha ?? '')));
        if (a === 'projects' && action === 'push-override') return json(res, 200, await overrideFinding(db, runner.project(id) ?? fail('unknown project'), String(body.findingId ?? '')));
        if (a === 'projects' && action === 'push-override-clear') return json(res, 200, clearOverride(db, runner.project(id) ?? fail('unknown project'), String(body.findingId ?? '')));
        if (a === 'projects' && action === 'github') { await setGithubRemote(db, runner.project(id) ?? fail('unknown project'), String(body.url ?? '')); return json(res, 200, { ok: true }); }
        if (a === 'projects' && action === 'sync') return json(res, 200, syncCheckout(db, runner.project(id) ?? fail('unknown project')));
        if (a === 'projects' && action === 'roadmap') return json(res, 200, (opts.roadmap ?? fail('roadmap not enabled')).add(id, String(body.text ?? '')));
        if (a === 'projects' && action === 'roadmap-pause') { (opts.roadmap ?? fail('roadmap not enabled')).pause(id, !!body.paused); return json(res, 200, { ok: true }); }
        if (a === 'phases' && action === 'retry') { (opts.roadmap ?? fail('roadmap not enabled')).retry(Number(id)); return json(res, 200, { ok: true }); }
        if (a === 'phases' && action === 'mark-done') { (opts.roadmap ?? fail('roadmap not enabled')).markDone(Number(id)); return json(res, 200, { ok: true }); }
        if (a === 'phases' && action === 'remove') { (opts.roadmap ?? fail('roadmap not enabled')).remove(Number(id)); return json(res, 200, { ok: true }); }
        if (a === 'projects' && action === 'phases') return json(res, 200, (opts.roadmap ?? fail('roadmap not enabled')).insert(id, Number(body.position), String(body.title ?? ''), String(body.prompt ?? '')));
        if (a === 'phases' && action === 'move') return json(res, 200, (opts.roadmap ?? fail('roadmap not enabled')).move(Number(id), Number(body.position)));
        if (a === 'phases' && action === 'edit') return json(res, 200, (opts.roadmap ?? fail('roadmap not enabled')).edit(Number(id), { title: body.title === undefined ? undefined : String(body.title), prompt: body.prompt === undefined ? undefined : String(body.prompt) }));
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
        if (a === 'tasks' && action === 'cancel') {
          // Owner-only route (token cookie + Origin + JSON content-type checks above); deliberately POST-only.
          // dryRun is a read-only planCancel preview: no DB writes, no events.
          const reroute = body?.reroute !== false;
          try {
            const plan = planCancel(db, id);
            if (body?.dryRun === true) {
              return json(res, 200, { dryRun: true, task: { id: plan.task.id, key: plan.task.key, status: plan.task.status },
                cancellable: plan.cancellable, ...(plan.reason ? { reason: plan.reason } : {}), reroute, reroutes: plan.reroutes });
            }
            runner.cancelTask(id, { reroute });
            return json(res, 200, { ok: true, dryRun: false, reroutes: reroute ? plan.reroutes : [] });
          } catch (e) {
            const msg = String((e as Error).message ?? e);
            return json(res, /not found/.test(msg) ? 404 : /^cannot cancel/.test(msg) ? 409 : 400, { error: msg });
          }
        }
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      // push and push-now: the guard refused; the UI shows each finding with its override button.
      if (e instanceof PushBlockedError) return json(res, 409, { error: e.message, findings: e.findings });
      json(res, 400, { error: String((e as Error).message ?? e) });
    }
  });
  port = await listen(server, opts.port ?? 4317);
  const close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  return { server, port, url: `http://127.0.0.1:${port}/?t=${token}`, token, close };
}

function fail(msg: string): never { throw new Error(msg); }
