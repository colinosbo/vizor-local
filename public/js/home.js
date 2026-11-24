// <script>
// home.js: Home view (#v-home): the across-projects figures, one card per project and the new-project form.
// The first and last lines are markers the static UI tests read modules by; keep them.
import {
  $, countTo, go, h, keepSame, lamp, post, put, reducedMotion, refresh, retryMany, runLamp, segBar, setText,
  sqlTime, state, statusFromState, tally, tasksOf, toast
} from './core.js';

// ----- Home: across-projects strip and one card per project, all from /api/state -----
const relTime = (ms, now = Date.now()) => {
  const m = Math.floor(Math.max(0, now - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `${hr} ${hr === 1 ? 'hour' : 'hours'} ago`;
  const d = Math.floor(hr / 24);
  return `${d} ${d === 1 ? 'day' : 'days'} ago`;
};
function lastActivity(pid) {
  const ts = tasksOf(pid), ids = new Set(ts.map((t) => t.id));
  const stamps = [...ts.map((t) => t.updated_at), ...state.attempts.filter((a) => ids.has(a.task_id)).map((a) => a.started_at),
    ...state.messages.filter((m) => m.project_id === pid).map((m) => m.created_at)]
    .filter(Boolean).map((s) => sqlTime(s).getTime()).filter((n) => !Number.isNaN(n));
  return stamps.length ? Math.max(...stamps) : null;
}
// First match wins; the action follows the same state so the card never offers two things.
function homeCard(p) {
  const st = statusFromState(state, p.id), held = tasksOf(p.id).filter((t) => t.status === 'blocked');
  let text = 'Idle', kind = '', action = { label: 'Open', run: () => go({ current: p.id, view: 'overview', selTask: null }) };
  if (p.paused) { text = 'Paused'; kind = 'wait'; }
  else if (st.planWaits) { text = 'Review plan'; kind = 'wait'; action = { label: 'Review plan', run: () => go({ current: p.id, view: 'plan', selTask: null }) }; }
  else if (st.held || st.pushErr) {
    text = 'Needs you'; kind = 'bad';
    // Read held tasks at click time: an unchanged card is kept across refreshes, so its handlers must not hold stale data.
    if (held.length) action = { label: 'Retry held', run: () => retryMany(tasksOf(p.id).filter((t) => t.status === 'blocked')) };
  } else if (st.running > 0) { text = `Running ${st.running}`; kind = 'live'; }
  const at = lastActivity(p.id);
  const open = () => go({ current: p.id, view: 'overview', selTask: null });
  const card = h('article', { class: 'card pcard' },
    h('button', { class: 'pcard-open', type: 'button', 'aria-label': `Open ${p.name}`, onclick: open }),
    h('div', { class: 'row' }, h('span', { class: 'pname ellipsis grow', text: p.name }),
      h('span', { class: 'status' }, lamp(kind), text)),
    h('div', { class: 'mono muted ellipsis', title: p.repo_path, text: p.repo_path }),
    h('div', { class: 'row' }, segBar(tally(tasksOf(p.id).filter((t) => t.status !== 'cancelled'))), h('span', { class: 'pct mono', text: st.pct + '%' })),
    h('div', { class: 'row' }, h('span', { class: 'mono muted grow', text: at == null ? 'No activity yet' : relTime(at) }),
      h('button', { class: 'btn act', type: 'button', onclick: action.run, text: action.label })));
  card._sig = card.outerHTML;
  return card;
}
// The form is static markup so SSE-driven renders never wipe what is being typed; render only flips visibility.
let npOpen = false, npEmptyMode = false, npBusy = false;
function renderNewProject() {
  const first = state.projects.length === 0;
  $('hHead').hidden = $('hStrip').hidden = $('homeGrid').hidden = first;
  document.querySelector('#v-home .ov').classList.toggle('first', first);
  $('npStart').hidden = !first;
  // The static markup keeps only the form's submit as primary; the opener takes that role while the form is closed
  $('npFirst').classList.toggle('primary', !npOpen);
  $('npOpen').classList.toggle('primary', !npOpen);
  $('npFirst').hidden = npOpen; // the open form's submit is then the only primary
  $('npMore').hidden = first || npOpen;
  $('npForm').hidden = !npOpen;
  $('npExisting').setAttribute('aria-pressed', String(!npEmptyMode));
  $('npEmpty').setAttribute('aria-pressed', String(npEmptyMode));
  $('npSubmit').textContent = npEmptyMode ? 'Create project' : 'Add project';
  $('npPath').placeholder = npEmptyMode ? 'C:\\Users\\you\\code\\new-app' : 'C:\\Users\\you\\code\\app';
  $('npHint').textContent = npEmptyMode ? 'Local creates the folder, a git repository and a local origin' : 'A folder that already holds your code';
}
function openNewProject(on) {
  npOpen = on; $('npErr').textContent = ''; renderNewProject();
  if (on) $('npPath').focus();
}
function setNpMode(empty) { npEmptyMode = empty; $('npErr').textContent = ''; renderNewProject(); }
$('npOpen').onclick = $('npFirst').onclick = () => openNewProject(true);
$('npCancel').onclick = () => openNewProject(false);
$('npExisting').onclick = () => setNpMode(false);
$('npEmpty').onclick = () => setNpMode(true);
$('npForm').onsubmit = async (e) => {
  e.preventDefault();
  if (npBusy) return;
  npBusy = true; $('npSubmit').disabled = true; $('npErr').textContent = '';
  try {
    const body = { path: $('npPath').value.trim(), name: $('npName').value.trim() || undefined, ciCommand: $('npCi').value.trim(), maxWorkers: 2 };
    if (npEmptyMode) Object.assign(body, { createOrigin: true, createFolder: true });
    const r = await post('/api/projects', body, (m) => { $('npErr').textContent = m; });
    if (!r) return; // inputs stay as typed
    toast(`Added ${r.name}`);
    $('npPath').value = ''; $('npName').value = ''; $('npCi').value = 'npm test';
    npOpen = false; npEmptyMode = false;
    await refresh();
    go({ current: r.id, view: 'overview', selTask: null });
  } finally { npBusy = false; $('npSubmit').disabled = false; }
};
let homeEnter = false;
function renderHome(entering) {
  renderNewProject();
  if (entering) homeEnter = !reducedMotion.matches;
  const sts = state.projects.map((p) => statusFromState(state, p.id));
  const busy = state.tasks.filter((t) => t.status === 'running').length;
  const limit = Number(state.settings.find((s) => s.key === 'global_max_workers')?.value ?? 4);
  countTo($('hsBusy'), busy); setText($('hsLimit'), '/' + limit); runLamp($('hsLamp'), busy > 0);
  const need = sts.reduce((n, s) => n + s.needs, 0), push = sts.reduce((n, s) => n + s.unpushed, 0);
  countTo($('hsNeed'), need); $('hsNeedBox').classList.toggle('attn', need > 0);
  countTo($('hsPush'), push);
  // Animate only the render that follows entering Home; it waits for data if the first render had no cards.
  const animate = homeEnter && state.projects.length > 0;
  const cards = state.projects.map(homeCard);
  if (!animate) return keepSame($('homeGrid'), cards);
  // The entrance class goes on after keepSame's signature is taken, so a refresh mid-entrance keeps the animating card.
  cards.slice(0, 6).forEach((card, i) => { card.classList.add('enter'); card.style.setProperty('--i', i); });
  put($('homeGrid'), cards);
  if (animate) homeEnter = false;
}

export { renderHome };
// </script>
