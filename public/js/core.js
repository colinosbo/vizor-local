// <script>
// core.js: DOM helpers (h, put), shared UI primitives (icon, lamp, emptyState, infoBtn, copyBtn, toast), the state
// store and its selectors, post(), the router (go, readHash), desktop notifications, screen-reader announcements,
// refresh() and the server event stream. It imports nothing. See docs/ui-modules.md.
// The first and last lines are markers the static UI tests read modules by; keep them.

// All untrusted text (worker output, CI logs, plans, PR content) is rendered with textContent only.
const $ = (id) => document.getElementById(id);
const h = (tag, props, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
};
// replaceChildren(null) would insert the text "null": drop empty slots first.
const put = (node, ...kids) => node.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
// Like put, but a child whose markup is unchanged stays in place: no layout shift, no lost focus, no replayed animation.
// Only for children whose handlers read live state (ids, not captured snapshots). A child may carry _sig, its markup
// before any entrance class, so a card that is still animating in compares equal to its refreshed twin.
function keepSame(node, kids) {
  const sig = (el) => el._sig ?? el.outerHTML;
  kids.forEach((kid, i) => {
    const old = node.children[i];
    if (!old) node.append(kid);
    else if (sig(old) !== sig(kid)) old.replaceWith(kid);
  });
  while (node.children.length > kids.length) node.lastElementChild.remove();
}
// Empty state: what the view shows, why it is empty now, and at most one next action ({ label, onclick, icon }).
function emptyState(what, why, action) {
  return h('div', { class: 'empty' }, what ? h('h2', { text: what }) : null, h('p', { text: why }),
    action ? h('button', { class: 'btn', type: 'button', onclick: action.onclick }, action.icon ? icon(action.icon) : null, action.label) : null);
}
const NS = 'http://www.w3.org/2000/svg';
const ICONS = { // lucide paths (constant strings)
  home: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  plan: '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
  overview: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  board: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M8 7v7"/><path d="M12 7v4"/><path d="M16 7v9"/>',
  run: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  ship: '<path d="m18 9-6-6-6 6"/><path d="M12 3v14"/><path d="M5 21h14"/>',
  projects: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  retry: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  chev: '<path d="m9 18 6-6-6-6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  up: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  down: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  edit: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
};
const icon = (name) => { const s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'i'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = ICONS[name]; return s; };

const VIEWS = [['overview', 'Overview'], ['plan', 'Plan'], ['board', 'Board'], ['run', 'Run'], ['ship', 'Ship'], ['projects', 'Projects']];
const STATUS = {
  pending: ['Waiting', 'wait'], ready: ['Ready', 'wait'], running: ['Running', 'live'], waiting_ci: ['Checks running', 'wait'],
  merging: ['Verifying merge', 'wait'], merged: ['Merged', 'ok'], blocked: ['Held', 'bad'], cancelled: ['Cancelled', ''],
};
let state = { projects: [], plans: [], tasks: [], attempts: [], messages: [], settings: [], planning: [] };
const events = [];
const activity = new Map(); // task_id -> last worker_output line (kind text or tool)
let current = null, view = 'home', selTask = null, selNode = null;
// Ship's cached /ship response and its pending push confirm. They live here because the router, the palette
// and the server event stream reset or read them, not only the Ship view.
const shipCache = {}; let shipConfirm = null;
// Slots other modules fill at load time, so core.js imports nothing: nav.js sets render and key, plan.js sets
// lanes (redraws the plan graph when a disclosure holding it opens), and a view pushes into events to see every
// server event after the state refresh is scheduled.
const hooks = { render: () => {}, key: () => {}, lanes: () => {}, events: [] };
function render() { hooks.render(); }
// The page-wide keydown handler is registered here, before any view adds its own, so it still runs first.
document.addEventListener('keydown', (e) => hooks.key(e));


// ---------- helpers ----------
const proj = () => state.projects.find((p) => p.id === current);
const tasksOf = (pid) => state.tasks.filter((t) => t.project_id === pid);
const plansOf = (pid) => state.plans.filter((p) => p.project_id === pid).sort((a, b) => b.version - a.version);
const latestPlan = (pid) => plansOf(pid)[0];
const needsApproval = (pid) => latestPlan(pid)?.status === 'draft';
const planningFor = (pid) => state.planning.some((r) => r.projectId === pid);
const isOpenTask = (t) => t.status !== 'merged' && t.status !== 'cancelled';
const projectStatus = (p) => {
  const n = running(p.id);
  if (n) return [String(n) + ' running', 'live'];
  if (planningFor(p.id)) return ['Planning', 'live'];
  if (tasksOf(p.id).some((t) => t.status === 'blocked')) return ['Needs attention', 'bad'];
  if (needsApproval(p.id)) return ['Review plan', 'wait'];
  if (p.paused) return ['Paused', 'wait'];
  return ['', ''];
};
const disclosures = new Set();
function disclosure(key, label, count, body, className) {
  return h('details', { class: className, open: disclosures.has(key),
    ontoggle: (e) => {
      const details = e.currentTarget;
      if (!details.isConnected) return;
      if (details.open) {
        disclosures.add(key);
        if (details.querySelector('#lanes')) requestAnimationFrame(hooks.lanes);
      } else disclosures.delete(key);
    } },
    h('summary', { class: 'disclosure' }, icon('chev'), h('span', { class: 'grow', text: label }),
      count == null ? null : h('span', { class: 'mono muted', text: String(count) })),
    body);
}
const running = (pid) => tasksOf(pid).filter((t) => t.status === 'running').length;
const short = (s) => (s ? String(s).slice(0, 8) : '');
// A lamp is never the only sign of a status. Pass `label` where no status word sits beside it: the word is then
// carried as visually hidden text (and a hover title) inside the lamp.
const lamp = (kind, label) => h('span', { class: 'lamp ' + (kind || ''), title: label || null }, label ? h('span', { class: 'vh', text: label }) : null);
// Plain-language copy for the technical states: what is happening, why, and what the owner can do.
const EXPLAIN = {
  checks: 'Local is waiting for the automated tests on this change to finish. This is normal and usually takes a few minutes. You do not need to do anything unless it turns into Held.',
  verifying: 'The tests passed and Local is making sure the change still fits the latest main branch before it merges. It happens on its own and takes a moment. You do not need to do anything.',
  held: 'This task is paused and will not merge on its own. It usually means a newer plan replaced it or something went wrong. You can merge it anyway or cancel it.',
  superseded: 'A newer version of the plan replaced this one. Work already running under it is held for you to decide on. You can merge it anyway or cancel it.',
};
const INFO_LABEL = { checks: 'Checks', verifying: 'Verifying merge', held: 'Held', superseded: 'Superseded' };
const infoPop = h('div', { id: 'infoPop', role: 'note', hidden: true });
let infoOpen = null;
function closeInfo(refocus) {
  if (!infoOpen) return;
  const b = infoOpen; infoOpen = null;
  b.setAttribute('aria-expanded', 'false');
  infoPop.classList.remove('show'); infoPop.hidden = true;
  if (refocus) b.focus();
}
function placeInfo(b) {
  const r = b.getBoundingClientRect(), w = infoPop.offsetWidth, ph = infoPop.offsetHeight;
  const left = Math.max(8, Math.min(r.left, innerWidth - w - 8));
  const top = r.bottom + 8 + ph > innerHeight - 8 ? Math.max(8, r.top - ph - 8) : r.bottom + 8;
  infoPop.style.left = left + 'px'; infoPop.style.top = top + 'px';
}
function infoBtn(key) {
  const name = INFO_LABEL[key];
  const b = h('button', { class: 'info-btn', type: 'button', 'aria-label': `What does ${name} mean?`, 'aria-expanded': 'false', 'aria-controls': 'infoPop' }, icon('info'));
  b.addEventListener('click', (e) => {
    e.stopPropagation(); e.preventDefault();
    if (infoOpen === b) return closeInfo(false);
    closeInfo(false);
    infoPop.textContent = EXPLAIN[key];
    infoPop.hidden = false; infoOpen = b;
    b.setAttribute('aria-expanded', 'true');
    placeInfo(b);
    requestAnimationFrame(() => infoPop.classList.add('show'));
  });
  b.addEventListener('keydown', (e) => e.stopPropagation()); // keep Enter and Space from opening the card behind
  b.addEventListener('blur', () => { if (infoOpen === b) closeInfo(false); });
  return b;
}
document.body.append(infoPop);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && infoOpen) { e.preventDefault(); e.stopPropagation(); closeInfo(true); } }, true);
document.addEventListener('pointerdown', (e) => { if (infoOpen && !infoOpen.contains(e.target) && !infoPop.contains(e.target)) closeInfo(false); }, true);
addEventListener('resize', () => closeInfo(false));
const INFO_OF = { waiting_ci: 'checks', merging: 'verifying', blocked: 'held' };
const statusEl = (s) => { const [label, kind] = STATUS[s] || [s, '']; return h('span', { class: 'status' }, lamp(kind), label, INFO_OF[s] ? infoBtn(INFO_OF[s]) : null); };
const fmtClock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const sqlTime = (s) => new Date(String(s).replace(' ', 'T') + (String(s).endsWith('Z') ? '' : 'Z'));
const hhmm = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const hhmmss = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const planFor = (planId) => state.plans.find((p) => p.id === planId);

let toastTimer;
function toast(text, bad) {
  const t = $('toast'); t.textContent = text; t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = bad ? 'bad' : ''), bad ? 6000 : 3000);
}
// Quiet copy button: copies the full value (never the shortened display) and confirms with a toast.
const COPY_ICON = '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>';
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back below */ }
  const ta = h('textarea', { 'aria-hidden': 'true', tabindex: '-1', readonly: true, style: 'position:fixed; top:0; left:-9999px; opacity:0' });
  ta.value = text; document.body.append(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}
function copyBtn(text, label) {
  if (text == null || text === '') return null;
  const value = String(text);
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'i'); svg.setAttribute('aria-hidden', 'true'); svg.innerHTML = COPY_ICON;
  return h('button', { type: 'button', class: 'copy', title: 'Copy ' + label, 'aria-label': 'Copy ' + label,
    onclick: async (ev) => { ev.stopPropagation(); if (await copyText(value)) toast('Copied ' + label); else toast('Could not copy ' + label, true); } }, svg);
}
// onError(message) replaces the error toast when a caller shows the message itself.
async function post(path, body, onError) {
  const fail = (m, j) => { if (onError) onError(m, j); else toast(m, true); return null; };
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return fail(j.error || `Request failed (${r.status})`, j);
    return j;
  } catch { return fail('Local is not reachable'); }
}

// ---------- routing: #project/view/task ----------
let hashIsDefault = false; // a project hash with no view or task: restore the last view once state loads
function readHash() {
  const [p, v, t] = location.hash.slice(1).split('/').map((x) => decodeURIComponent(x || ''));
  if (!p || p === 'home') { view = 'home'; return; } // no hash opens Home
  current = p;
  if (VIEWS.some(([k]) => k === v)) view = v;
  else if (view === 'home') view = 'overview';
  if (t) selTask = t;
  hashIsDefault = !t && !VIEWS.some(([k]) => k === v);
}
function writeHash() {
  if (view === 'home') return history.replaceState(null, '', '#home');
  const parts = [current || '', view];
  if (view === 'run' && selTask) parts.push(selTask);
  history.replaceState(null, '', '#' + parts.map(encodeURIComponent).join('/'));
}
const lastViewKey = (pid) => 'vizor.lastView.' + pid;
function saveLastView(pid) {
  if (!pid || view === 'home') return;
  try { localStorage.setItem(lastViewKey(pid), JSON.stringify({ view, selTask })); } catch { /* storage unavailable */ }
}
// Returns the saved {view, selTask} only if it is still valid; a missing task falls back to the default view.
function restoreLastView(pid) {
  try {
    const v = JSON.parse(localStorage.getItem(lastViewKey(pid)));
    if (!v || !VIEWS.some(([k]) => k === v.view)) return null;
    if (v.selTask != null && !state?.tasks?.some((t) => t.id === v.selTask && t.project_id === pid)) return null;
    return { view: v.view, selTask: v.selTask ?? null };
  } catch { return null; }
}
function go(patch) {
  if ('current' in patch && patch.current !== current) {
    selNode = null; shipConfirm = null;
    // Opening a project by default (no task, overview or no view) returns to where it was left; explicit targets win.
    if (patch.selTask == null && (!('view' in patch) || patch.view === 'overview')) {
      const last = restoreLastView(patch.current);
      if (last) patch = { ...patch, ...last };
    }
  }
  if ('current' in patch) current = patch.current;
  if ('view' in patch && patch.view === 'ship' && view !== 'ship' && current) delete shipCache[current];
  if ('view' in patch) view = patch.view;
  if ('selTask' in patch) selTask = patch.selTask;
  saveLastView(current); writeHash(); render();
  if ('current' in patch && view === 'plan') $('thread').scrollTop = $('thread').scrollHeight;
}
// Other modules cannot assign imported bindings; they change router state through these (go() also renders).
function setRoute(patch) {
  if ('current' in patch) current = patch.current;
  if ('view' in patch) view = patch.view;
  if ('selTask' in patch) selTask = patch.selTask;
  if ('selNode' in patch) selNode = patch.selNode;
}
function setShipConfirm(pid) { shipConfirm = pid; }

// ---------- desktop notifications: opt-in per project, stored in this browser ----------
const canNotify = 'Notification' in window;
const notifyKey = (pid) => 'vizor.notify.' + pid;
// Off unless the owner ticked the box for this project and the browser still grants permission.
function notifyOn(pid) {
  if (!canNotify || !pid || Notification.permission !== 'granted') return false;
  try { return localStorage.getItem(notifyKey(pid)) === '1'; } catch { return false; }
}
function setNotify(pid, on) {
  try { if (on) localStorage.setItem(notifyKey(pid), '1'); else localStorage.removeItem(notifyKey(pid)); } catch { /* storage unavailable */ }
}
// The four facts worth interrupting the owner for, keyed by entity id plus status. Routine progress is never listed.
function notifyFacts(st) {
  const out = [];
  const name = (pid) => st.projects.find((p) => p.id === pid)?.name ?? pid;
  for (const p of st.projects) {
    const plans = st.plans.filter((pl) => pl.project_id === p.id);
    for (const pl of plans) if (pl.status === 'draft')
      out.push({ key: `plan:${pl.id}:draft`, pid: p.id, view: 'plan', title: 'Plan ready for review', body: `${p.name}: plan v${pl.version} is waiting for approval` });
    const active = plans.find((pl) => pl.status === 'approved');
    const planTasks = active ? st.tasks.filter((t) => t.plan_id === active.id && t.status !== 'cancelled') : [];
    if (planTasks.length && planTasks.every((t) => t.status === 'merged'))
      out.push({ key: `plan:${active.id}:merged`, pid: p.id, view: 'overview', title: 'Plan merged', body: `${p.name}: all ${planTasks.length} task${planTasks.length === 1 ? '' : 's'} in plan v${active.version} merged` });
    if (p.auto_push_error)
      out.push({ key: `push:${p.id}:${p.auto_pushed_sha ?? ''}:failed`, pid: p.id, view: 'overview', title: 'Push to GitHub failed', body: `${p.name}: ${p.auto_push_error}` });
  }
  for (const t of st.tasks) if (t.status === 'blocked')
    out.push({ key: `task:${t.id}:blocked`, pid: t.project_id, view: 'run', selTask: t.id, title: 'Task held', body: `${name(t.project_id)}: ${t.title}` });
  return out;
}
let notifyPrev = null; // fact keys from the previous refresh; null until the first load seeds it
const notified = new Set(); // each entity+status notifies at most once per session
function notifyTransitions(st) {
  const facts = notifyFacts(st);
  const prev = notifyPrev;
  notifyPrev = new Set(facts.map((f) => f.key));
  if (!prev || !canNotify) return; // first load only seeds the snapshot
  for (const f of facts) {
    if (prev.has(f.key) || notified.has(f.key) || !notifyOn(f.pid)) continue;
    notified.add(f.key);
    try {
      const n = new Notification(f.title, { body: f.body, tag: f.key });
      n.onclick = () => {
        window.focus(); n.close();
        go({ current: f.pid }); // switch project first so the saved last view cannot override the target
        go(f.selTask ? { view: f.view, selTask: f.selTask } : { view: f.view });
      };
    } catch { /* some browsers only allow notifications from a service worker */ }
  }
}

// ---------- screen-reader announcements: status transitions only ----------
// One polite live region (#announcer). Text only, never markup.
function announce(msg) { $('announcer').textContent = msg; }
// Task and plan statuses by id from the previous /api/state. null until the first load, which announces nothing.
let announcePrev = null;
function announceTransitions(st) {
  const prev = announcePrev;
  announcePrev = { tasks: new Map(st.tasks.map((t) => [t.id, t.status])), plans: new Map(st.plans.map((p) => [p.id, p.status])) };
  if (!prev) return;
  // Only another project's events name their project; the open one is implied.
  const where = (pid) => (pid === current ? '' : ` in ${st.projects.find((p) => p.id === pid)?.name ?? 'another project'}`);
  const held = [], merged = [], ready = [];
  for (const t of st.tasks) {
    if (prev.tasks.get(t.id) === t.status) continue;
    if (t.status === 'blocked') held.push(`Task held: ${t.title}${where(t.project_id)}`);
    else if (t.status === 'merged') merged.push(`Task merged: ${t.title}${where(t.project_id)}`);
  }
  for (const p of st.plans) if (p.status === 'draft' && prev.plans.get(p.id) !== 'draft') ready.push(`Plan v${p.version} ready for review${where(p.project_id)}`);
  // A burst (a whole wave merging) is read as one count instead of a list.
  const group = (lines, many) => (lines.length > 2 ? [many(lines.length)] : lines);
  const msg = [...group(held, (n) => `${n} tasks held`), ...group(merged, (n) => `${n} tasks merged`), ...ready].join('. ');
  if (msg) announce(msg);
}

// ---------- data ----------
async function refresh() {
  const r = await fetch('/api/state').catch(() => null);
  if (!r) return;
  if (r.status === 401) {
    put(document.body, h('div', { class: 'empty', style: 'margin:48px' }, h('h2', { text: 'Session key missing' }),
      h('p', { text: 'Open the full link printed in the terminal by serve. It contains this launch\u2019s key' })));
    return;
  }
  state = await r.json();
  notifyTransitions(state);
  announceTransitions(state);
  if (!state.projects.some((p) => p.id === current)) current = state.projects[0]?.id ?? null;
  if (hashIsDefault) {
    hashIsDefault = false;
    const last = current && restoreLastView(current);
    if (last) { view = last.view; selTask = last.selTask; writeHash(); }
  }
  render();
}
let pend; const soon = () => { clearTimeout(pend); pend = setTimeout(refresh, 150); };

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// ----- Status strip: every number comes from statusFromState(state), i.e. the /api/state payload -----
// Pure: no DOM, no clock reads except through `now`. Unpushed counts merged tasks after the last auto-pushed
// merge (/api/state has no push counter), so a manual push may leave it high until the next auto-push.
function statusFromState(s, pid, now = Date.now()) {
  const p = s.projects.find((x) => x.id === pid);
  if (!p) return null;
  const ts = s.tasks.filter((t) => t.project_id === pid && t.status !== 'cancelled');
  const merged = ts.filter((t) => t.status === 'merged');
  const plans = s.plans.filter((x) => x.project_id === pid).sort((a, b) => b.version - a.version);
  const open = ts.filter((t) => t.status !== 'merged');
  const held = ts.filter((t) => t.status === 'blocked').length;
  const planWaits = plans[0]?.status === 'draft';
  const pushErr = !!p.auto_push_error;
  let eta = null;
  const done = merged.map((t) => {
    const starts = s.attempts.filter((a) => a.task_id === t.id).map((a) => Date.parse(String(a.started_at).replace(' ', 'T') + (String(a.started_at).endsWith('Z') ? '' : 'Z')));
    return Date.parse(String(t.updated_at).replace(' ', 'T') + (String(t.updated_at).endsWith('Z') ? '' : 'Z')) - Math.min(...starts);
  }).filter((x) => x >= 30000 && x <= 6 * 3600000).sort((a, b) => a - b);
  if (open.length && done.length >= 3) {
    const rounds = Math.ceil(open.length / Math.max(1, p.max_workers));
    eta = now + rounds * done[Math.floor(done.length / 2)];
  }
  const sorted = [...merged].sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)));
  const at = p.auto_pushed_sha ? sorted.findIndex((t) => t.merge_sha === p.auto_pushed_sha) : -1;
  const running = ts.filter((t) => t.status === 'running').length;
  return {
    pct: !ts.length ? 0 : merged.length === ts.length ? 100 : Math.floor((100 * merged.length) / ts.length),
    running, limit: p.max_workers, eta,
    needs: held + (planWaits ? 1 : 0) + (pushErr ? 1 : 0), held, planWaits, pushErr,
    unpushed: at < 0 ? merged.length : merged.length - at - 1,
  };
}
// Live figures: write only when the text differs, so a 30s refresh of identical data touches no node.
const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
// The running lamp keeps its slot when idle (.idle = visibility:hidden), so figures beside it never shift.
const runLamp = (el, on) => { el.classList.toggle('live', on); el.classList.toggle('idle', !on); };
// Read from the token so the count-up and CSS view entrances share one duration.
const tView = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--t-view')) || 320;
function countTo(el, to) {
  const from = Number(el.dataset.v ?? to);
  el.dataset.v = String(to);
  const fmt = (n) => String(Math.round(n));
  if (from === to) { if (!el._raf) setText(el, fmt(to)); return; } // unchanged: leave a running count alone
  cancelAnimationFrame(el._raf); el._raf = 0;
  if (reducedMotion.matches) { setText(el, fmt(to)); return; }
  const t0 = performance.now(), dur = tView();
  // cubic-bezier(0.22, 1, 0.36, 1), solved for x by bisection
  const ease = (x) => { let lo = 0, hi = 1; for (let i = 0; i < 20; i++) { const m = (lo + hi) / 2, bx = 3 * (1 - m) * (1 - m) * m * 0.22 + 3 * (1 - m) * m * m * 0.36 + m * m * m; if (bx < x) lo = m; else hi = m; } const m = (lo + hi) / 2; return 3 * (1 - m) * (1 - m) * m + m * m * m; };
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur);
    el.textContent = fmt(from + (to - from) * ease(k));
    el._raf = k < 1 ? requestAnimationFrame(step) : 0;
  };
  el._raf = requestAnimationFrame(step);
}

// ----- Task stats, time formats and shared actions used by several views -----
const BUCKETS = [['merged', 'Merged', 'ok'], ['running', 'Running', 'live'], ['checks', 'Checks', 'wait'], ['ready', 'Ready', 'wait'], ['waiting', 'Waiting', 'idle'], ['held', 'Held', 'bad']];
const BUCKET_OF = { merged: 'merged', running: 'running', waiting_ci: 'checks', merging: 'checks', ready: 'ready', pending: 'waiting', blocked: 'held' };
function tally(ts) {
  const c = { merged: 0, running: 0, checks: 0, ready: 0, waiting: 0, held: 0 };
  for (const t of ts) if (BUCKET_OF[t.status]) c[BUCKET_OF[t.status]]++;
  return c;
}
function projectStats(p) {
  const ts = tasksOf(p.id).filter((t) => t.status !== 'cancelled'), c = tally(ts);
  return { c, total: ts.length, pct: !ts.length ? 0 : c.merged === ts.length ? 100 : Math.floor((100 * c.merged) / ts.length) };
}
function segBar(c) {
  const parts = BUCKETS.filter(([k]) => c[k]);
  return h('div', { class: 'bar', role: 'img', 'aria-label': parts.map(([k, l]) => `${c[k]} ${l.toLowerCase()}`).join(', ') || 'No tasks' },
    parts.length ? parts.map(([k, , kind]) => h('i', { class: kind, style: `flex:${c[k]} 1 0` })) : h('i', { class: 'idle', style: 'flex:1' }));
}
const clockAt = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const clockDay = (ms) => (new Date(ms).toDateString() === new Date().toDateString() ? '' : new Date(ms).toLocaleDateString([], { weekday: 'short' }) + ' ') + clockAt(ms);
const fmtDur = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`; };
const ago = (d) => { const m = Math.floor((Date.now() - d.getTime()) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} d ago`; };
const usageWaiting = (t) => t.status === 'blocked' && Number(t.usage_retry_at) > Date.now();
function holdText(t) {
  if (t.usage_retry_at) {
    const at = clockAt(Number(t.usage_retry_at));
    return usageWaiting(t) ? `Claude usage limit. Retries automatically at ${at}` : `Claude usage limit reset at ${at}. Retry is due`;
  }
  return t.hold_reason || '';
}
async function retryMany(ts) {
  let ok = 0;
  for (const t of ts) if (await post(`/api/tasks/${encodeURIComponent(t.id)}/retry`)) ok++;
  if (ok) toast(`Retrying ${ok} task${ok === 1 ? '' : 's'}`);
  refresh();
}
async function retry(t) { if (await post(`/api/tasks/${encodeURIComponent(t.id)}/retry`)) { toast(`Retrying ${t.key}`); refresh(); } }
async function cancelRun(a) { if (await post(`/api/attempts/${encodeURIComponent(a.id)}/cancel`)) toast('Cancel sent'); }
async function togglePause() {
  const p = proj();
  if (p && await post(`/api/projects/${p.id}/pause`, { paused: !p.paused })) { toast(p.paused ? 'Dispatch resumed' : 'Dispatch paused. Running work continues'); refresh(); }
}

// EventSource resends Last-Event-ID on reconnect; the server replays strictly after it.
const es = new EventSource('/api/events');
es.onopen = () => { $('conn').className = 'conn on'; $('connText').textContent = 'Live'; };
es.onerror = () => { $('conn').className = 'conn'; $('connText').textContent = 'Reconnecting'; };
es.onmessage = (m) => {
  const e = JSON.parse(m.data); try { e.d = JSON.parse(e.data); } catch { e.d = {}; } events.push(e);
  if (e.type === 'worker_output' && e.task_id && (e.d.kind === 'text' || e.d.kind === 'tool')) {
    const line = String(e.d.text ?? '').replace(/\s+/g, ' ').trim(); // the run log's text for worker_output
    if (line) {
      activity.set(e.task_id, line);
      for (const n of document.querySelectorAll('.tcard .act[data-act]')) if (n.dataset.act === e.task_id) { n.textContent = line; n.title = line; }
      // On the board the line is patched in place; other views still refetch for the run log.
      if (view === 'board') return;
    }
  }
  soon();
  for (const fn of hooks.events) fn(e);
};

export {
  $, BUCKETS, INFO_OF, NS, STATUS, VIEWS, activity, ago, announce, canNotify, cancelRun, clockDay, copyBtn,
  countTo, current, disclosure, emptyState, events, fmtClock, fmtDur, go, h, hhmm, hhmmss, holdText, hooks, icon,
  infoBtn, isOpenTask, keepSame, lamp, latestPlan, needsApproval, notifyOn, planFor, planningFor, plansOf, post,
  proj, projectStats, projectStatus, put, readHash, reducedMotion, refresh, retry, retryMany, runLamp, running,
  segBar, selNode, selTask, setNotify, setRoute, setShipConfirm, setText, shipCache, shipConfirm, short, sqlTime,
  state, statusEl, statusFromState, tally, tasksOf, toast, togglePause, usageWaiting, view, writeHash
};
// </script>
