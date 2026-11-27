// <script>
// run.js: Run view (#v-run): task list, attempts table and event log, plus the Merge anyway and Cancel task
// panels that the Board and the palette also open.
// The first and last lines are markers the static UI tests read modules by; keep them.
import {
  $, STATUS, ago, announce, cancelRun, copyBtn, disclosure, emptyState, events, fmtClock, go, h, hhmmss, icon,
  isOpenTask, lamp, planFor, post, proj, put, refresh, retry, selTask, setRoute, short, sqlTime, state, statusEl,
  tasksOf, toast, view
} from './core.js';

// ----- Merge anyway: owner-only, only for tasks held by plan supersession; nothing is posted until the owner confirms -----
const SUPERSEDED_HOLD = 'plan superseded while in flight; owner decision needed';
const REVIEW_BLOCKED_HOLD = /^merge held:.*review_blocked/;
const isReviewBlocked = (t) => !!t && t.status === 'blocked' && REVIEW_BLOCKED_HOLD.test(t.hold_reason || '');
const canMergeAnyway = (t) => !!t && t.status === 'blocked' && (t.hold_reason === SUPERSEDED_HOLD || isReviewBlocked(t));
// Newest review row of a task; rows arrive oldest first, so a later row wins a created_at tie.
function latestReview(taskId) {
  let best = null;
  for (const r of state.reviews || []) if (r.task_id === taskId && (!best || String(r.created_at) >= String(best.created_at))) best = r;
  return best;
}
// The critical and high findings of the review for the task's current head: what Merge anyway overrides.
function overriddenFor(t) {
  const rows = (state.reviews || []).filter((r) => r.task_id === t.id && r.head_sha === t.head_sha);
  const r = rows.reduce((b, x) => (!b || String(x.created_at) >= String(b.created_at) ? x : b), null);
  return (r?.findings || []).filter((f) => f.severity === 'critical' || f.severity === 'high');
}
let mergeAnyway = null; // { taskId, busy, error }
function openMergeAnyway(t) {
  mergeAnyway = { taskId: t.id, busy: false, error: null };
  if (view === 'run' && selTask === t.id) renderRun(); else go({ view: 'run', selTask: t.id });
  document.querySelector('.guard [data-default]')?.focus();
}
function closeMergeAnyway() {
  mergeAnyway = null;
  renderRun();
  document.querySelector('#run [data-merge-anyway]')?.focus();
}
function mergeAnywayPanel(t, st) {
  const confirm = async () => {
    st.busy = true; st.error = null; renderRun();
    const ok = await post(`/api/tasks/${encodeURIComponent(t.id)}/merge-anyway`, {}, (m) => { st.error = m; });
    st.busy = false;
    const n = ok?.overriddenFindings?.length ?? 0, over = n ? `, overrode ${n} finding${n === 1 ? '' : 's'}` : '';
    if (ok) { mergeAnyway = null; toast(`Merged ${t.key} at ${short(ok.mergeSha)}${over}`); refresh(); }
    else renderRun();
  };
  const reviewHold = isReviewBlocked(t), over = reviewHold ? overriddenFor(t) : [];
  const checks = [
    'The pull request is still open',
    t.head_sha ? `The required check is green on this exact head, ${short(t.head_sha)}` : 'The required check is green on this exact head commit',
    'Every changed file is inside the task write scope',
    'The branch is up to date with the base branch',
  ];
  return h('div', { class: 'guard', role: 'alertdialog', 'aria-labelledby': 'maTitle', 'aria-describedby': 'maBody',
    onkeydown: (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMergeAnyway(); }
      else if (e.key === 'Enter' && !e.target.hasAttribute('data-confirm')) { e.preventDefault(); e.stopPropagation(); closeMergeAnyway(); }
    } },
    h('h2', { id: 'maTitle', text: `Merge ${t.key} anyway` }),
    h('p', { id: 'maBody', text: reviewHold
      ? 'The security review blocked this merge. Merging anyway overrides the findings below and skips only the review gate. Local still checks that'
      : 'The plan changed while this task was running. Merging anyway skips only the plan-approval check. Local still checks that' }),
    h('ul', {}, checks.map((c) => h('li', {}, h('span', { class: 'grow', text: c })))),
    reviewHold ? h('div', { 'data-override-findings': '' },
      h('p', { text: over.length ? `Findings this merge overrides (${over.length})` : 'No critical or high findings are recorded for this head' }),
      over.map(findingEl)) : null,
    st.error ? h('p', { class: 'note-bad', role: 'alert', 'data-merge-error': '', text: st.error }) : null,
    h('div', { class: 'acts' },
      h('button', { class: 'btn primary', 'data-default': '', onclick: closeMergeAnyway }, 'Cancel'),
      h('button', { class: 'btn danger', 'data-confirm': '', disabled: st.busy, onclick: confirm }, st.busy ? 'Merging' : 'Merge anyway')));
}

// ----- Cancel task: owner-only; opening the panel only previews (dryRun:true), nothing is cancelled until the owner confirms -----
// Mirrors NOT_CANCELLABLE in src/cancel.ts.
const canCancelTask = (t) => !!t && !['merged', 'merging', 'cancelled'].includes(t.status);
let cancelTask = null; // { taskId, busy, error, reroute, loading, preview, loadPreview }
function openCancelTask(t) {
  const st = { taskId: t.id, busy: false, error: null, reroute: true, loading: true, preview: null, seq: 0 };
  st.loadPreview = async () => {
    const seq = ++st.seq;
    st.loading = true; st.error = null; renderRun();
    const j = await post(`/api/tasks/${encodeURIComponent(t.id)}/cancel`, { dryRun: true, reroute: st.reroute }, (m) => { if (seq === st.seq) st.error = m; });
    if (seq !== st.seq || cancelTask !== st) return; // a newer request or a closed panel wins
    st.loading = false;
    if (j) st.preview = j;
    renderRun();
    if (document.activeElement === document.body) document.querySelector('.guard [data-default]')?.focus();
  };
  cancelTask = st;
  if (view === 'run' && selTask === t.id) renderRun(); else go({ view: 'run', selTask: t.id });
  document.querySelector('.guard [data-default]')?.focus();
  st.loadPreview();
}
function closeCancelTask() {
  if (cancelTask) cancelTask.seq++;
  cancelTask = null;
  renderRun();
  document.querySelector('#run [data-cancel-task]')?.focus();
}
function cancelTaskPanel(t, st) {
  const confirm = async () => {
    st.seq++; // drop any preview still in flight
    st.busy = true; st.error = null; renderRun();
    const ok = await post(`/api/tasks/${encodeURIComponent(t.id)}/cancel`, { dryRun: false, reroute: st.reroute }, (m) => { st.error = m; });
    st.busy = false;
    if (ok) { cancelTask = null; toast(`Cancelled ${t.key}`); refresh(); }
    else renderRun();
  };
  const pv = st.preview;
  const blocked = pv && !pv.cancellable;
  const deps = (a) => (a.length ? a.join(', ') : 'none');
  let body;
  if (blocked) body = h('p', { 'data-cancel-reason': '', text: pv.reason || `${t.key} cannot be cancelled` });
  else if (!pv) body = st.error ? null : h('p', { class: 'muted', text: 'Checking what depends on this task' });
  else {
    const list = pv.reroutes || [];
    body = [
      st.reroute
        ? (list.length
          ? [h('p', { text: `Dependents move to the tasks ${t.key} was waiting on` }),
            h('ul', { 'data-cancel-reroutes': '' }, list.map((r) => h('li', {}, h('span', { class: 'mono', text: r.key }), h('span', { class: 'arrow mono', text: `${deps(r.before)} → ${deps(r.after)}` }))))]
          : h('p', { text: 'No other tasks depend on this one' }))
        : h('p', { 'data-cancel-keep': '', text: `Dependents keep waiting on ${t.key}. Their dependencies stay as they are` }),
    ];
  }
  const opt = h('label', { class: 'opt' },
    h('input', { type: 'checkbox', 'data-reroute': '', checked: st.reroute, disabled: st.busy || blocked,
      onchange: (e) => { st.reroute = e.target.checked; st.loadPreview().then(() => document.querySelector('.guard [data-reroute]')?.focus()); } }),
    'Reroute dependents');
  return h('div', { class: 'guard', role: 'alertdialog', 'aria-labelledby': 'ctTitle', 'aria-describedby': 'ctBody', 'aria-busy': String(st.busy || st.loading),
    onkeydown: (e) => {
      if (e.target.matches?.('input')) { if (e.key === 'Escape' && !st.busy) { e.preventDefault(); e.stopPropagation(); closeCancelTask(); } return; }
      if (e.key === 'Escape' && !st.busy) { e.preventDefault(); e.stopPropagation(); closeCancelTask(); }
      else if (e.key === 'Enter' && !e.target.hasAttribute('data-confirm') && !st.busy) { e.preventDefault(); e.stopPropagation(); closeCancelTask(); }
    } },
    h('h2', { id: 'ctTitle', text: `Cancel ${t.key}` }),
    h('div', { id: 'ctBody', style: 'display:flex; flex-direction:column; gap:12px' }, body),
    blocked ? null : opt,
    st.error ? h('p', { class: 'note-bad', role: 'alert', 'data-cancel-error': '', text: st.error }) : null,
    h('div', { class: 'acts' },
      h('button', { class: 'btn primary', 'data-default': '', disabled: st.busy, onclick: closeCancelTask }, blocked ? 'Close' : 'Keep task'),
      blocked ? null : h('button', { class: 'btn danger', 'data-confirm': '', disabled: st.busy || st.loading || !pv, onclick: confirm }, st.busy ? 'Cancelling' : 'Cancel task')));
}

// ----- Run -----
function evText(e) {
  const d = e.d;
  switch (e.type) {
    case 'worker_output': return d.text;
    case 'task_claimed': return `${d.kind} attempt claimed`;
    case 'task_ready': return '';
    case 'worker_started': return `pid ${d.pid} · ${d.kind} · ${d.worker}${d.model ? ' · ' + d.model : ''}`;
    case 'worktree_ready': return `${d.path} · from ${short(d.baseSha)}`;
    case 'pr_published': return `PR #${d.pr} ${d.created ? 'opened' : 'updated'} at ${short(d.head)} · ${(d.files || []).join(', ')}`;
    case 'check_completed': return `${d.conclusion} on ${short(d.sha)} (check ${d.check})`;
    case 'repair_scheduled': return `check ${d.check} failed on ${short(d.sha)}`;
    case 'pr_merged': return `PR #${d.pr} merged as ${short(d.mergeSha)}, verifying`;
    case 'task_merged': return `verified ${short(d.mergeSha)}`;
    case 'branch_updated_from_base': return `branch updated, new head ${short(d.head)}`;
    case 'check_waiting':
    case 'task_blocked': return d.reason;
    case 'recovery_adopted_merge': return 'Recovered merge ' + String(d.mergeSha || '').slice(0, 8);
    case 'merge_followup_verification': return 'Verifying follow-up ' + String(d.sha || '').slice(0, 8);
    case 'owner_override_merge': return `Owner merged ${state.tasks.find((x) => x.id === d.taskId)?.key || 'task'} anyway at ${short(d.headSha)}`;
    case 'plan_auto_approved': { const v = planFor(d.planId)?.version; return `Plan${v != null ? ' v' + v : ''} auto-approved (project setting)`; }
    case 'auto_approve_halted': return `Auto-approve halted: ${d.reason}`;
    case 'auto_approve_resumed': return 'Auto-approve resumed';
    case 'owner_override_merge_failed': return `Merge anyway failed, nothing merged: ${d.error}`;
    case 'runner_error': return d.error;
    default: { const s = JSON.stringify(d); return s === '{}' ? '' : s; }
  }
}
// Values worth copying from one event, as [fullValue, label]; the log shows them shortened.
function evCopies(e) {
  const d = e.d, sha = (v, l) => (v ? [v, l] : null), pr = (n) => (n ? [String(n), 'PR number'] : null);
  switch (e.type) {
    case 'worker_output': return d.kind === 'command' ? [[d.text, 'command']] : [];
    case 'worktree_ready': return [d.path ? [d.path, 'worktree path'] : null, sha(d.baseSha, 'SHA')];
    case 'pr_published': return [pr(d.pr), sha(d.head, 'SHA')];
    case 'check_completed': case 'repair_scheduled': return [sha(d.sha, 'SHA')];
    case 'pr_merged': return [pr(d.pr), sha(d.mergeSha, 'SHA')];
    case 'task_merged': return [sha(d.mergeSha, 'SHA')];
    case 'owner_override_merge': return [pr(d.prNumber), sha(d.headSha, 'SHA')];
    case 'branch_updated_from_base': return [sha(d.head, 'SHA')];
    default: return [];
  }
}
// Run view: task list with search, and the attempt table helpers.
let taskQuery = '', runTasks = [], runNoTasks = null;
function renderTaskList(tasks, announceCount) {
  runTasks = tasks;
  const q = taskQuery.trim().toLowerCase();
  const shown = q ? tasks.filter((t) => `${t.title} ${t.key || ''}`.toLowerCase().includes(q)) : tasks;
  put($('tlist'), ...(shown.length ? shown.map((t) => h('button', { class: 'nav', 'aria-current': String(t.id === selTask), onclick: () => go({ selTask: t.id }) },
    lamp((STATUS[t.status] || [])[1], STATUS[t.status]?.[0] || t.status),
    h('span', { class: 'tmeta' }, h('span', { class: 'ellipsis', text: t.title }),
      h('span', { class: 'sub' }, h('span', { text: STATUS[t.status]?.[0] || t.status }), h('span', { class: 'mono ellipsis', text: t.model || 'default' }))),
    h('span', { class: 'mono muted', text: 'v' + (planFor(t.plan_id)?.version ?? '') })))
    : tasks.length ? [h('p', { class: 'muted', text: `No tasks match "${taskQuery.trim()}"` })]
    : [runNoTasks]));
  if (announceCount) announce(`${shown.length} of ${tasks.length} task${tasks.length === 1 ? '' : 's'} shown`);
}
$('tsearch').addEventListener('input', (e) => { taskQuery = e.target.value; renderTaskList(runTasks, true); });
// Date plus time for the cell; the relative time rides on the tooltip.
function stampCell(s, cls) {
  const d = s ? sqlTime(s) : null;
  if (!d || !Number.isFinite(d.getTime())) return h('td', { class: 'mono t2', text: '–' });
  return h('td', { class: 'mono t2 ' + (cls || ''), title: ago(d), text: d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) });
}
// A PR link only when the project's forge_origin is a github.com repo; otherwise the number alone.
function prUrl(p, t) {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(p?.forge_origin || '');
  return m && t.pr_number ? `https://github.com/${m[1]}/pull/${t.pr_number}` : null;
}
function durText(a) {
  const s = sqlTime(a.started_at).getTime(), e = a.ended_at ? sqlTime(a.ended_at).getTime() : Date.now();
  if (!Number.isFinite(s) || !Number.isFinite(e)) return '–';
  const sec = Math.max(0, Math.floor((e - s) / 1000)), hrs = Math.floor(sec / 3600);
  return (a.ended_at ? '' : 'running ') + (hrs ? `${hrs}:${String(Math.floor(sec / 60) % 60).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}` : fmtClock(sec * 1000));
}
// Review and security output is untrusted text: h() props and kids only.
const MONO_BLOCK = 'white-space:pre-wrap; overflow-wrap:anywhere; margin:4px 0; padding:8px 12px; border:1px solid var(--line); border-radius:8px; background:var(--raised)';
function findingEl(f) {
  return h('div', { class: 'finding', style: 'display:flex; flex-direction:column; gap:4px; padding:12px 0; border-top:1px solid var(--line)' },
    h('div', { style: 'display:flex; align-items:center; gap:8px; flex-wrap:wrap' },
      h('span', { class: 'sev mono', 'data-sev': f.severity, style: 'padding:0 8px; border-radius:6px; background:var(--raised-2)', text: f.severity }),
      h('span', { class: 'mono t2', text: `${f.file}:${f.line}` }),
      h('span', { text: f.title })),
    f.evidence ? h('pre', { class: 'mono-block mono', style: MONO_BLOCK, text: f.evidence }) : null,
    f.fix ? h('p', { class: 't2', style: 'margin:0', text: `Fix: ${f.fix}` }) : null);
}
function reviewSection(t) {
  const r = latestReview(t.id);
  if (!r) return h('section', { 'data-review': '' }, h('h2', { text: 'Review' }), emptyState(null, 'No security review has run for this task'));
  const fs = r.findings || [];
  return h('section', { 'data-review': '' }, h('h2', { text: 'Review' }),
    h('div', { class: 'facts' }, h('span', { class: 'mono', text: r.status }), h('span', { class: 'mono t2', text: r.model || 'default' }),
      h('span', { class: 't2', 'data-review-head': '', text: r.head_sha === t.head_sha ? `Matches the current head ${short(r.head_sha)}` : `Reviewed ${short(r.head_sha)}, not the current head` })),
    fs.length ? fs.map(findingEl) : h('p', { class: 'muted', text: 'The review recorded no findings' }));
}
function securitySection(t, atts) {
  return h('section', { 'data-security': '' }, h('h2', { text: 'Security' }),
    atts.length ? atts.map((a, i) => {
      const s = a.security, label = `${i + 1} · ${a.kind}`;
      if (!s) return h('div', { class: 'facts' }, h('span', { class: 'mono', text: label }), h('span', { class: 'muted', text: 'The audit is not available for this attempt' }));
      const evs = s.events || [];
      return h('div', { style: 'display:flex; flex-direction:column; gap:4px; padding:8px 0' },
        h('div', { class: 'facts' }, h('span', { class: 'mono', text: label }),
          h('span', { class: 'mono t2', text: `${s.deniedAttempts} denied` }), h('span', { class: 'mono t2', text: `${s.networkCommands} network commands` })),
        evs.map((e) => h('div', {}, h('pre', { class: 'mono-block mono', style: MONO_BLOCK, text: e.command }),
          h('span', { class: 't2', text: `${e.tool}: ${e.reason}` }))));
    }) : h('p', { class: 'muted', text: 'No attempts to audit yet' }));
}
function renderRun() {
  const p = proj();
  const tasks = tasksOf(p.id).filter((t) => t.status !== 'cancelled' || t.id === selTask)
    .sort((a, b) => Number(isOpenTask(b)) - Number(isOpenTask(a)) || b.plan_id - a.plan_id);
  if (!tasks.some((t) => t.id === selTask)) setRoute({ selTask: (tasks.find((t) => t.status === 'running') || tasks[0])?.id ?? null });
  runNoTasks = emptyState('Tasks', 'No plan has been approved, so there are no tasks', { label: 'Open plan', icon: 'plan', onclick: () => go({ view: 'plan' }) });
  renderTaskList(tasks);
  const t = state.tasks.find((x) => x.id === selTask);
  const runEl = $('run');
  if (!t) return put(runEl, emptyState('Run', 'No task is selected because no plan has been approved', { label: 'Open plan', icon: 'plan', onclick: () => go({ view: 'plan' }) }));
  const old = runEl.querySelector('.log'), sameTask = runEl.dataset.task === t.id;
  const atEnd = !old || !sameTask || old.scrollHeight - old.scrollTop - old.clientHeight < 40, keep = old?.scrollTop ?? 0;
  const atts = state.attempts.filter((a) => a.task_id === t.id);
  const active = atts.find((a) => a.status === 'running');
  const evs = events.filter((e) => e.task_id === t.id);
  const log = h('div', { class: 'log' }, evs.length ? evs.map((e) => h('div', { class: 'ln' + (e.type === 'worker_output' ? ' out' : '') },
    h('span', { class: 'muted', text: hhmmss(new Date(e.ts)) }), h('span', { class: 'ty ellipsis', text: e.type === 'worker_output' ? e.d.kind : e.type.replace(/_/g, ' ') }), h('span', { class: 'tx' }, evText(e), evCopies(e).map((c) => c && copyBtn(c[0], c[1])))))
    : emptyState(null, ['queued', 'running'].includes(t.status)
      ? 'This task has not produced any events yet; its steps will be listed here as they happen'
      : 'No events were recorded for this attempt'));
  runEl.dataset.task = t.id;
  put(runEl, 
    h('div', { style: 'display:flex; align-items:center; gap:16px' }, h('h1', { class: 'grow', style: 'overflow-wrap:anywhere', text: t.title }),
      t.status === 'blocked' && !t.merge_sha ? h('button', { class: 'btn', onclick: () => retry(t) }, icon('retry'), 'Retry task') : null,
      t.status === 'blocked' && t.merge_sha ? h('button', { class: 'btn', onclick: () => retry(t) }, icon('retry'), 'Retry verification') : null,
      t.status === 'blocked' && t.merge_sha ? h('button', { class: 'btn', onclick: async () => {
        if (window.confirm('Verify the current base after your follow-up? Dependent tasks can start if CI passes.') &&
            await post('/api/tasks/' + encodeURIComponent(t.id) + '/verify-base')) refresh();
      } }, 'Verify follow-up on base') : null,
      canMergeAnyway(t) && mergeAnyway?.taskId !== t.id ? h('button', { class: 'btn', 'data-merge-anyway': '', onclick: () => openMergeAnyway(t) }, icon('ship'), 'Merge anyway') : null,
      active ? h('button', { class: 'btn ghost', onclick: () => cancelRun(active) }, icon('x'), 'Cancel run') : null,
      canCancelTask(t) && cancelTask?.taskId !== t.id ? h('button', { class: 'btn ghost', 'data-cancel-task': '', onclick: () => openCancelTask(t) }, icon('x'), 'Cancel task') : null),
    h('div', { class: 'facts' }, statusEl(t.status),
      t.pr_number ? h('span', { class: 'mono' }, `PR #${t.pr_number}`, copyBtn(t.pr_number, 'PR number')) : null,
      t.repair_count ? h('span', { class: 'mono', text: `${t.repair_count} repair${t.repair_count > 1 ? 's' : ''}` }) : null),
    h('p', { class: 'run-model', 'data-run-model': '' }, 'Model ', h('span', { class: 'mono', text: t.model || 'default' }), t.model_why ? ` · ${t.model_why}` : null),
    t.hold_reason && t.status !== 'merged' ? h('p', { class: t.status === 'blocked' ? 'hold' : 't2', text: t.hold_reason }) : null,
    canMergeAnyway(t) && mergeAnyway?.taskId === t.id ? mergeAnywayPanel(t, mergeAnyway) : null,
    cancelTask?.taskId === t.id ? cancelTaskPanel(t, cancelTask) : null,
    atts.length ? h('div', { class: 'card atable', role: 'region', 'aria-label': 'Attempts', tabindex: '0' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Attempt', 'Status', 'Exit', 'Started', 'Finished', 'Duration', 'Model', 'Reason', 'PR'].map((x) => h('th', { text: x })))),
      h('tbody', {}, atts.map((a, i) => h('tr', {},
        h('td', { class: 'mono', text: `${i + 1} · ${a.kind}` }),
        h('td', {}, h('span', { class: 'status' }, lamp(a.status === 'running' ? 'live' : a.status === 'succeeded' ? 'ok' : ['failed', 'uncertain'].includes(a.status) ? 'bad' : ''), a.status[0].toUpperCase() + a.status.slice(1))),
        h('td', { class: 'mono', text: a.exit_code ?? '–' }), stampCell(a.started_at), stampCell(a.ended_at),
        h('td', { class: 'mono t2', text: durText(a) }),
        h('td', { class: 'mono t2', text: a.model || t.model || 'default' }),
        h('td', { class: 't2 why', text: ['failed', 'uncertain'].includes(a.status) || t.status === 'blocked' ? (a.reason || '') : '' }),
        h('td', { class: 'mono' }, t.pr_number ? (prUrl(p, t) ? h('a', { href: prUrl(p, t), target: '_blank', rel: 'noopener noreferrer', text: `#${t.pr_number}` }) : `#${t.pr_number}`) : '–')))))) : null,
    reviewSection(t), securitySection(t, atts),
    h('h2', { text: 'Activity log' }), log,
    disclosure('run:' + t.id, 'Git details', null,
      h('div', { class: 'facts mono' }, h('span', {}, t.branch, copyBtn(t.branch, 'branch name')),
        t.head_sha ? h('span', {}, 'Head ' + short(t.head_sha), copyBtn(t.head_sha, 'SHA')) : null,
        t.merge_sha ? h('span', {}, 'Merge ' + short(t.merge_sha), copyBtn(t.merge_sha, 'SHA')) : null), 'run-meta'));
  log.scrollTop = atEnd ? log.scrollHeight : keep;
}

export {
  SUPERSEDED_HOLD, canCancelTask, canMergeAnyway, cancelTask, closeCancelTask, closeMergeAnyway, mergeAnyway,
  openCancelTask, openMergeAnyway, renderRun, stampCell
};
// </script>
