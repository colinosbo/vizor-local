// <script>
// overview.js: Overview view (#v-overview): progress, workers, estimated finish, setup checklist and what needs you.
// The first and last lines are markers the static UI tests read modules by; keep them.
import {
  $, BUCKETS, ago, clockDay, emptyState, fmtDur, go, h, holdText, icon, infoBtn, isOpenTask, lamp, latestPlan,
  needsApproval, planningFor, plansOf, post, proj, projectStats, projectStatus, put, refresh, retry, retryMany,
  segBar, sqlTime, state, tally, tasksOf, toast, togglePause, usageWaiting
} from './core.js';
import { activePhases } from './plan.js';
import { SUPERSEDED_HOLD } from './run.js';
import { pushAll } from './ship.js';

// ----- Overview: progress, workers, ETA, what needs you -----
// Median time from a task's first attempt to its merge, over this project's merged tasks. Needs 3 samples.
function medianTaskMs(pid) {
  const first = new Map();
  for (const a of state.attempts) { const s = sqlTime(a.started_at).getTime(); if (Number.isFinite(s) && (!first.has(a.task_id) || s < first.get(a.task_id))) first.set(a.task_id, s); }
  const d = tasksOf(pid).filter((t) => t.status === 'merged').map((t) => sqlTime(t.updated_at).getTime() - (first.get(t.id) ?? NaN))
    .filter((x) => x >= 30000 && x <= 6 * 3600000).sort((a, b) => a - b);
  return { n: d.length, median: d.length >= 3 ? d[Math.floor(d.length / 2)] : null };
}
// Longest chain of unmerged tasks that must run one after another.
function chainLeft(pid) {
  const open = tasksOf(pid).filter(isOpenTask), by = new Map(open.map((t) => [t.plan_id + ':' + t.key, t])), memo = new Map();
  const depth = (t, seen) => {
    const id = t.plan_id + ':' + t.key;
    if (memo.has(id)) return memo.get(id);
    if (seen.has(id)) return 1;
    seen.add(id);
    let ds = []; try { ds = JSON.parse(t.deps || '[]'); } catch { /* no deps */ }
    const v = 1 + Math.max(0, ...ds.map((k) => by.get(t.plan_id + ':' + k)).filter(Boolean).map((d) => depth(d, new Set(seen))));
    memo.set(id, v); return v;
  };
  return Math.max(0, ...open.map((t) => depth(t, new Set())));
}
function etaFor(p) {
  const open = tasksOf(p.id).filter(isOpenTask);
  if (!open.length) return { kind: 'done' };
  const { n, median } = medianTaskMs(p.id);
  if (median == null) return { kind: 'none', n };
  const w = Math.max(1, p.max_workers), rounds = Math.max(Math.ceil(open.length / w), chainLeft(p.id));
  const waits = open.filter(usageWaiting).map((t) => Number(t.usage_retry_at));
  const idle = !open.some((t) => ['running', 'waiting_ci', 'merging'].includes(t.status));
  const start = idle && waits.length ? Math.max(Date.now(), Math.min(...waits)) : Date.now();
  return { kind: 'eta', finish: start + rounds * median, median, n, needsYou: open.filter((t) => t.status === 'blocked' && !t.usage_retry_at).length };
}
const panel = (title, count, body, action) => h('section', { class: 'card panel' },
  h('div', { class: 'panel-head' }, h('h2', { class: 'grow', text: title }), action, count == null ? null : h('span', { class: 'mono muted', text: String(count) })), body);
// ----- First-run setup checklist -----
const autopushKey = (pid) => 'vizor.autopushChosen.' + pid;
function autopushChosen(pid) {
  try { return !!localStorage.getItem(autopushKey(pid)); } catch { return false; }
}
// Pure list of the six setup rows for a project. `fix` names the one action a failing row offers.
function setupRows(p) {
  const s = p && p.setup;
  if (!s) return [];
  return [
    { key: 'repo', label: 'Folder is a git repository', done: !!s.gitRepo, fix: 'readd',
      text: s.gitRepo ? 'The project folder has git history Local can branch from' : 'Local needs a git repository to branch and merge in' },
    { key: 'origin', label: 'Local origin exists', done: !!s.origin, fix: 'readd',
      text: s.origin ? 'Merges land in the local origin' : 'No local origin yet. Re-add the project and tick Create origin' },
    { key: 'tests', label: 'Test command set and passing on main', done: !!s.testCommand && s.testsPassOnMain === true, fix: 'config',
      text: !s.testCommand ? 'No test command is set, so merges are not checked' : s.testsPassOnMain === true ? 'The test command passes on main' : 'The test command does not pass on main yet' },
    { key: 'github', label: 'GitHub connected', done: !!s.githubConnected, fix: 'ship',
      text: s.githubConnected ? 'A GitHub repo is connected for pushing' : 'No GitHub repo is connected. Paste its URL in Ship' },
    { key: 'autopush', label: 'Auto-push chosen', done: !!s.autoPush || autopushChosen(p.id), fix: 'autopush',
      text: s.autoPush ? 'Merged work is pushed to GitHub automatically' : autopushChosen(p.id) ? 'You chose to push by hand' : 'Choose whether merged work is pushed to GitHub automatically' },
    { key: 'plan', label: 'First plan approved', done: !!s.planApproved, fix: 'plan',
      text: s.planApproved ? 'A plan has been approved' : 'Workers start once you approve a plan' },
  ];
}
function setupFix(row, p) {
  const btn = (text, fn) => h('button', { class: 'btn', onclick: fn }, text);
  if (row.fix === 'readd') return btn('Re-add with origin', () => {
    go({ view: 'projects' });
    $('aCreate').checked = true; $('aPath').value = p.repo_path; $('aPath').focus();
  });
  if (row.fix === 'config') return btn('Set test command', () => { go({ view: 'projects' }); $('sCi').focus(); });
  if (row.fix === 'ship') return btn('Open Ship', () => go({ view: 'ship' }));
  if (row.fix === 'plan') return btn('Open plan', () => go({ view: 'plan' }));
  return [
    btn('Turn on', async () => { if (await post(`/api/projects/${p.id}/config`, { autoPush: true })) { toast('Auto-push on'); refresh(); } }),
    h('button', { class: 'btn ghost', onclick: () => {
      try { localStorage.setItem(autopushKey(p.id), '1'); } catch { /* storage unavailable */ }
      renderOverview();
    } }, 'Keep off'),
  ];
}
// Returns null when there is nothing left to set up.
function renderSetupChecklist(p) {
  const rows = setupRows(p);
  if (!rows.length || rows.every((r) => r.done)) return null;
  return panel('Setup', `${rows.filter((r) => r.done).length} of ${rows.length}`, rows.map((r) => h('div', { class: 'srow' },
    lamp(r.done ? 'ok' : 'wait'),
    h('div', { class: 'sr-text' }, h('span', { text: r.label }), h('span', { text: r.text })),
    h('div', { class: 'sr-act' }, h('span', { class: 'mono muted', text: r.done ? 'Done' : 'To do' }), r.done ? null : setupFix(r, p)))));
}
function renderOverview() {
  const p = proj(), ts = tasksOf(p.id).filter((t) => t.status !== 'cancelled');
  const { c, total, pct } = projectStats(p), [stText, stKind] = projectStatus(p);
  const head = h('div', { class: 'ov-head' }, h('h1', { text: 'Overview' }), stText ? h('span', { class: 'status' }, lamp(stKind), stText) : null,
    h('span', { class: 'grow' }), h('span', { class: 'mono muted', text: p.auto_push ? 'Auto-push to GitHub on' : 'Auto-push off' }));
  if (!total) {
    const approval = needsApproval(p.id);
    return put($('v-overview'), h('div', { class: 'ov content-w' }, head, renderSetupChecklist(p), emptyState('Project progress',
      approval ? 'A plan is waiting for your approval, so no tasks exist yet' : planningFor(p.id) ? 'A plan is being drafted, so no tasks exist yet' : 'No plan has been approved, so no tasks exist yet',
      { label: approval ? 'Review plan' : 'Open plan', icon: 'plan', onclick: () => go({ view: 'plan' }) })));
  }
  const eta = etaFor(p), unplanned = activePhases(p.id).filter((x) => ['queued', 'drafting', 'review', 'failed'].includes(x.status)).length;
  const etaRef = eta.kind === 'eta'
    ? [`About ${clockDay(eta.finish)}`, `Median ${fmtDur(eta.median)} per task, from ${eta.n} merged`,
      eta.needsYou ? `Assumes ${eta.needsYou} held task${eta.needsYou === 1 ? ' is' : 's are'} retried` : null,
      unplanned ? `Not counting ${unplanned} roadmap phase${unplanned === 1 ? '' : 's'} not planned yet` : null]
    : eta.kind === 'none' ? [`Needs 3 merged tasks to estimate, ${eta.n} so far`] : [unplanned ? `${unplanned} roadmap phase${unplanned === 1 ? '' : 's'} not planned yet` : 'All tasks merged'];
  const hero = h('div', { class: 'card stat hero' }, h('span', { class: 'lbl', text: 'Done' }),
    h('span', { class: 'fig' }, `${pct}%`, h('small', { text: `${c.merged} of ${total} tasks merged` })), segBar(c),
    h('div', { class: 'legend' }, BUCKETS.filter(([k]) => c[k]).map(([k, label, kind]) => h('span', {}, lamp(kind === 'idle' ? '' : kind), label, h('span', { class: 'mono', text: String(c[k]) })))));
  const workers = h('div', { class: 'card stat' }, h('span', { class: 'lbl', text: 'Active workers' }),
    h('span', { class: 'fig' }, String(c.running), h('small', { text: `of ${p.max_workers}` })),
    h('span', { class: 'ref', text: p.paused ? 'Dispatch paused' : `${c.ready} ready, ${c.checks} in checks` }));
  const etaCard = h('div', { class: 'card stat' }, h('span', { class: 'lbl', text: 'Estimated finish' }),
    h('span', { class: 'fig', text: eta.kind === 'eta' ? fmtDur(eta.finish - Date.now()) : eta.kind === 'done' ? 'Done' : '—' }),
    etaRef.filter(Boolean).map((x) => h('span', { class: 'ref', text: x })));

  const planRows = plansOf(p.id).filter((pl) => pl.status !== 'draft').map((pl) => {
    const pts = ts.filter((t) => t.plan_id === pl.id); if (!pts.length) return null;
    const pc = tally(pts); let summary = ''; try { summary = JSON.parse(pl.body).summary || ''; } catch { /* none */ }
    return h('button', { class: 'prow', onclick: () => go({ view: 'board' }) },
      h('span', { class: 'pr-name' }, h('span', { text: 'Plan v' + pl.version }), h('span', { class: 'muted ellipsis', text: summary })),
      segBar(pc), h('span', { class: 'mono t2', text: `${pc.merged} / ${pts.length}` }));
  }).filter(Boolean);
  const phases = activePhases(p.id).sort((a, b) => a.roadmap_id - b.roadmap_id || a.position - b.position);
  const PH = { done: ['Done', 'ok'], running: ['Running', 'live'], drafting: ['Drafting', 'live'], review: ['Review plan', 'wait'], queued: ['Queued', ''], failed: ['Failed', 'bad'] };
  const merged = ts.filter((t) => t.status === 'merged').sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, 5);

  const held = ts.filter((t) => t.status === 'blocked'), due = held.filter((t) => !usageWaiting(t));
  const approval = needsApproval(p.id) ? latestPlan(p.id) : null;
  const attn = [
    p.auto_push_error ? h('div', { class: 'attn' }, h('div', { class: 'top' }, lamp('bad'), h('span', { class: 'grow', style: 'font-weight:500', text: 'Auto-push to GitHub failed' })),
      h('p', { class: 'why', text: p.auto_push_error }), h('div', {}, h('button', { class: 'btn', onclick: pushAll }, icon('ship'), 'Push now'))) : null,
    approval ? h('div', { class: 'attn' }, h('div', { class: 'top' }, lamp('wait'), h('span', { class: 'grow', style: 'font-weight:500', text: `Plan v${approval.version} needs your approval` })),
      h('div', {}, h('button', { class: 'btn', onclick: () => go({ view: 'plan' }) }, 'Review plan'))) : null,
    ...held.map((t) => h('div', { class: 'attn' }, h('div', { class: 'top' }, lamp('bad'), h('span', { class: 'grow', style: 'font-weight:500; overflow-wrap:anywhere', text: t.title }), infoBtn('held'), t.hold_reason === SUPERSEDED_HOLD ? infoBtn('superseded') : null),
      h('p', { class: 'why', text: holdText(t) }),
      due.includes(t) ? h('div', {}, h('button', { class: 'btn', onclick: () => retry(t) }, icon('retry'), 'Retry')) : null)),
  ].filter(Boolean);
  const live = ts.filter((t) => t.status === 'running');

  put($('v-overview'), h('div', { class: 'ov content-w' }, head, renderSetupChecklist(p), h('div', { class: 'stats' }, hero, workers, etaCard),
    // Needs you comes first in the DOM so keyboard, screen-reader and narrow visual order all read status, Needs you, then the rest. CSS puts it back in the right column on wide screens.
    h('div', { class: 'ov-grid' }, ...[
      h('div', { class: 'col col-main' },
        panel('Progress by plan', null, planRows.length ? planRows : emptyState('No approved plans', 'Progress per plan shows here once a plan is approved',
          { label: 'Open plan', icon: 'plan', onclick: () => go({ view: 'plan' }) })),
        phases.length ? panel('Roadmap', `${phases.filter((x) => x.status === 'done').length} of ${phases.length}`, phases.map((ph) => {
          const [label, kind] = PH[ph.status] || [ph.status, ''];
          return h('div', { class: 'lrow' }, lamp(kind), h('span', { class: 'ellipsis', text: ph.title }), h('span', { class: 'mono muted', text: label }));
        })) : null,
        panel('Recently merged', null, merged.length ? merged.map((t) => h('div', { class: 'lrow' }, lamp('ok'), h('span', { class: 'ellipsis', text: t.title }),
          h('span', { class: 'mono muted', text: (t.pr_number ? `#${t.pr_number} · ` : '') + ago(sqlTime(t.updated_at)) }))) : emptyState('Nothing merged yet', 'The last five merged tasks will appear here as they land'))),
      h('div', { class: 'col col-need' },
        panel('Needs you', attn.length || null, attn.length ? attn : emptyState('Nothing needs you', 'Held tasks, failed pushes and plans to approve will appear here'),
          due.length > 1 ? h('button', { class: 'btn', onclick: () => retryMany(due) }, icon('retry'), 'Retry all') : null),
        panel('Running now', live.length || null, live.length ? live.map((t) => {
          const a = state.attempts.find((x) => x.task_id === t.id && x.status === 'running');
          return h('div', { class: 'lrow' }, lamp('live'), h('span', { class: 'ellipsis', text: t.title }), h('span', { class: 'mono muted', text: a ? fmtDur(Date.now() - sqlTime(a.started_at).getTime()) : '' }));
        }) : p.paused
          ? emptyState('No worker is running', 'Dispatch is paused, so no task will start', { label: 'Resume dispatch', icon: 'play', onclick: togglePause })
          : emptyState('No worker is running', 'Tasks that are ready will start here when a worker is free')))].reverse())));
}

export { renderOverview };
// </script>
