// <script>
// nav.js: the view registry (render() picks and draws the visible view), the sidebar, the header status strip and
// page-wide wiring: keyboard shortcuts, hash routing and the 30s refresh.
// The first and last lines are markers the static UI tests read modules by; keep them.
import {
  $, VIEWS, clockDay, countTo, current, go, h, hooks, icon, lamp, proj, projectStats, projectStatus, put,
  readHash, reducedMotion, runLamp, setText, state, statusFromState, view
} from './core.js';
import { renderHome } from './home.js';
import { renderOverview } from './overview.js';
import { approveGuard, closeApproveGuard, renderPlan, showProjectDrafts } from './plan.js';
import { boardKey, renderBoard } from './board.js';
import { cancelTask, closeCancelTask, closeMergeAnyway, mergeAnyway, renderRun } from './run.js';
import { renderShip } from './ship.js';
import { renderProjects } from './projects.js';
import { isPaletteKey, palOpen, renderPalette, togglePalette } from './palette.js';
import './update.js';

// ---------- render ----------
// render() runs on every SSE batch, so the entrance plays only when the visible view actually changes.
let shownView = null;
function enterView(section) {
  section.classList.remove('entering');
  if (reducedMotion.matches) return; // jump straight to the final state
  void section.offsetWidth; // restart the animation if this section is re-entered quickly
  section.classList.add('entering');
  section.addEventListener('animationend', () => section.classList.remove('entering'), { once: true });
}
function render() {
  showProjectDrafts(proj());
  renderSide(); renderHeader();
  const shown = view === 'home' ? 'home' : !proj() && view !== 'projects' ? 'none' : view;
  for (const s of document.querySelectorAll('main > section')) s.hidden = s.id !== 'v-' + shown;
  const entering = shown !== shownView;
  // Home animates its cards instead of fading the whole section, so the two don't stack.
  if (entering) { shownView = shown; if (shown !== 'home') enterView($('v-' + shown)); }
  if (shown === 'home') renderHome(entering);
  if (shown === 'overview') renderOverview();
  if (shown === 'plan') renderPlan();
  if (shown === 'board') {
    // Re-rendering replaces every card; keep keyboard focus on the same task.
    const keep = document.activeElement?.closest?.('#v-board .tcard[data-task-id]')?.dataset.taskId;
    renderBoard();
    if (keep && !document.activeElement?.closest?.('.tcard')) {
      [...$('v-board').querySelectorAll('.tcard[data-task-id]')].find((c) => c.dataset.taskId === keep)?.focus();
    }
  }
  if (shown === 'run') renderRun();
  if (shown === 'ship') renderShip();
  if (shown === 'projects') renderProjects();
  warnExtraPrimaries(shown);
  if (palOpen) renderPalette(); // keep action states current while open
}
// Dev-time guard: at most one visible .btn.primary across the current view and header
function warnExtraPrimaries(shown) {
  const visible = [...document.querySelectorAll('#v-' + shown + ' .btn.primary, header .btn.primary')].filter((b) => b.offsetParent !== null);
  if (visible.length > 1) console.warn(`[one-primary] ${visible.length} visible .btn.primary in "${shown}" view`, visible);
}
hooks.render = render;

function renderSide() {
  const button = (p) => {
    const [status, kind] = projectStatus(p), st = projectStats(p);
    return h('button', { class: 'nav proj', 'aria-current': String(p.id === current && view !== 'home'), title: p.repo_path,
      onclick: () => go({ current: p.id, view: view === 'projects' || view === 'home' ? 'overview' : view, selTask: null }) },
      lamp(kind), h('span', { class: 'grow pname' }, h('span', { class: 'ellipsis', text: p.name }),
        status ? h('span', { class: 'mono muted', text: status }) : null),
      st.total ? h('span', { class: 'mono muted', title: `${st.c.merged} of ${st.total} tasks merged`, text: st.pct + '%' }) : null);
  };
  put($('homeNav'), h('button', { class: 'nav', 'aria-current': String(view === 'home'), onclick: () => go({ view: 'home' }) }, icon('home'), h('span', { class: 'grow', text: 'Home' })));
  put($('projectList'), state.projects.map(button),
    h('button', { class: 'nav', onclick: () => { go({ view: 'projects' }); $('aPath').focus(); } },
      icon('plus'), h('span', { class: 'grow', text: 'Add project' })));
  put($('viewNav'), ...VIEWS.map(([k, label]) =>
    h('button', { class: 'nav', 'aria-current': String(view === k), onclick: () => go({ view: k }) }, icon(k), h('span', { class: 'grow', text: label }))));
  const g = state.settings.find((s) => s.key === 'global_max_workers')?.value ?? '4';
  const busy = state.tasks.filter((t) => t.status === 'running').length;
  $('globalCap').textContent = `${busy} of ${g} workers busy across projects`;
}

function renderHeader() {
  const p = view === 'home' ? null : proj();
  $('hTitle').textContent = p ? p.name : 'Vizor Local';
  $('hPath').textContent = p ? p.repo_path : '';
  $('strip').hidden = !p;
  if (p) renderStrip(statusFromState(state, p.id));
}

const stripEls = {};
function renderStrip(st) {
  if (!st) return;
  const item = (key, label, nav) => {
    if (stripEls[key]?.isConnected) return stripEls[key];
    const num = h('span', { class: 'num' }), unit = h('span', { class: 'num' }), lbl = h('span', { class: 'lbl', text: label }), dot = lamp('idle', 'Running');
    const b = h('button', { class: 'sitem', type: 'button', onclick: nav }, dot, num, unit, lbl);
    b._p = { num, unit, dot, lbl }; stripEls[key] = b; return b;
  };
  const needsView = () => {
    const s = statusFromState(state, current);
    if (s.planWaits) return go({ view: 'plan' });
    if (s.held) { go({ view: 'board' }); return requestAnimationFrame(() => $('v-board').querySelector('[data-col="Held"]')?.scrollIntoView({ block: 'center' })); }
    if (s.pushErr) return go({ view: 'ship' });
    go({ view: 'board' });
  };
  const pct = item('pct', 'done', () => go({ view: 'board' }));
  const wk = item('wk', 'workers', () => go({ view: 'board' }));
  const fin = item('fin', 'finish', () => go({ view: 'board' }));
  const need = item('need', 'needs you', needsView);
  const push = item('push', 'unpushed', () => go({ view: 'ship' }));
  // Every write below goes through countTo/setText, which leave the node alone when the value is unchanged.
  countTo(pct._p.num, st.pct); setText(pct._p.unit, '%');
  pct.setAttribute('aria-label', `${st.pct} percent of tasks merged, open board`);
  countTo(wk._p.num, st.running); setText(wk._p.unit, '/' + st.limit); runLamp(wk._p.dot, st.running > 0);
  wk.setAttribute('aria-label', `${st.running} of ${st.limit} workers running, open board`);
  const finText = st.eta == null ? '—' : clockDay(st.eta);
  setText(fin._p.num, finText); setText(fin._p.unit, '');
  fin.setAttribute('aria-label', st.eta == null ? 'Estimated finish unknown, open board' : `Estimated finish ${finText}, open board`);
  countTo(need._p.num, st.needs); setText(need._p.unit, '');
  need.classList.toggle('attn', st.needs > 0);
  need.setAttribute('aria-label', `${st.needs} items need you, open the view that explains them`);
  countTo(push._p.num, st.unpushed); setText(push._p.unit, '');
  push.setAttribute('aria-label', `${st.unpushed} commits not yet pushed to GitHub, open ship`);
  if (!$('strip').firstChild) put($('strip'), pct, wk, fin, need, push);
}

// ---------- wiring ----------
$('goAdd').onclick = () => { go({ view: 'projects' }); $('aPath').focus(); };
hooks.key = (e) => {
  // Ctrl+K / Cmd+K is the one shortcut that also works while typing in chatIn or any other field.
  if (isPaletteKey(e)) { e.preventDefault(); if (!e.repeat) togglePalette(); return; }
  if (palOpen) return; // the palette handles its own keys
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  if (e.key === 'Escape' && typing) return e.target.blur();
  if (mergeAnyway && view === 'run' && e.key === 'Escape') return closeMergeAnyway();
  if (cancelTask && !cancelTask.busy && view === 'run' && e.key === 'Escape') return closeCancelTask();
  if (approveGuard && e.key === 'Escape') return closeApproveGuard();
  if (e.target.closest?.('.guard')) return;
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (boardKey(e)) return;
  const i = Number(e.key);
  if (i >= 1 && i <= VIEWS.length) { e.preventDefault(); go({ view: VIEWS[i - 1][0] }); }
  if (e.key === '/' && proj()) { e.preventDefault(); go({ view: 'plan' }); $('chatIn').focus(); }
};
$('goHome').addEventListener('click', () => go({ view: 'home' }));
window.addEventListener('hashchange', () => { readHash(); render(); });
setInterval(() => { if (proj() && ['overview', 'board'].includes(view) && !document.hidden) render(); }, 30000);

// </script>
