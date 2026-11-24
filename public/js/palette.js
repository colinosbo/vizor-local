// <script>
// palette.js: the command palette (Ctrl+K / Cmd+K): projects, views, tasks and actions.
// The first and last lines are markers the static UI tests read modules by; keep them.
import {
  $, STATUS, VIEWS, emptyState, go, h, icon, isOpenTask, lamp, latestPlan, needsApproval, post, proj,
  projectStatus, put, refresh, retry, selTask, shipCache, state, tasksOf, toast, togglePause, view
} from './core.js';
import { approvePlan, openRoadmapEditor, planValidation } from './plan.js';
import { BOARD_KEYS, hidePop } from './board.js';
import { canCancelTask, openCancelTask } from './run.js';
import { askPush } from './ship.js';

// ----- Command palette (Ctrl+K / Cmd+K): projects, views, tasks in this project, and actions -----
// Every action calls the same function as its visible button and is hidden or disabled when it does not apply.
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgentData?.platform || navigator.platform || '');
const isPaletteKey = (e) => (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key?.toLowerCase() === 'k';
const PALETTE_KEYS = [IS_MAC ? '⌘' : 'Ctrl', 'K'];
const KEY_GLYPH = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc' };
const keycaps = (keys) => h('span', { class: 'keys' }, keys.map((k) => h('span', { class: 'kbd', text: KEY_GLYPH[k] ?? k })));
const BOARD_KEY_LABEL = { up: 'Up', down: 'Down', left: 'Left column', right: 'Right column', open: 'Open run', retry: 'Retry held', back: 'Back to board' };
let palOpen = false, palReturn = null, palTask = null, palShown = [], palActive = -1;

// Same endpoints and toasts as the roadmap card's auto-approve buttons.
async function paletteAuto(p, path, body, msg) {
  if (await post(`/api/projects/${encodeURIComponent(p.id)}/${path}`, body)) { toast(msg); refresh(); }
}
function paletteActions() {
  const p = view === 'home' ? null : proj();
  if (!p) return [];
  const t = palTask ? state.tasks.find((x) => x.id === palTask && x.project_id === p.id) : null;
  const draft = needsApproval(p.id) ? latestPlan(p.id) : null;
  const ship = shipCache[p.id]?.data;
  const auto = p.auto_approve === 1;
  return [
    t?.status === 'blocked' && { id: 'retry', label: 'Retry task', icon: 'retry', hint: t.title, keys: view === 'board' ? BOARD_KEYS.retry : null, run: () => retry(t) },
    t && canCancelTask(t) && { id: 'cancel-task', label: 'Cancel task…', icon: 'x', hint: t.title, run: () => openCancelTask(t) },
    { id: 'push', label: 'Push to GitHub', icon: 'ship', hint: 'Confirm in Ship', disabled: ship && !ship.aheadCount ? 'Nothing to push' : null,
      run: () => { if (view !== 'ship') go({ view: 'ship' }); askPush(p.id); } },
    { id: 'pause', label: p.paused ? 'Resume dispatch' : 'Pause dispatch', icon: p.paused ? 'play' : 'pause', run: togglePause },
    draft && { id: 'approve', label: 'Approve plan', icon: 'check', hint: `Plan v${draft.version}`,
      disabled: planValidation(draft).errors.length ? 'Fix the plan errors first' : null, run: () => approvePlan(draft) },
    { id: 'roadmap', label: 'New roadmap', icon: 'plus', run: () => { if (view !== 'plan') go({ view: 'plan' }); openRoadmapEditor(); } },
    { id: 'auto', label: auto ? 'Turn off auto-approve' : 'Turn on auto-approve', icon: 'check', hint: auto ? 'You approve every plan' : 'Plans within the limits start on their own', run: () => paletteAuto(p, 'config', { autoApprove: !auto }, auto ? 'Auto-approve off' : 'Auto-approve on') },
    p.auto_approve_halted && { id: 'auto-resume', label: 'Resume auto-approve', icon: 'play', hint: p.auto_approve_halted, run: () => paletteAuto(p, 'auto-approve-resume', undefined, 'Auto-approve resumed') },
  ].filter(Boolean);
}
function paletteItems() {
  const p = proj();
  const items = paletteActions().map((a) => ({ ...a, kind: 'Action' }));
  items.push({ id: 'view:home', kind: 'View', label: 'Home', icon: 'home', run: () => go({ view: 'home' }) });
  VIEWS.forEach(([k, label], i) => { if (p || k === 'projects') items.push({ id: 'view:' + k, kind: 'View', label, icon: k, keys: [String(i + 1)], run: () => go({ view: k }) }); });
  for (const x of state.projects) items.push({ id: 'project:' + x.id, kind: 'Project', label: x.name, hint: x.repo_path, lamp: projectStatus(x)[1], lampLabel: projectStatus(x)[0] || 'Idle',
    run: () => go({ current: x.id, view: view === 'projects' || view === 'home' ? 'overview' : view, selTask: null }) });
  if (p) for (const t of tasksOf(p.id).filter((t) => t.status !== 'cancelled').sort((a, b) => Number(isOpenTask(b)) - Number(isOpenTask(a))))
    items.push({ id: 'task:' + t.id, kind: 'Task', label: t.title, hint: `${t.key} · ${t.model || 'default'}`, lamp: (STATUS[t.status] || [])[1] || '', lampLabel: STATUS[t.status]?.[0] || t.status, open: isOpenTask(t), run: () => go({ view: 'run', selTask: t.id }) });
  return items;
}
// Each query character must continue the current run of hits or land on a word start (index 0, or after whitespace or -_/.:#).
// A small memoised search picks the best-scoring valid path, so a greedy miss never hides a real match. null = no match.
function fuzzy(q, text) {
  const s = text.toLowerCase(), n = q.length, memo = new Map();
  const starts = (j) => j === 0 || /[\s\-_/.:#]/.test(s[j - 1]);
  const best = (qi, prev, run) => {
    if (qi === n) return { score: 0, hits: [] };
    const key = qi * 1e6 + (prev + 1) * 1e3 + run;
    if (memo.has(key)) return memo.get(key);
    let top = null;
    for (let j = prev + 1; j < s.length; j++) {
      if (s[j] !== q[qi]) continue;
      const cont = prev >= 0 && j === prev + 1;
      if (!cont && !starts(j)) continue;
      const r = cont ? run + 1 : 0, rest = best(qi + 1, j, r);
      if (!rest) continue;
      const score = 1 + 2 * r + (starts(j) ? 3 : 0) + rest.score;
      if (!top || score > top.score) top = { score, hits: [j, ...rest.hits] };
    }
    memo.set(key, top);
    return top;
  };
  const m = n ? best(0, -1, 0) : null;
  return m && { score: m.score - (m.hits[0] + s.length) * 0.01, hits: m.hits };
}
function markHits(text, hits) {
  if (!hits?.length) return text;
  const set = new Set(hits), out = [];
  for (let i = 0; i < text.length;) {
    const on = set.has(i); let j = i;
    while (j < text.length && set.has(j) === on) j++;
    out.push(on ? h('span', { class: 'hit', text: text.slice(i, j) }) : text.slice(i, j));
    i = j;
  }
  return out;
}
function renderPalette() {
  const q = $('palIn').value.replace(/\s+/g, '').toLowerCase();
  const keep = palShown[palActive]?.id;
  const items = paletteItems();
  if (!q) palShown = [...items.filter((x) => x.kind !== 'Task'), ...items.filter((x) => x.kind === 'Task' && x.open).slice(0, 8)];
  else {
    palShown = items.map((x, order) => {
      const m = fuzzy(q, x.label), mh = m ? null : x.hint && fuzzy(q, x.hint);
      return m ? { ...x, order, score: m.score, hits: m.hits } : mh ? { ...x, order, score: mh.score / 2 } : null;
    }).filter(Boolean).sort((a, b) => b.score - a.score || a.order - b.order).slice(0, 50);
  }
  put($('palList'), palShown.map((x, i) => h('div', { class: 'pal-opt', role: 'option', id: 'pal-opt-' + i, 'aria-selected': 'false', 'aria-disabled': x.disabled ? 'true' : null,
    onmousemove: () => { if (!x.disabled && palActive !== i) setPaletteActive(i); }, onclick: () => runPaletteItem(x) },
    x.lamp != null ? lamp(x.lamp, x.lampLabel) : icon(x.icon),
    h('span', { class: 'txt' }, h('span', { class: 'lbl' }, markHits(x.label, x.hits)), x.disabled || x.hint ? h('span', { class: 'hint', text: x.disabled || x.hint }) : null),
    x.keys ? keycaps(x.keys) : h('span'),
    h('span', { class: 'kind mono', text: x.kind }))));
  $('palNone').hidden = palShown.length > 0;
  if (!palShown.length) put($('palNone'), emptyState('No matches', 'Nothing in projects, views, tasks or actions fits this search',
    { label: 'Clear search', onclick: () => { $('palIn').value = ''; renderPalette(); $('palIn').focus(); } }));
  $('palCount').textContent = q ? `${palShown.length} ${palShown.length === 1 ? 'result' : 'results'}` : '';
  const again = palShown.findIndex((x) => x.id === keep);
  // Empty search starts on the first View; a typed search starts on the best-scoring enabled row.
  const first = q ? palShown.findIndex((x) => !x.disabled) : palShown.findIndex((x) => x.kind === 'View');
  setPaletteActive(again >= 0 ? again : first);
}
function setPaletteActive(i) {
  palActive = i;
  $('palList').querySelectorAll('.pal-opt').forEach((o, n) => o.setAttribute('aria-selected', String(n === i)));
  const opt = i >= 0 ? $('pal-opt-' + i) : null;
  if (opt) { $('palIn').setAttribute('aria-activedescendant', opt.id); opt.scrollIntoView({ block: 'nearest' }); }
  else $('palIn').removeAttribute('aria-activedescendant');
}
// Up/Down skip disabled rows and wrap around.
function movePalette(step) {
  const n = palShown.length;
  for (let k = 1; k <= n; k++) {
    const i = (((palActive < 0 ? (step > 0 ? -1 : 0) : palActive) + step * k) % n + n) % n;
    if (!palShown[i].disabled) return setPaletteActive(i);
  }
}
function runPaletteItem(x) {
  if (!x || x.disabled) return;
  closePalette();
  x.run();
}
function renderPaletteFoot() {
  const group = (keys, label) => h('span', {}, keycaps(keys), label);
  put($('palFoot'), group(['ArrowUp', 'ArrowDown'], 'Move'), group(['Enter'], 'Run'), group(['Escape'], 'Close'), group(PALETTE_KEYS, 'Toggle'),
    view === 'board' ? [h('span', { class: 'sep', 'aria-hidden': 'true' }), h('span', { text: 'Board' }),
      Object.entries(BOARD_KEYS).map(([action, keys]) => group(keys, BOARD_KEY_LABEL[action] ?? action))] : null);
}
function openPalette() {
  if (palOpen) return;
  palReturn = document.activeElement;
  const card = palReturn?.closest?.('.tcard[data-task-id]');
  palTask = card ? card.dataset.taskId : view === 'run' ? selTask : null;
  palOpen = true;
  hidePop();
  document.querySelector('aside').inert = document.querySelector('main').inert = true;
  $('palDialog').setAttribute('aria-modal', 'true');
  $('palette').hidden = false;
  $('palIn').value = '';
  palShown = []; palActive = -1;
  renderPalette(); renderPaletteFoot();
  $('palIn').focus();
}
function closePalette() {
  if (!palOpen) return;
  palOpen = false;
  $('palette').hidden = true;
  $('palDialog').removeAttribute('aria-modal');
  document.querySelector('aside').inert = document.querySelector('main').inert = false;
  const back = palReturn; palReturn = null;
  if (back?.isConnected && back !== document.body) back.focus();
}
const togglePalette = () => (palOpen ? closePalette() : openPalette());
put($('palKeys'), PALETTE_KEYS.map((k) => h('span', { class: 'kbd', text: k })));
$('palOpen').onclick = openPalette;
$('palIn').addEventListener('input', renderPalette);
$('palDialog').addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePalette(); }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); movePalette(e.key === 'ArrowDown' ? 1 : -1); }
  else if (e.key === 'Enter') { e.preventDefault(); runPaletteItem(palShown[palActive]); }
  else if (e.key === 'Tab') { e.preventDefault(); $('palIn').focus(); } // focus trap: the input is the only tab stop
});
// Clicking a row must not move focus out of the input; clicking the scrim closes.
$('palList').addEventListener('mousedown', (e) => e.preventDefault());
$('palette').addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) closePalette(); });
document.addEventListener('focusin', (e) => { if (palOpen && !$('palDialog').contains(e.target)) $('palIn').focus(); });

export { isPaletteKey, palOpen, renderPalette, togglePalette };
// </script>
