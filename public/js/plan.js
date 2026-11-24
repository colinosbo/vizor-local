// <script>
// plan.js: Plan view (#v-plan): the request thread, the plan canvas and dependency graph, the approve guard,
// roadmaps and their phase queue.
// The first and last lines are markers the static UI tests read modules by; keep them.
import {
  $, NS, STATUS, ago, disclosure, emptyState, events, fmtClock, go, h, hhmm, hooks, icon, infoBtn, isOpenTask,
  lamp, needsApproval, planFor, planningFor, plansOf, post, proj, put, refresh, selNode, setRoute, sqlTime,
  state, statusEl, tasksOf, toast, view
} from './core.js';

const selPlan = {}, dismissed = new Set();
const drafts = new Map();
let draftProjectId = null;
const showPlanHistory = (pid) => {
  const tasks = tasksOf(pid);
  return tasks.some((t) => t.status === 'merged') && !tasks.some(isOpenTask) &&
    !needsApproval(pid) && !planningFor(pid) &&
    !(state.phases || []).some((phase) => phase.project_id === pid && phase.status !== 'done');
};

// ----- Plan -----
function showProjectDrafts(project) {
  const projectId = project?.id ?? null;
  if (projectId === draftProjectId) return;
  if (draftProjectId) {
    drafts.set(draftProjectId, { chat: $('chatIn').value, roadmap: $('roadmapText').value });
  }
  draftProjectId = projectId;
  const draft = drafts.get(projectId);
  $('chatIn').value = draft?.chat ?? '';
  $('roadmapText').value = draft?.roadmap ?? '';
  $('roadmapEditor').hidden = true;
  $('chatIn').placeholder = project ? 'Describe a change for ' + project.name : '';
  $('chatIn').setAttribute('aria-label', project ? 'Request for ' + project.name : 'Request');
  rmTarget = null; $('roadmapTitle').textContent = 'Start a new roadmap'; $('roadmapSubmit').textContent = 'Start roadmap'; $('roadmapName').hidden = false;
  $('chatRoadmapHint').hidden = true;
}

function renderPlan() {
  const p = proj();
  const thread = $('thread'), atEnd = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40;
  const msgs = state.messages.filter((m) => m.project_id === p.id);
  put(thread, ...(msgs.length ? msgs.map((m) => h('div', { class: 'msg ' + m.role },
    h('div', { class: 'who' }, h('span', { text: m.role === 'user' ? 'You' : m.role === 'system' ? 'Local' : 'Planner' }), h('span', { class: 'mono', text: hhmm(sqlTime(m.created_at)) })),
    h('div', { class: 'body', text: m.text })))
    : [emptyState('No requests yet', 'You have not asked for a change in this project',
      { label: 'Write a request', onclick: () => $('chatIn').focus() })]));
  if (atEnd) thread.scrollTop = thread.scrollHeight;
  const req = state.planning.find((r) => r.projectId === p.id);
  $('send').disabled = !!req; $('chatIn').disabled = !!req;
  $('clearChat').disabled = !!req || !msgs.length;
  const content = req ? [planningPanel(req)] : planCanvas(p);
  const rmPrev = rmFocusKey();
  put($('canvas'), roadmapCard(p), showPlanHistory(p.id)
    ? disclosure('plan:' + p.id, 'Plan history', null, h('div', { class: 'past-plan' }, content), 'board-history')
    : content);
  rmRestoreFocus(rmPrev);
  // One primary per view: Approve while a draft awaits approval, otherwise Draft plan
  $('send').classList.toggle('primary', !$('canvas').querySelector('.approve .btn.primary'));
  if (!req) requestAnimationFrame(drawEdges);
}

function planningPanel(req) {
  const start = Date.parse(req.startedAt);
  const notes = events.filter((e) => e.type === 'plan_progress' && e.d.requestId === req.requestId).slice(-12);
  const steps = [{ t: start, text: 'Request sent to the planner' }, ...notes.map((e) => ({ t: Date.parse(e.ts), text: e.d.note }))];
  const trace = h('div', { class: 'card trace' }, steps.map((s, i) => {
    const now = i === steps.length - 1;
    return h('div', { class: 'step' + (now ? ' now' : '') }, lamp(now ? 'live' : ''), h('span', { class: 'mono', text: '+' + fmtClock(s.t - start) }), h('span', { class: 'ellipsis', text: s.text }));
  }));
  return h('div', { class: 'planning' },
    h('div', { class: 'status' }, lamp('live'), 'Drafting a plan'),
    h('div', { class: 'clock', id: 'clock', 'data-start': String(start), text: fmtClock(Date.now() - start) }),
    h('p', { class: 'req', text: req.text }),
    trace,
    h('p', { class: 'muted', style: 'font-size:13px', text: 'Usually 30 to 90 seconds. You can switch views; the plan appears here when it is ready' }));
}

function lastPlanEvent(pid) {
  if (!state.messages.some((message) => message.project_id === pid)) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.project_id === pid && e.type === 'chat_cleared') return null;
    if (e.project_id === pid && ['plan_requested', 'plan_ready', 'plan_declined', 'plan_failed'].includes(e.type)) return e;
  }
  return null;
}

function outcomePanel(e, pid) {
  const failed = e.type === 'plan_failed';
  const lastText = [...state.messages].reverse().find((m) => m.project_id === pid && m.role === 'user')?.text;
  return h('div', { class: 'card outcome' },
    h('div', { class: 'status' }, lamp(failed ? 'bad' : ''), failed ? 'Planning failed' : 'The planner did not propose a plan'),
    h('p', { class: failed ? 'mono t2' : 't2', text: failed ? e.d.error : (e.d.reply || 'No reason given') }),
    h('div', { class: 'row' },
      failed && lastText ? h('button', { class: 'btn', onclick: () => sendRequest(p.id, lastText) }, icon('retry'), 'Try again') : null,
      h('button', { class: 'btn ghost', onclick: () => { $('chatIn').value = lastText || ''; $('chatIn').focus(); } }, 'Edit request'),
      h('button', { class: 'btn ghost', onclick: () => { dismissed.add(e.seq); renderPlan(); } }, 'Dismiss')));
}

function levels(tasks) {
  const by = new Map(tasks.map((t) => [t.key, t])), memo = new Map();
  const lv = (k, seen) => {
    if (memo.has(k)) return memo.get(k);
    if (seen.has(k)) return 0;
    seen.add(k);
    const ds = (by.get(k)?.deps || []).filter((d) => by.has(d));
    const v = ds.length ? 1 + Math.max(...ds.map((d) => lv(d, new Set(seen)))) : 0;
    memo.set(k, v); return v;
  };
  for (const t of tasks) lv(t.key, new Set());
  return memo;
}

// Advisory shape of a plan: tasks per wave, longest dependency chain, files several tasks touch. Null when there is nothing to show.
function shapeLine(shape) {
  if (!Array.isArray(shape?.waves) || !shape.waves.length) return null;
  const hot = Array.isArray(shape.hotFiles) ? shape.hotFiles : [];
  const chain = Array.isArray(shape.chain) ? shape.chain : [];
  return h('div', { class: 'shape-line', 'data-plan-shape': '' },
    h('span', { class: 'mono', text: 'Waves ' + shape.waves.map((w) => w.length).join(' · ') }),
    h('span', { class: 'mono', text: `Longest chain ${shape.longestChain}` }),
    chain.length ? h('span', { class: 'chain-text', 'data-chain': '', text: 'Longest chain: ' + chain.join(' → ') }) : null,
    hot.map((f) => h('span', { class: 'mono hot-file', title: f.tasks.join(', '), text: `${f.glob} · ${f.tasks.length} ${f.tasks.length === 1 ? 'task' : 'tasks'}` })));
}

function planCanvas(p) {
  const out = [];
  const le = lastPlanEvent(p.id);
  if (le && (le.type === 'plan_failed' || le.type === 'plan_declined') && !dismissed.has(le.seq)) out.push(outcomePanel(le, p.id));
  const plans = plansOf(p.id);
  if (!plans.length) {
    out.push(emptyState('Plan', 'No plan has been drafted for this project yet',
      { label: 'Write a request', onclick: () => $('chatIn').focus() }));
    return out;
  }
  const plan = plans.find((x) => x.id === selPlan[p.id]) || plans[0];
  const body = JSON.parse(plan.body);
  const validation = planValidation(plan);
  const live = new Map(state.tasks.filter((t) => t.plan_id === plan.id).map((t) => [t.key, t]));
  const statusWord = { draft: 'Draft, waiting for approval', approved: 'Approved', superseded: 'Superseded' }[plan.status] || plan.status;
  const anyRunning = [...live.values()].some((t) => t.status === 'running');

  out.push(h('div', { class: 'canvas-head' },
    h('h1', { text: `Plan v${plan.version}` }), h('span', { class: 'plan-src', 'data-plan-source': '', text: planSource(plan) }),
    h('span', { class: 'status' }, lamp(anyRunning ? 'live' : plan.status === 'approved' ? 'ok' : ''), statusWord, plan.status === 'superseded' ? infoBtn('superseded') : null),
    h('span', { class: 'grow' }),
    plans.length > 1 ? h('div', { class: 'seg', role: 'group', 'aria-label': 'Plan version' }, plans.slice(0, 8).map((x) =>
      h('button', { 'aria-pressed': String(x.id === plan.id), onclick: () => { selPlan[p.id] = x.id; setRoute({ selNode: null }); renderPlan(); }, text: 'v' + x.version }))) : null));

  if (body.summary) out.push(h('p', { class: 'summary', text: body.summary }));

  const shape = shapeLine(plan.shape);
  if (shape) out.push(shape);

  if (validation.errors.length || validation.warnings.length) out.push(h('div', { class: 'notes' },
    validation.errors.map((x) => h('p', { class: 'err', text: x })), validation.warnings.map((x) => h('p', { class: 'warn', text: x }))));

  // The moment: dependency graph, live once the plan runs.
  if (body.tasks.length) {
    const lv = levels(body.tasks);
    const onChain = new Set(Array.isArray(plan.shape?.chain) ? plan.shape.chain : []); // insertion order = chain order
    const waves = [];
    for (const t of body.tasks) (waves[lv.get(t.key)] ||= []).push(t);
    const lanes = h('div', { class: 'lanes', id: 'lanes', 'data-chain': [...onChain].join(' ') }, waves.filter(Boolean).map((ts, i) => h('div', { class: 'lane' },
      h('div', { class: 'lane-label', text: i === 0 ? 'Starts first' : `After wave ${i}` }),
      ts.map((t) => {
        const lt = live.get(t.key);
        const kind = lt ? (STATUS[lt.status] || [])[1] : '';
        return h('button', { class: 'node' + (onChain.has(t.key) ? ' on-chain' : ''), 'data-key': t.key, 'data-deps': t.deps.join(' '), 'data-status': lt?.status || '', 'aria-pressed': String(selNode === t.key),
          onclick: () => { setRoute({ selNode: selNode === t.key ? null : t.key }); renderPlan(); } },
          h('div', { class: 'top' }, lamp(kind), h('span', { class: 'mono ellipsis grow', text: t.key }), lt ? h('span', { class: 'mono', text: STATUS[lt.status]?.[0] || lt.status }) : null),
          h('div', { class: 'ttl', text: t.title }),
          h('div', { class: 'scope mono ellipsis', text: t.writeScope[0] + (t.writeScope.length > 1 ? `  +${t.writeScope.length - 1}` : '') }));
      }))));
    out.push(h('div', { class: 'graph' }, lanes));
  }

  const st = body.tasks.find((t) => t.key === selNode);
  if (st) {
    const lt = live.get(st.key);
    out.push(h('dl', { class: 'card detail' },
      h('dt', { text: 'Task' }), h('dd', {}, h('span', { text: st.title + '  ' }), h('span', { class: 'mono muted', text: st.key })),
      lt ? [h('dt', { text: 'Status' }), h('dd', { style: 'display:flex; gap:12px; align-items:center; flex-wrap:wrap' }, statusEl(lt.status),
        lt.hold_reason && lt.status !== 'merged' ? h('span', { class: 't2', text: lt.hold_reason }) : null,
        h('button', { class: 'btn ghost', onclick: () => go({ view: 'run', selTask: lt.id }) }, icon('run'), 'Open run'))] : null,
      h('dt', { text: 'Instructions' }), h('dd', { text: st.prompt }),
      h('dt', { text: 'Done when' }), h('dd', { text: st.acceptance }),
      h('dt', { text: 'Model' }), h('dd', {}, h('span', { class: 'mono', text: st.model || 'sonnet' }), st.modelWhy ? h('span', { class: 't2', text: '  ' + st.modelWhy }) : null),
      h('dt', { text: 'May change' }), h('dd', { class: 'mono', text: st.writeScope.join('\n') }),
      h('dt', { text: 'Waits for' }), h('dd', { class: st.deps.length ? 'mono' : 'muted', text: st.deps.length ? st.deps.join(', ') : 'Nothing' })));
  }

  if (plan.status === 'draft') {
    const prev = plans.find((x) => x.status === 'approved' && (x.lineage || '') === (plan.lineage || ''));
    const guard = approveGuard?.planId === plan.id ? approveGuard : null;
    if (guard) { out.push(approveGuardPanel(plan, guard.tasks)); return out; }
    out.push(h('div', { class: 'approve' },
      h('button', { class: 'btn primary', disabled: validation.errors.length > 0, onclick: () => approvePlan(plan) }, `Approve plan v${plan.version}`),
      plan.lineage ? null : h('button', { class: 'btn ghost', type: 'button', 'data-plan-discard': '', onclick: async () => { if (await post(`/api/plans/${plan.id}/discard`)) { toast(`Plan v${plan.version} discarded`); refresh(); } } }, 'Discard draft'),
      h('p', { text: validation.errors.length ? 'Fix the errors above with a new request first'
        : prev ? `Starts work now. From plan v${prev.version}, tasks not started yet are cancelled and running ones are held for you` : 'Starts work now, within the worker limit. Other running plans and roadmaps keep going' })));
  } else if (plan.status === 'approved') {
    out.push(h('div', { class: 'approve' }, h('button', { class: 'btn', onclick: () => go({ view: 'board' }) }, icon('board'), 'Open board')));
  }
  return out;
}

// ----- Approve guard: same in-flight rule as src/plan.ts; nothing is posted until the owner confirms -----
let approveGuard = null; // { planId, tasks }
const inFlightOf = (planId) => state.tasks.filter((t) => t.plan_id === planId
  && (['running', 'waiting_ci', 'merging'].includes(t.status) || (t.pr_number != null && !['merged', 'cancelled'].includes(t.status))))
  .map((t) => ({ id: t.id, key: t.key, title: t.title, status: t.status, pr_number: t.pr_number }));
function openApproveGuard(planId, tasks) {
  approveGuard = { planId, tasks };
  renderPlan();
  document.querySelector('.guard [data-default]')?.focus();
}
// The Approve plan button and the palette both come through here, so the in-flight guard always applies.
async function approvePlan(plan) {
  const prev = plansOf(plan.project_id).find((x) => x.status === 'approved' && (x.lineage || '') === (plan.lineage || ''));
  if (view !== 'plan') go({ view: 'plan' }); // the guard panel lives in Plan
  const mine = prev ? inFlightOf(prev.id) : [];
  if (mine.length) return openApproveGuard(plan.id, mine);
  const ok = await post(`/api/plans/${plan.id}/approve`, undefined, (m, j) => {
    if (Array.isArray(j?.inFlight) && j.inFlight.length) openApproveGuard(plan.id, j.inFlight); else toast(m, true);
  });
  if (ok) { toast(`Plan v${plan.version} approved`); refresh(); }
}
const planValidation = (plan) => events.find((e) => e.type === 'plan_drafted' && e.d.planId === plan.id)?.d.validation || { errors: [], warnings: [] };
function closeApproveGuard() {
  approveGuard = null;
  renderPlan();
  document.querySelector('.approve .btn.primary')?.focus();
}
function approveGuardPanel(plan, tasks) {
  const n = tasks.length;
  const confirm = async () => {
    const ok = await post(`/api/plans/${plan.id}/approve`, { force: true });
    if (ok) { approveGuard = null; toast(`Plan v${plan.version} approved, ${n} held`); refresh(); }
  };
  return h('div', { class: 'guard', role: 'alertdialog', 'aria-labelledby': 'guardTitle', 'aria-describedby': 'guardBody',
    onkeydown: (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeApproveGuard(); }
      else if (e.key === 'Enter' && !e.target.hasAttribute('data-confirm')) { e.preventDefault(); e.stopPropagation(); closeApproveGuard(); }
    } },
    h('h2', { id: 'guardTitle', text: `${n} ${n === 1 ? 'task is' : 'tasks are'} still in flight` }),
    h('ul', {}, tasks.map((t) => h('li', {},
      h('span', { class: 'mono muted', text: t.key }), h('span', { class: 'grow', text: t.title }),
      h('span', { class: 'mono', text: STATUS[t.status]?.[0] || t.status }),
      t.pr_number != null ? h('span', { class: 'mono muted', text: `PR #${t.pr_number}` }) : null))),
    h('p', { id: 'guardBody', text: `Approving anyway holds ${n === 1 ? 'this task' : 'these tasks'} for an owner decision. ${n === 1 ? 'It' : 'They'} will not merge unless you later choose Merge anyway` }),
    h('div', { class: 'acts' },
      h('button', { class: 'btn primary', 'data-default': '', onclick: closeApproveGuard }, 'Cancel'),
      h('button', { class: 'btn danger', 'data-confirm': '', onclick: confirm }, `Approve and hold ${n} ${n === 1 ? 'task' : 'tasks'}`)));
}

// ----- Roadmap: phases drafted one after another; every plan still needs the owner's approval -----
const PHASE = { queued: ['Queued', ''], drafting: ['Drafting plan', 'live'], review: ['Waiting for your approval', 'wait'], running: ['Running', 'live'], done: ['Done', 'ok'], failed: ['Stopped', 'bad'] };
// Queue editing state lives outside the DOM: render() runs on every SSE batch and would otherwise wipe an open form.
// edit = {id, title, prompt}; insert = {pos, title, prompt}; confirm = review phase id awaiting remove confirmation.
const rmUi = { edit: null, insert: null, confirm: null, errors: {}, busy: false, focus: null };
const rmRerender = (focus) => { rmUi.focus = focus || null; renderPlan(); };
// Re-rendering replaces every row; put keyboard focus (and caret) back on the same control.
function rmFocusKey() {
  const el = document.activeElement?.closest?.('#canvas [data-rm-key]');
  return el ? { key: el.dataset.rmKey, start: el.selectionStart, end: el.selectionEnd } : null;
}
function rmRestoreFocus(prev) {
  const want = rmUi.focus ? { key: rmUi.focus } : prev;
  rmUi.focus = null;
  if (!want) return;
  const q = (k) => [...$('canvas').querySelectorAll('[data-rm-key]')].find((n) => n.dataset.rmKey === k && !n.disabled);
  // A move button that just became disabled (the phase reached the end of the queue) hands focus to its sibling.
  const el = q(want.key) || (want.key.startsWith('up:') ? q('down:' + want.key.slice(3)) : want.key.startsWith('down:') ? q('up:' + want.key.slice(5)) : null);
  if (!el) return;
  el.focus();
  if (want.start != null && el.setSelectionRange) { try { el.setSelectionRange(want.start, want.end); } catch { /* not a text control */ } }
}
// Runs one queue mutation; a refusal is kept under errKey and shown inline next to the phase.
async function rmCall(errKey, path, body, focusAfter) {
  if (rmUi.busy) return false;
  rmUi.busy = true; delete rmUi.errors[errKey];
  const ok = await post(path, body, (m) => { rmUi.errors[errKey] = m; });
  rmUi.busy = false;
  if (ok) { rmUi.focus = focusAfter || null; refresh(); } else rmRerender(focusAfter);
  return !!ok;
}
const rmErr = (key) => rmUi.errors[key] ? h('p', { class: 'rm-err note-bad', role: 'alert', 'data-rm-error': String(key), text: rmUi.errors[key] }) : null;
// Title + prompt form shared by inline edit and insert; `draft` is mutated as the user types.
function rmForm(draft, kind, onSave, onCancel) {
  const title = h('input', { type: 'text', maxlength: '120', value: draft.title, 'aria-label': 'Phase title', placeholder: 'Title', 'data-rm-key': kind + '-title', oninput: (e) => { draft.title = e.target.value; } });
  const prompt = h('textarea', { rows: '5', maxlength: '4000', 'aria-label': 'Phase prompt', placeholder: 'What this phase builds', 'data-rm-key': kind + '-prompt', oninput: (e) => { draft.prompt = e.target.value; } });
  prompt.value = draft.prompt;
  const save = h('button', { class: 'btn primary', type: 'submit', disabled: rmUi.busy || !draft.title.trim() || !draft.prompt.trim() }, 'Save');
  const sync = () => { save.disabled = rmUi.busy || !draft.title.trim() || !draft.prompt.trim(); };
  title.addEventListener('input', sync); prompt.addEventListener('input', sync);
  return h('form', { class: 'rm-form', 'data-rm-form': kind,
    onsubmit: (e) => { e.preventDefault(); onSave(); },
    onkeydown: (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); } } },
    title, prompt, h('div', { class: 'btns' }, save, h('button', { class: 'btn ghost', type: 'button', onclick: onCancel }, 'Cancel')));
}
// The 'Insert phase here' slot at 1-based position `pos`; it opens a small title + prompt form.
function rmInsertGap(p, pos, rid) {
  const open = rmUi.insert?.pos === pos && rmUi.insert?.rid === rid, key = `ins:${rid}:${pos}`;
  const gap = h('div', { class: 'rm-gap' + (open ? ' open' : ''), 'data-rm-gap': String(pos) },
    open ? null : h('button', { class: 'btn ghost', type: 'button', 'data-rm-key': `insert-open:${rid}:${pos}`,
      onclick: () => { rmUi.insert = { pos, rid, title: '', prompt: '' }; rmUi.edit = null; rmUi.confirm = null; delete rmUi.errors[key]; rmRerender('insert-title'); } }, icon('plus'), 'Insert phase here'));
  if (!open && !rmUi.errors[key]) return gap;
  const d = rmUi.insert;
  const close = () => { rmUi.insert = null; delete rmUi.errors[key]; rmRerender(`insert-open:${rid}:${pos}`); };
  const save = async () => { if (await rmCall(key, `/api/projects/${encodeURIComponent(p.id)}/phases`, { position: pos, roadmapId: rid, title: d.title, prompt: d.prompt }, `insert-open:${rid}:${pos}`)) rmUi.insert = null; };
  return [gap, h('div', { class: 'rm-sub ins' }, open ? rmForm(d, 'insert', save, close) : null, rmErr(key))];
}
// Auto-approve controls for the roadmap card. The project setting is the only switch; phases can opt out.
function autoBar(p) {
  const on = p.auto_approve === 1;
  const setAuto = async (v) => { if (await post(`/api/projects/${encodeURIComponent(p.id)}/config`, { autoApprove: v })) { toast(v ? 'Auto-approve on' : 'Auto-approve off'); refresh(); } };
  const resume = async () => { if (await post(`/api/projects/${encodeURIComponent(p.id)}/auto-approve-resume`)) { toast('Auto-approve resumed'); refresh(); } };
  return h('div', { class: 'rm-auto', 'data-auto-bar': on ? 'on' : 'off' },
    on ? h('span', { class: 'state', text: 'Auto-approve is on' }) : h('span', { text: 'Auto-approve is off. You approve every plan' }),
    on ? h('button', { class: 'btn', type: 'button', 'data-auto-off': '', onclick: () => setAuto(false) }, 'Turn off auto-approve')
      : h('button', { class: 'btn ghost', type: 'button', 'data-auto-on': '', onclick: () => setAuto(true) }, 'Turn on auto-approve'),
    h('span', { class: 'lim', text: 'Limits: max 8 tasks, no protected files, previous phase merged. Anything else waits for you' }),
    p.auto_approve_halted ? h('div', { class: 'halt', role: 'alert', 'data-auto-halted': '' },
      h('span', { text: `Auto-approve halted: ${p.auto_approve_halted}` }),
      h('button', { class: 'btn', type: 'button', 'data-auto-resume': '', onclick: resume }, 'Resume auto-approve')) : null);
}
// rmTarget: null = the editor starts a new roadmap; a roadmap row = the editor appends phases to it.
let rmTarget = null;
function openRoadmapEditor(target = null, text = null) {
  rmTarget = target;
  $('roadmapTitle').textContent = target ? `Add phases to ${target.title}` : 'Start a new roadmap';
  $('roadmapSubmit').textContent = target ? 'Add phases' : 'Start roadmap';
  $('roadmapName').hidden = !!target;
  if (text != null) $('roadmapText').value = text;
  $('roadmapEditor').hidden = false; $('roadmapText').focus();
}
const roadmapsOf = (pid) => (state.roadmaps || []).filter((r) => r.project_id === pid);
const activePhases = (pid) => { const live = new Set(roadmapsOf(pid).filter((r) => r.status === 'active').map((r) => r.id));
  return (state.phases || []).filter((x) => x.project_id === pid && live.has(x.roadmap_id)); };
/** Where a plan came from: a chat request or a roadmap phase. */
function planSource(plan) {
  const m = /^roadmap:(\d+)$/.exec(plan.lineage || '');
  if (!m) return 'From chat';
  const r = (state.roadmaps || []).find((x) => x.id === Number(m[1]));
  const ph = (state.phases || []).find((x) => x.plan_id === plan.id);
  return `Roadmap ${r ? r.title : ''}${ph ? ` · phase ${ph.position}` : ''}`.replace('Roadmap  ', 'Roadmap ');
}
function roadmapCard(p) {
  const help = $('rmHelp');
  if (help) help.textContent = p.auto_approve === 1 ? 'Plans that pass the auto-approve limits start on their own; the rest wait for you' : 'You approve every plan';
  const all = roadmapsOf(p.id);
  const active = all.filter((r) => r.status === 'active'), finished = all.filter((r) => r.status === 'done').reverse();
  const phasesIn = (rid) => (state.phases || []).filter((x) => x.roadmap_id === rid).sort((a, b) => a.position - b.position);
  const full = active.length >= 3;
  const newTitle = full ? 'At most 3 roadmaps run at once. Finish or archive one first' : 'Runs alongside any roadmap already running';
  const start = h('button', { class: 'btn', type: 'button', 'data-rm-new': '', disabled: full, title: newTitle, onclick: () => openRoadmapEditor(null) }, icon('plus'), active.length ? 'New roadmap' : 'Start a new roadmap');
  const head = h('div', { class: 'rm-head' }, h('h2', { text: 'Roadmaps' }),
    h('span', { class: 'mono muted', text: active.length ? `${active.length} running` : 'none running' }),
    p.roadmap_paused && active.length ? h('span', { class: 't2', style: 'font-size:13px', text: 'Paused' }) : null, h('span', { class: 'grow' }),
    active.length ? h('button', { class: 'btn ghost', onclick: async () => { if (await post(`/api/projects/${p.id}/roadmap-pause`, { paused: !p.roadmap_paused })) refresh(); } },
      icon(p.roadmap_paused ? 'play' : 'pause'), p.roadmap_paused ? 'Resume all' : 'Pause all') : null, start);
  const empty = active.length ? null : h('div', { class: 'rm-empty', 'data-rm-empty': '' },
    h('span', { text: finished.length ? `${finished[0].title} is finished. Start a new roadmap to queue the next phases` : 'Queue several phases. Each is drafted after the previous one merges, and queued phases stay editable until then. Several roadmaps can run at once' }));
  const done = finished.length ? h('details', { class: 'rm-done', 'data-rm-finished': '' },
    h('summary', {}, icon('down'), `Finished roadmaps (${finished.length})`),
    finished.map((r) => { const n = phasesIn(r.id).length;
      return h('div', { class: 'lrow', 'data-roadmap': String(r.id) }, lamp('ok'), h('span', { class: 'ellipsis grow', text: r.title }),
        h('span', { class: 'mono muted', text: `${n} phase${n === 1 ? '' : 's'}${r.finished_at ? ' · ' + ago(sqlTime(r.finished_at)) : ''}` }),
        h('button', { class: 'btn ghost', type: 'button', 'data-rm-archive': '', onclick: async () => { if (await post(`/api/roadmaps/${r.id}/archive`)) { toast(`${r.title} archived`); refresh(); } } }, 'Archive')); })) : null;
  return h('div', { class: 'card roadmap' }, head, active.length ? autoBar(p) : null, empty,
    active.map((r) => roadmapBlock(p, r, phasesIn(r.id))), done);
}
function roadmapBlock(p, r, phs) {
  // Drop open forms whose phase moved on while the form was open.
  const statusOf = (id) => phs.find((x) => x.id === id)?.status;
  if (rmUi.edit && statusOf(rmUi.edit.id) !== 'queued') rmUi.edit = null;
  if (rmUi.confirm != null && statusOf(rmUi.confirm) !== 'review') rmUi.confirm = null;
  const autoOn = p.auto_approve === 1;
  const done = phs.filter((x) => x.status === 'done').length;
  const queued = phs.filter((x) => x.status === 'queued');
  const rows = [];
  phs.forEach((ph, i) => {
    const [label, kind] = PHASE[ph.status] || [ph.status, ''];
    const plan = ph.plan_id ? planFor(ph.plan_id) : null;
    const isQueued = ph.status === 'queued', readOnly = ['drafting', 'running', 'done'].includes(ph.status);
    const qi = queued.indexOf(ph), editing = isQueued && rmUi.edit?.id === ph.id;
    if (isQueued) rows.push(rmInsertGap(p, ph.position, r.id));
    const move = (to, k) => rmCall(ph.id, `/api/phases/${ph.id}/move`, { position: to }, `${k}:${ph.id}`);
    const remove = () => { rmUi.confirm = null; return rmCall(ph.id, `/api/phases/${ph.id}/remove`, {}, null); };
    const btn = (attrs, ic) => h('button', { class: 'btn ghost', type: 'button', ...attrs }, icon(ic));
    rows.push(h('div', { class: 'rm-row' + (readOnly ? ' ro' : ''), 'data-phase': String(ph.id), 'data-status': ph.status }, lamp(kind), h('span', { class: 'mono muted', text: String(i + 1) }), h('span', { class: 'ellipsis', title: ph.prompt, text: ph.title }),
      h('span', { class: 't2', style: 'font-size:13px; white-space:nowrap', text: label + (plan ? ` · v${plan.version}` : '') }),
      h('div', { class: 'acts' },
        readOnly ? h('span', { class: 'lock', 'data-rm-readonly': '', title: `Read-only while ${label.toLowerCase()}`, role: 'img', 'aria-label': `Read-only: ${label}` }, icon('lock')) : null,
        autoOn && ['queued', 'review'].includes(ph.status) ? (ph.approve_mode === 'off'
          ? h('button', { class: 'rm-mode manual', type: 'button', 'data-mode': 'manual', 'data-rm-key': 'mode:' + ph.id, title: 'This phase will not auto-approve. Click to follow the project setting',
            onclick: () => rmCall(ph.id, `/api/phases/${ph.id}/approve-mode`, { mode: 'inherit' }, 'mode:' + ph.id) }, 'Manual — waits for you')
          : h('button', { class: 'rm-mode', type: 'button', 'data-mode': 'auto', 'data-rm-key': 'mode:' + ph.id, title: 'Auto-approves if the limits pass. Click to approve this phase yourself',
            onclick: () => rmCall(ph.id, `/api/phases/${ph.id}/approve-mode`, { mode: 'off' }, 'mode:' + ph.id) }, 'auto')) : null,
        ph.status === 'review' && ph.plan_id ? h('button', { class: 'btn', onclick: () => { selPlan[p.id] = ph.plan_id; setRoute({ selNode: null }); renderPlan(); } }, 'Review plan') : null,
        ph.status === 'failed' ? h('button', { class: 'btn', onclick: async () => { if (await post(`/api/phases/${ph.id}/retry`)) refresh(); } }, icon('retry'), 'Retry') : null,
        ph.status === 'running' && !state.tasks.some((t) => t.plan_id === ph.plan_id && !['merged', 'cancelled'].includes(t.status))
          ? h('button', { class: 'btn', type: 'button', 'data-mark-done': '', onclick: async () => { if (await post(`/api/phases/${ph.id}/mark-done`)) { toast('Phase marked done'); refresh(); } } }, 'Mark done') : null,
        isQueued ? [
          btn({ 'data-rm-move': 'up', 'data-rm-key': 'up:' + ph.id, 'aria-label': `Move ${ph.title} up`, title: 'Move up', disabled: qi === 0, onclick: () => move(ph.position - 1, 'up') }, 'up'),
          btn({ 'data-rm-move': 'down', 'data-rm-key': 'down:' + ph.id, 'aria-label': `Move ${ph.title} down`, title: 'Move down', disabled: qi === queued.length - 1, onclick: () => move(ph.position + 1, 'down') }, 'down'),
          btn({ 'data-rm-edit': '', 'data-rm-key': 'edit:' + ph.id, 'aria-label': `Edit ${ph.title}`, title: 'Edit', 'aria-expanded': String(editing),
            onclick: () => { rmUi.edit = { id: ph.id, title: ph.title, prompt: ph.prompt }; rmUi.insert = null; rmUi.confirm = null; delete rmUi.errors[ph.id]; rmRerender('edit-title'); } }, 'edit')] : null,
        ['queued', 'failed', 'review'].includes(ph.status) ? btn({ 'data-rm-remove': '', 'data-rm-key': 'remove:' + ph.id, 'aria-label': `Remove ${ph.title}`, title: 'Remove',
          onclick: () => { if (ph.status !== 'review') return remove(); rmUi.confirm = ph.id; rmUi.edit = null; rmUi.insert = null; rmRerender('confirm-keep:' + ph.id); } }, 'x') : null)));
    if (editing) {
      const d = rmUi.edit;
      const close = () => { rmUi.edit = null; delete rmUi.errors[ph.id]; rmRerender('edit:' + ph.id); };
      const save = async () => { if (await rmCall(ph.id, `/api/phases/${ph.id}/edit`, { title: d.title, prompt: d.prompt }, 'edit:' + ph.id)) rmUi.edit = null; };
      rows.push(h('div', { class: 'rm-sub' }, rmForm(d, 'edit', save, close), rmErr(ph.id)));
    } else {
      const err = rmErr(ph.id) || (ph.status === 'failed' && ph.error ? h('p', { class: 'rm-err', text: ph.error }) : null);
      const confirm = rmUi.confirm === ph.id ? h('div', { class: 'rm-confirm', role: 'group', 'aria-label': 'Confirm remove', 'data-rm-confirm': '' },
        h('span', { text: 'Remove this phase? Its drafted plan will be discarded' }),
        h('button', { class: 'btn primary', type: 'button', 'data-rm-key': 'confirm-keep:' + ph.id, onclick: () => { rmUi.confirm = null; rmRerender('remove:' + ph.id); } }, 'Keep phase'),
        h('button', { class: 'btn', type: 'button', 'data-rm-confirm-remove': '', onclick: remove }, 'Remove and discard plan')) : null;
      const need = ph.status === 'review' && ph.auto_note ? h('p', { class: 'rm-need', 'data-auto-note': '', text: `Needs you: ${ph.auto_note}` }) : null;
      const note = ph.status === 'done' && ph.done_note ? h('p', { class: 'rm-note', 'data-done-note': '', text: `Done: ${ph.done_note}` }) : null;
      if (err || confirm || need || note) rows.push(h('div', { class: 'rm-sub' }, need, note, confirm, err));
    }
  });
  rows.push(rmInsertGap(p, phs.length + 1, r.id));
  const live = phs.some((x) => ['drafting', 'review', 'running'].includes(x.status));
  return h('div', { class: 'rm-block', 'data-roadmap': String(r.id) },
    h('div', { class: 'rm-head' }, h('h3', { class: 'ellipsis', text: r.title }), h('span', { class: 'mono muted', text: `${done} of ${phs.length} done` }), h('span', { class: 'grow' }),
      h('button', { class: 'btn ghost', type: 'button', 'data-rm-add': '', onclick: () => openRoadmapEditor(r) }, icon('plus'), 'Add phases'),
      live ? null : h('button', { class: 'btn ghost', type: 'button', 'data-rm-archive': '', title: 'Hide this roadmap. Its queued phases will not run',
        onclick: async () => { if (await post(`/api/roadmaps/${r.id}/archive`)) { toast(`${r.title} archived`); refresh(); } } }, 'Archive')),
    rows);
}

function drawEdges() {
  const lanes = $('lanes'); if (!lanes || !lanes.isConnected || !lanes.offsetWidth) return;
  // Chain order comes from shape.chain (set on the lanes as data-chain); an edge is on the chain when its ends are consecutive keys.
  const chain = (lanes.dataset.chain || '').split(' ').filter(Boolean);
  const onChainEdge = (from, to) => { const i = chain.indexOf(from); return i >= 0 && chain[i + 1] === to; };
  lanes.querySelector('svg.edges')?.remove();
  const box = lanes.getBoundingClientRect();
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'edges'); svg.setAttribute('width', lanes.scrollWidth); svg.setAttribute('height', lanes.scrollHeight);
  const nodes = new Map([...lanes.querySelectorAll('.node')].map((n) => [n.dataset.key, n]));
  for (const n of nodes.values()) for (const d of n.dataset.deps.split(' ').filter(Boolean)) {
    const dep = nodes.get(d); if (!dep) continue;
    const a = dep.getBoundingClientRect(), b = n.getBoundingClientRect();
    const ax = a.right - box.left, ay = a.top + a.height / 2 - box.top, bx = b.left - box.left, by = b.top + b.height / 2 - box.top, mx = (ax + bx) / 2;
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', `M${ax} ${ay} C${mx} ${ay}, ${mx} ${by}, ${bx} ${by}`);
    // Stroke comes from CSS so the live edge uses the single --accent token.
    const cls = [];
    if (dep.dataset.status === 'merged' && ['running', 'waiting_ci', 'merging'].includes(n.dataset.status)) cls.push('lit');
    if (onChainEdge(d, n.dataset.key)) cls.push('on-chain');
    if (cls.length) path.setAttribute('class', cls.join(' '));
    svg.append(path);
  }
  lanes.prepend(svg);
}

// Two or more '---'-separated chunks whose first lines look like phase titles: probably a roadmap pasted into chat.
const looksLikeRoadmap = (text) => { const parts = text.replace(/\r\n/g, '\n').split(/^\s*-{3,}\s*$/m).map((x) => x.trim()).filter(Boolean);
  return parts.length >= 2 && parts.filter((x) => /^#*\s*(phase|step|milestone)\b/i.test(x)).length >= 2; };
async function sendRequest(projectId, text, confirmed = false) {
  if (!projectId || !text.trim()) return;
  if (!confirmed && looksLikeRoadmap(text)) { $('chatRoadmapHint').hidden = false; $('hintRoadmap').focus(); return; }
  $('chatRoadmapHint').hidden = true;
  if (await post(`/api/projects/${encodeURIComponent(projectId)}/chat`, { text: text.trim() })) {
    clearSubmittedDraft(projectId, 'chat', 'chatIn', text);
    refresh();
  }
}

function clearSubmittedDraft(projectId, field, inputId, text) {
  if (projectId === draftProjectId) {
    const input = $(inputId);
    if (input.value !== text) return false;
    input.value = '';
    return true;
  }
  const draft = drafts.get(projectId);
  if (draft?.[field] === text) draft[field] = '';
  return false;
}

// ---------- wiring ----------
$('clearChat').onclick = async () => {
  const project = proj();
  if (!project || !window.confirm(`Delete the chat messages for ${project.name}? Plans and task history will stay.`)) return;
  if (await post(`/api/projects/${encodeURIComponent(project.id)}/clear-chat`)) {
    toast(`Cleared chat for ${project.name}`);
    refresh();
  }
};
$('send').onclick = () => sendRequest(draftProjectId, $('chatIn').value);
$('chatIn').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendRequest(draftProjectId, $('chatIn').value); } });
$('roadmapEditor').onsubmit = async (e) => {
  e.preventDefault();
  const projectId = draftProjectId;
  const text = $('roadmapText').value;
  if (!projectId) return;
  const target = rmTarget;
  const r = await post(`/api/projects/${encodeURIComponent(projectId)}/roadmap`,
    target ? { text, roadmapId: target.id } : { text, newRoadmap: true, title: $('roadmapName').value.trim() || undefined });
  if (r) {
    toast(target ? `Phases added to ${target.title}` : 'Roadmap started');
    if (clearSubmittedDraft(projectId, 'roadmap', 'roadmapText', text)) { $('roadmapEditor').hidden = true; $('roadmapName').value = ''; rmTarget = null; }
    refresh();
  }
};
$('roadmapCancel').onclick = () => { $('roadmapEditor').hidden = true; rmTarget = null; };
$('hintSend').onclick = () => sendRequest(draftProjectId, $('chatIn').value, true);
$('hintRoadmap').onclick = () => { const text = $('chatIn').value; $('chatRoadmapHint').hidden = true;
  if (view !== 'plan') go({ view: 'plan' }); openRoadmapEditor(null, text); $('chatIn').value = ''; };
$('chatIn').addEventListener('input', () => { if (!$('chatRoadmapHint').hidden && !looksLikeRoadmap($('chatIn').value)) $('chatRoadmapHint').hidden = true; });
hooks.lanes = drawEdges;
window.addEventListener('resize', () => requestAnimationFrame(drawEdges));
setInterval(() => { const c = $('clock'); if (c?.isConnected) c.textContent = fmtClock(Date.now() - Number(c.dataset.start)); }, 1000);

export {
  activePhases, approveGuard, approvePlan, closeApproveGuard, levels, openRoadmapEditor, planValidation,
  renderPlan, showProjectDrafts
};
// </script>
