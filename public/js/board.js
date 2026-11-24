// <script>
// board.js: Board view (#v-board): status columns by plan or wave, filters, task cards, keyboard moves and the
// card detail popover.
// The first and last lines are markers the static UI tests read modules by; keep them.
import {
  $, INFO_OF, STATUS, activity, ago, cancelRun, emptyState, events, fmtClock, go, h, holdText, icon, infoBtn,
  isOpenTask, lamp, needsApproval, planningFor, plansOf, proj, put, reducedMotion, retry, segBar, selTask, short,
  sqlTime, state, tally, tasksOf, togglePause, usageWaiting, view
} from './core.js';
import { levels } from './plan.js';
import { canCancelTask, canMergeAnyway, openCancelTask, openMergeAnyway } from './run.js';
import { pushAll } from './ship.js';

// ----- Board: status columns x swimlanes (by plan, by dependency wave, or none) -----
const COLUMNS = [['Waiting', ['pending']], ['Ready', ['ready']], ['Running', ['running']], ['Checks', ['waiting_ci', 'merging']], ['Held', ['blocked']], ['Merged', ['merged']]];
// One muted line for a column with no cards.
const EMPTY_COPY = { Waiting: 'Nothing waiting', Ready: 'Nothing ready to start', Running: 'Nothing running', Checks: 'No checks in progress', Held: 'Nothing held', Merged: 'Nothing merged yet' };
const emptyCell = (label) => h('div', { class: 'cell-empty', text: EMPTY_COPY[label] });
let boardGroup = 'plan';
// Filter chips. Needs me = held cards (blocked, or a hold with a fix to offer); Merged today = merged since local midnight.
const BOARD_FILTERS = [
  ['all', 'All', () => true],
  ['needs', 'Needs me', (t) => t.status === 'blocked' || (t.status !== 'merged' && !!t.hold_reason && !!holdSummary(t).action)],
  ['running', 'Running', (t) => COLUMNS.find(([label]) => label === 'Running')[1].includes(t.status)],
  ['today', 'Merged today', (t) => t.status === 'merged' && sqlTime(t.updated_at).toDateString() === new Date().toDateString()],
];
const boardFilters = new Map();
const filterKey = (pid) => 'vizor.boardFilter.' + pid;
function boardFilterOf(pid) {
  if (!boardFilters.has(pid)) {
    let v = null;
    try { v = localStorage.getItem(filterKey(pid)); } catch { /* storage unavailable */ }
    boardFilters.set(pid, BOARD_FILTERS.some(([k]) => k === v) ? v : 'all');
  }
  return boardFilters.get(pid);
}
function setBoardFilter(pid, key) {
  boardFilters.set(pid, key);
  try { localStorage.setItem(filterKey(pid), key); } catch { /* storage unavailable */ }
}
const laneOpen = new Map(), mergedAll = new Set();
const MERGED_CAP = 4;
function boardLanes(plans, all) {
  if (boardGroup === 'none') return [{ id: 'all', label: '', sub: '', tasks: all, open: true }];
  return plans.flatMap((plan) => {
    const tasks = all.filter((t) => t.plan_id === plan.id);
    if (!tasks.length) return [];
    let summary = ''; try { summary = JSON.parse(plan.body).summary || ''; } catch { /* none */ }
    if (boardGroup === 'plan') return [{ id: 'plan:' + plan.id, label: 'Plan v' + plan.version, sub: summary, tasks, open: tasks.some(isOpenTask) }];
    const levelsByTask = levels(JSON.parse(plan.body).tasks), waves = [];
    for (const item of tasks) (waves[levelsByTask.get(item.key) ?? 0] ??= []).push(item);
    return waves.flatMap((items, wave) => items ? [{ id: 'wave:' + plan.id + ':' + wave, label: `Plan v${plan.version} / Wave ${wave + 1}`, sub: wave ? `After wave ${wave}` : 'Starts first', tasks: items, open: items.some(isOpenTask) }] : []);
  });
}
function renderBoard() {
  const p = proj(), plans = plansOf(p.id).filter((plan) => plan.status !== 'draft');
  const all = tasksOf(p.id).filter((t) => t.status !== 'cancelled');
  const seg = all.length ? h('div', { class: 'seg words', role: 'group', 'aria-label': 'Group tasks' },
    [['plan', 'By plan'], ['wave', 'By wave'], ['none', 'No grouping']].map(([key, label]) =>
      h('button', { 'aria-pressed': String(boardGroup === key), onclick: () => {
        boardGroup = key;
        renderBoard();
        $('v-board').querySelector('[aria-pressed="true"]')?.focus();
      }, text: label }))) : null;
  const c = tally(all), fKey = boardFilterOf(p.id), fDef = BOARD_FILTERS.find(([k]) => k === fKey);
  const shown = all.filter(fDef[2]);
  const chips = all.length ? h('div', { class: 'seg words filters', role: 'group', 'aria-label': 'Filter tasks' },
    BOARD_FILTERS.map(([key, label, test]) =>
      h('button', { 'aria-pressed': String(fKey === key), onclick: () => {
        setBoardFilter(p.id, key);
        renderBoard();
        $('v-board').querySelector('.filters [aria-pressed="true"]')?.focus();
      } }, label, h('span', { class: 'n', text: String(key === 'all' ? all.length : all.filter(test).length) })))) : null;
  const header = h('div', { class: 'board-head' }, h('h1', { text: 'Board' }), seg, chips, h('span', { class: 'grow' }),
    h('button', { class: 'btn', onclick: togglePause }, icon(p.paused ? 'play' : 'pause'), p.paused ? 'Resume dispatch' : 'Pause dispatch'),
    all.length ? h('span', { class: 'mono muted', text: `${c.merged} of ${all.length} merged · ${c.running} of ${p.max_workers} workers` }) : null);
  if (!all.length) {
    forgetBoardColumns();
    const approval = needsApproval(p.id);
    const why = approval ? 'A plan is waiting for your approval, so there are no cards yet' : planningFor(p.id) ? 'A plan is being drafted, so there are no cards yet'
      : plans.length ? 'Every task in the approved plans was cancelled' : 'No plan has been approved, so there are no cards yet';
    const empty = emptyState('Board', why, { label: approval ? 'Review plan' : 'Open plan', icon: 'plan', onclick: () => go({ view: 'plan' }) });
    empty.classList.add('board-empty');
    return put($('v-board'), header, empty);
  }
  if (!shown.length) {
    forgetBoardColumns();
    const empty = emptyState(`Board, ${fDef[1]}`, `No task matches the ${fDef[1]} filter right now`, { label: 'Show all', onclick: () => {
      setBoardFilter(p.id, 'all');
      renderBoard();
      $('v-board').querySelector('.filters [aria-pressed="true"]')?.focus();
    } });
    empty.classList.add('board-empty');
    return put($('v-board'), header, empty);
  }
  const lanes = boardLanes(plans, shown);
  const openTask = (t) => ({ role: 'button', tabindex: '0', onclick: () => go({ view: 'run', selTask: t.id }),
    onkeydown: (e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); go({ view: 'run', selTask: t.id }); } } });
  const mini = (t) => h('div', { class: 'tcard mini', 'data-task': t.id, 'data-task-id': t.id, 'data-col': 'Merged', ...openTask(t) }, lamp('ok'), h('span', { class: 'ttl', title: t.pr_number ? `${t.title} (PR #${t.pr_number})` : t.title, text: t.title }),
    h('div', { class: 'mmeta mono' }, modelChip(t), t.pr_number != null ? h('span', { class: 'merged-label', text: mergedLabel(t) }) : null));
  const before = snapshotBoardCards(p.id);
  put($('v-board'), header,
    h('div', { class: 'kanban' },
      COLUMNS.map(([label, states]) => {
        const n = shown.filter((t) => states.includes(t.status)).length;
        const info = { Checks: 'checks', Held: 'held' }[label];
        return h('div', { class: 'khead', 'data-col': label }, h('span', { class: 'khl' }, label, info ? infoBtn(info) : null),
          h('span', { class: 'mono muted', title: label === 'Running' ? 'Running now / worker limit' : null, text: label === 'Running' ? `${n} / ${p.max_workers}` : String(n) }));
      }),
      lanes.map((lane) => {
        const open = laneOpen.get(lane.id) ?? lane.open, lc = tally(lane.tasks);
        return [
          lane.label ? h('button', { class: 'lane-head', 'data-lane': lane.id, 'aria-expanded': String(open), onclick: () => {
            laneOpen.set(lane.id, !open);
            renderBoard();
            [...$('v-board').querySelectorAll('[data-lane]')].find((node) => node.dataset.lane === lane.id)?.focus();
          } }, icon('chev'), lamp(...(lc.running ? ['live', 'Running'] : lc.merged === lane.tasks.length ? ['ok', 'All merged'] : lc.held ? ['bad', 'Has held tasks'] : ['', 'In progress'])),
          h('span', { class: 'lname', text: lane.label }), h('span', { class: 'grow ellipsis t2', text: lane.sub }),
          segBar(lc), h('span', { class: 'mono muted cnt', text: `${lc.merged} / ${lane.tasks.length}` })) : null,
          open ? COLUMNS.map(([label, states]) => {
            const ts = lane.tasks.filter((t) => states.includes(t.status));
            const none = ts.length === 0 ? ' is-empty' : '';
            if (label !== 'Merged') return h('div', { class: 'cell' + none, 'data-cell': lane.id + '|' + label, 'data-label': label }, ts.length ? ts.map((t) => { const card = taskCard(t); card.dataset.col = label; return card; }) : emptyCell(label));
            ts.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
            const every = mergedAll.has(lane.id), extra = ts.length - MERGED_CAP;
            return h('div', { class: 'cell' + none, 'data-cell': lane.id + '|' + label, 'data-label': label }, ts.length ? (every ? ts : ts.slice(0, MERGED_CAP)).map(mini) : emptyCell(label),
              extra > 0 ? h('button', { class: 'btn ghost more', onclick: () => { if (every) mergedAll.delete(lane.id); else mergedAll.add(lane.id); renderBoard(); }, text: every ? 'Show fewer' : `Show ${extra} more` }) : null);
          }) : null,
        ];
      })));
  animateColumnChanges(p.id, before);
}
// Column-change motion. taskCols remembers the column each task was last rendered in; the first render of a project animates nothing.
const taskCols = new Map(), pulsedIds = new Set();
let boardProject = null;
function forgetBoardColumns() { taskCols.clear(); boardProject = null; }
function snapshotBoardCards(pid) {
  const before = new Map();
  if (boardProject !== pid || reducedMotion.matches) return before;
  for (const card of $('v-board').querySelectorAll('.tcard[data-task-id]')) {
    const cell = card.closest('[data-cell]');
    if (!cell) continue;
    const r = card.getBoundingClientRect(), c = cell.getBoundingClientRect();
    before.set(card.dataset.taskId, { clone: card.cloneNode(true), cell: cell.dataset.cell,
      top: r.top - c.top - cell.clientTop, left: r.left - c.left - cell.clientLeft, width: r.width, height: r.height });
  }
  return before;
}
function animateColumnChanges(pid, before) {
  const first = boardProject !== pid, still = reducedMotion.matches, next = new Map();
  boardProject = pid;
  for (const card of $('v-board').querySelectorAll('.tcard[data-task-id]')) {
    const id = card.dataset.taskId, col = card.dataset.col, prev = taskCols.get(id);
    next.set(id, col);
    if (first || still || prev == null || prev === col) continue;
    const old = before.get(id), cell = old && [...$('v-board').querySelectorAll('[data-cell]')].find((n) => n.dataset.cell === old.cell);
    if (cell) {
      const ghost = old.clone;
      for (const a of ['data-task-id', 'data-task', 'tabindex', 'role']) ghost.removeAttribute(a);
      ghost.setAttribute('aria-hidden', 'true');
      ghost.classList.add('ghost');
      Object.assign(ghost.style, { top: old.top + 'px', left: old.left + 'px', width: old.width + 'px', height: old.height + 'px' });
      ghost.addEventListener('animationend', () => ghost.remove());
      setTimeout(() => ghost.remove(), 400);
      cell.append(ghost);
    }
    card.classList.add('col-in');
    if (col === 'Merged' && !pulsedIds.has(id)) { pulsedIds.add(id); card.querySelector('.lamp')?.classList.add('pulse'); }
  }
  taskCols.clear();
  for (const [id, col] of next) taskCols.set(id, col);
}
// A held task's summary, or null when the task is not held. Shared by the card and the r shortcut.
const heldOf = (t) => (t && t.status !== 'merged' && (t.status === 'blocked' || t.hold_reason) ? holdSummary(t) : null);
// Model chip: the planner's pick, or 'default' when none. The reason rides on the tooltip and the aria-label; the chip is focusable so keyboard users can reach it.
function modelChip(t) {
  const model = t.model || 'default';
  const why = t.model_why ? String(t.model_why) : '';
  return h('span', { class: 'mchip mono', tabindex: '0', role: 'note', title: why || null,
    'aria-label': why ? `Model ${model}: ${why}` : `Model ${model}`, text: model });
}
// Merged label from the task's updated_at (set when the task merged); the PR number alone when there is no timestamp.
function mergedLabel(t) {
  const when = t.updated_at ? sqlTime(t.updated_at) : null;
  const pr = `PR #${t.pr_number}`;
  return when && Number.isFinite(when.getTime()) ? `${pr} · merged ${ago(when)}` : pr;
}
// PR number as a link to GitHub when the project's forge is github and the repo slug is safe; null otherwise (plain number).
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
function prUrl(p, n) {
  const f = p && p.forge;
  if (!f || f.kind !== 'github' || typeof f.repo !== 'string' || !REPO_RE.test(f.repo)) return null;
  const parts = f.repo.split('/');
  if (parts.some((s) => s === '.' || s === '..')) return null;
  const num = Number(n);
  if (!Number.isInteger(num) || num <= 0) return null;
  return `https://github.com/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}/pull/${num}`;
}
function prRef(p, t) {
  const url = prUrl(p, t.pr_number);
  if (!url) return h('span', { text: `#${t.pr_number}` });
  return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', title: `Open PR #${t.pr_number} on GitHub`, onclick: (e) => e.stopPropagation(), onkeydown: (e) => e.stopPropagation(), text: `#${t.pr_number}` });
}
// Review shield for a card with a PR: the review recorded for this exact head SHA, pending when there is none.
function shieldFor(p, t) {
  if (!t.pr_number || (p && p.review_gate === 'off')) return null;
  const review = (state.reviews || []).find((r) => r.task_id === t.id && r.head_sha === t.head_sha);
  const status = review ? review.status : 'pending';
  const count = review && Array.isArray(review.findings) ? review.findings.length : 0;
  const [tone, label] = status === 'passed' ? ['ok', 'Review passed']
    : status === 'blocked' ? ['bad', `${count} finding${count === 1 ? '' : 's'}`]
    : status === 'failed' ? ['bad', 'Review failed'] : ['pending', 'Review pending'];
  const full = status === 'blocked' ? `Security review blocked: ${label}` : label;
  return h('span', { class: 'shield', 'data-tone': tone, 'aria-label': full, title: full, role: 'note', text: label });
}
function taskCard(t) {
  const p = proj();
  const [, kind] = STATUS[t.status] || [];
  const attempts = state.attempts.filter((a) => a.task_id === t.id);
  const run = attempts.find((a) => a.status === 'running');
  // Running: the live attempt's start. Checks: when the last attempt ended (PR published), else last task update.
  let since = null;
  if (t.status === 'running' && run) since = sqlTime(run.started_at).getTime();
  else if (t.status === 'waiting_ci' || t.status === 'merging') {
    const ended = attempts.map((a) => a.ended_at).filter(Boolean).sort().pop();
    since = sqlTime(ended || t.updated_at).getTime();
  }
  if (Number.isNaN(since)) since = null;
  const held = heldOf(t);
  return h('div', { class: 'tcard', 'data-task': t.id, 'data-task-id': t.id, role: 'button', tabindex: '0', onclick: () => go({ view: 'run', selTask: t.id }), onkeydown: (e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); go({ view: 'run', selTask: t.id }); } } },
    h('div', { class: 'top' }, lamp(kind), h('span', { class: 'grow', style: 'font-weight:500; overflow-wrap:anywhere', text: t.title }), INFO_OF[t.status] ? infoBtn(INFO_OF[t.status]) : null),
    h('div', { class: 'meta mono' }, h('span', { class: 'ellipsis', text: t.key }), modelChip(t),
      attempts.length ? h('span', { text: `attempt ${attempts.length}` }) : null,
      t.repair_count > 0 ? h('span', { text: `${t.repair_count} repair${t.repair_count > 1 ? 's' : ''}` }) : null,
      t.pr_number ? prRef(p, t) : null,
      shieldFor(p, t),
      since ? h('span', { class: 'el', 'data-since': String(since), text: fmtClock(Date.now() - since) }) : null,
      t.merge_sha || t.head_sha ? h('span', { text: short(t.merge_sha || t.head_sha) }) : null),
    run ? h('div', { class: 'act mono', 'data-act': t.id, title: activity.get(t.id) || null, text: activity.get(t.id) || '' }) : null,
    held ? h('p', { class: 'cause', title: t.hold_reason || held.cause, text: held.cause }) : null,
    held && held.action ? h('div', {}, h('button', { class: 'btn', onclick: (e) => { e.stopPropagation(); held.action.run(); } }, icon(held.action.icon), held.action.label)) : null,
    canMergeAnyway(t) ? h('div', {}, h('button', { class: 'btn ghost', onclick: (e) => { e.stopPropagation(); openMergeAnyway(t); } }, icon('ship'), 'Merge anyway')) : null,
    run ? h('div', {}, h('button', { class: 'btn ghost', onclick: (e) => { e.stopPropagation(); cancelRun(run); } }, icon('x'), 'Cancel run')) : null,
    canCancelTask(t) ? h('div', {}, h('button', { class: 'btn ghost', onclick: (e) => { e.stopPropagation(); openCancelTask(t); } }, icon('x'), 'Cancel task')) : null);
}
// A held task's short cause and its one fix. Patterns mirror the hold_reason strings written by src/runner.ts and src/plan.ts.
function holdSummary(t) {
  const raw = String(t.hold_reason || '').trim();
  const openRun = { label: 'Open run', icon: 'run', run: () => go({ view: 'run', selTask: t.id }) };
  const retryA = { label: 'Retry', icon: 'retry', run: () => retry(t) };
  const reviewPlan = { label: 'Review plan', icon: 'plan', run: () => go({ view: 'plan' }) };
  const pushNow = { label: 'Push now', icon: 'ship', run: pushAll };
  if (t.usage_retry_at) return { cause: holdText(t), action: usageWaiting(t) ? openRun : retryA };
  // Waiting on the runner itself, nothing for the owner to do
  if (t.status !== 'blocked' && /^(waiting on |scope overlaps |forge unavailable)/.test(raw)) {
    return { cause: raw.startsWith('waiting on') ? 'Waiting on other tasks' : raw.startsWith('scope') ? 'Waiting on an overlapping task' : 'GitHub unavailable, will retry', action: null };
  }
  const rules = [
    [/^merge held:.*plan_not_approved/, 'Plan not approved', reviewPlan],
    [/^merge held:.*review_blocked/, 'Security review blocked', openRun],
    [/^merge held/, 'Merge held by a safety check', retryA],
    [/^plan superseded/, 'Plan changed while running', reviewPlan],
    [/^out-of-scope changes not published/, 'Changes outside task scope', reviewPlan],
    [/^update produced out-of-scope/, 'Update touched files outside scope', openRun],
    [/^conflict with /, 'Merge conflict with base branch', openRun],
    [/^Claude account needs attention/, 'Claude sign-in needed', retryA],
    [/^uncertain process state/, 'Interrupted by a restart', retryA],
    [/^attempt cancelled by user/, 'Run cancelled', retryA],
    [/^runner error/, 'Runner error', retryA],
    [/^CI infrastructure kept failing/, 'CI infrastructure failing', retryA],
    [/^CI still failing/, 'CI still failing after repairs', openRun],
    [/^no new commit since CI failed|made no new commit; CI still failing/, 'Repair made no new commit', openRun],
    [/^post-merge check/, 'Post-merge check failed', openRun],
    [/^worker produced no changes/, 'Worker made no changes', openRun],
    [/^worker exited/, 'Worker exited with an error', openRun],
    [/push/i, 'Push to GitHub failed', pushNow],
  ];
  for (const [re, cause, action] of rules) if (re.test(raw)) return { cause, action };
  return { cause: raw.split('\n')[0] || 'Held, no reason recorded', action: openRun };
}

// Board shortcuts: one map from action to keys, so a command palette can render keycaps from it.
const BOARD_KEYS = Object.freeze({
  up: ['ArrowUp', 'k'], down: ['ArrowDown', 'j'], left: ['ArrowLeft'], right: ['ArrowRight'],
  open: ['Enter'], retry: ['r'], back: ['Escape'],
});
const boardKeyAction = (key) => Object.keys(BOARD_KEYS).find((a) => BOARD_KEYS[a].includes(key)) ?? null;
const boardCards = () => [...$('v-board').querySelectorAll('.tcard[data-task-id]')].filter((c) => c.offsetParent !== null);
// Up/down stay in the column across lanes; left/right jump to the nearest card by height in the next column that has any.
function moveBoardFocus(card, action) {
  const cards = boardCards();
  if (!card) return cards[0]?.focus();
  if (action === 'up' || action === 'down') {
    const same = cards.filter((c) => c.dataset.col === card.dataset.col);
    return same[same.indexOf(card) + (action === 'down' ? 1 : -1)]?.focus();
  }
  const cols = COLUMNS.map(([label]) => label), step = action === 'right' ? 1 : -1;
  const mid = (c) => { const r = c.getBoundingClientRect(); return r.top + r.height / 2; };
  const y = mid(card);
  for (let i = cols.indexOf(card.dataset.col) + step; i >= 0 && i < cols.length; i += step) {
    const there = cards.filter((c) => c.dataset.col === cols[i]);
    if (there.length) return there.reduce((a, b) => (Math.abs(mid(b) - y) < Math.abs(mid(a) - y) ? b : a)).focus();
  }
}
// Returns true when the key was a board shortcut and has been handled.
function boardKey(e) {
  const action = boardKeyAction(e.key);
  if (!action || e.defaultPrevented) return false;
  if (document.querySelector('dialog[open], [aria-modal="true"]')) return false;
  if (view === 'run') {
    if (action !== 'back' || !selTask) return false;
    const id = selTask;
    e.preventDefault();
    go({ view: 'board' });
    $('v-board').querySelector(`.tcard[data-task-id="${CSS.escape(id)}"]`)?.focus();
    return true;
  }
  if (view !== 'board' || $('v-board').hidden) return false;
  const card = e.target.closest?.('.tcard[data-task-id]') ?? null;
  // Only the card itself or an unfocused page; buttons and chips keep their own keys.
  if (!card && e.target !== document.body) return false;
  if (action === 'back') return false;
  if (action === 'open' || action === 'retry') {
    if (!card || e.repeat) return false;
    e.preventDefault();
    if (action === 'open') go({ view: 'run', selTask: card.dataset.taskId });
    else { const held = heldOf(state.tasks.find((t) => t.id === card.dataset.taskId)); if (held?.action?.icon === 'retry') held.action.run(); }
    return true;
  }
  e.preventDefault();
  moveBoardFocus(card, action);
  return true;
}
// One timer updates every visible elapsed label in place; it does nothing when none are on screen.
setInterval(() => {
  const labels = document.querySelectorAll('.tcard .el[data-since]');
  if (!labels.length || document.hidden) return;
  const now = Date.now();
  for (const el of labels) { const s = fmtClock(now - Number(el.dataset.since)); if (el.textContent !== s) el.textContent = s; }
}, 1000);
// ----- Card detail popover (Board) -----
const CHECK_LABEL = { success: ['Passed', 'ok'], failure: ['Failed', 'bad'], infra_error: ['CI error', 'bad'], cancelled: ['Cancelled', ''] };
const tcPop = h('div', { id: 'tcPop', role: 'tooltip', hidden: true });
document.body.append(tcPop);
let popCard = null, popTimer = 0;
const jsonList = (s) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
function lastCheck(t) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.task_id === t.id && e.type === 'check_completed') {
      const [label, kind] = CHECK_LABEL[e.d.conclusion] || [String(e.d.conclusion || '').replace(/_/g, ' '), 'wait'];
      return h('span', { class: 'status' }, lamp(kind), label, e.d.sha ? h('span', { class: 'mono muted', text: short(e.d.sha) }) : null);
    }
  }
  return t.status === 'waiting_ci' ? h('span', { class: 'status' }, lamp('wait'), 'Checks running') : h('span', { class: 'muted', text: 'No checks yet' });
}
function fillPop(t) {
  const scope = jsonList(t.write_scope), deps = jsonList(t.deps);
  const row = (label, ...body) => h('div', {}, h('div', { class: 'pk', text: label }), h('div', { class: 'pv' }, body));
  put(tcPop,
    row('Write scope', scope.length ? scope.map((g) => h('span', { class: 'mono', text: g })) : h('span', { class: 'muted', text: 'None' })),
    row('Depends on', deps.length ? deps.map((k) => {
      const d = state.tasks.find((x) => x.plan_id === t.plan_id && x.key === k);
      return d ? h('span', { class: 'status' }, lamp((STATUS[d.status] || [])[1]), h('span', { class: 'mono ellipsis', text: k }), h('span', { class: 'muted', text: STATUS[d.status]?.[0] || d.status }))
        : h('span', { class: 'mono', text: k });
    }) : h('span', { class: 'muted', text: 'Nothing' })),
    row('Last check', lastCheck(t)));
}
function hidePop() {
  clearTimeout(popTimer);
  popCard?.removeAttribute('aria-describedby');
  popCard = null;
  tcPop.classList.remove('show');
  tcPop.hidden = true;
}
function showPop(card) {
  const t = state.tasks.find((x) => x.id === card.dataset.task);
  if (!t || !card.isConnected) return hidePop();
  if (popCard && popCard !== card) popCard.removeAttribute('aria-describedby');
  popCard = card;
  card.setAttribute('aria-describedby', 'tcPop');
  fillPop(t);
  tcPop.hidden = false;
  const r = card.getBoundingClientRect(), pw = tcPop.offsetWidth, ph = tcPop.offsetHeight, vw = innerWidth, vh = innerHeight, gap = 8;
  // Right of the card, else left, else below it; always clamped inside the viewport.
  let x = r.right + gap;
  if (x + pw > vw - gap) x = r.left - gap - pw;
  if (x < gap) x = Math.min(Math.max(r.left, gap), vw - gap - pw);
  const y = Math.min(Math.max(r.top, gap), Math.max(gap, vh - gap - ph));
  tcPop.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  requestAnimationFrame(() => { if (popCard === card) tcPop.classList.add('show'); });
}
{
  const board = $('v-board'), cardOf = (n) => (n instanceof Element ? n.closest('.tcard[data-task]') : null);
  board.addEventListener('mouseover', (e) => {
    const card = cardOf(e.target);
    if (!card || card === cardOf(e.relatedTarget)) return;
    clearTimeout(popTimer);
    popTimer = setTimeout(() => showPop(card), 300);
  });
  board.addEventListener('mouseout', (e) => {
    const card = cardOf(e.target);
    if (!card || card === cardOf(e.relatedTarget)) return;
    // Keyboard focus keeps its popover while the pointer wanders off.
    if (card.contains(document.activeElement) && popCard === card) { clearTimeout(popTimer); return; }
    hidePop();
  });
  board.addEventListener('focusin', (e) => { const card = cardOf(e.target); if (card) { clearTimeout(popTimer); showPop(card); } });
  board.addEventListener('focusout', (e) => { if (cardOf(e.target) && !cardOf(e.relatedTarget)) hidePop(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !tcPop.hidden) hidePop(); });
  addEventListener('scroll', () => { if (!tcPop.hidden) hidePop(); }, true);
  addEventListener('resize', hidePop);
  // Board re-renders replace every card: drop the popover when its card is gone.
  new MutationObserver(() => { if (popCard && !popCard.isConnected) hidePop(); }).observe(board, { childList: true, subtree: true });
}

export { BOARD_KEYS, boardKey, hidePop, renderBoard };
// </script>
