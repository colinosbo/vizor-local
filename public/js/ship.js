// <script>
// ship.js: Ship view (#v-ship): your folder, GitHub push with its confirm step and push guard, and merge history.
// The first and last lines are markers the static UI tests read modules by; keep them.
import {
  $, announce, copyBtn, current, emptyState, go, h, hooks, icon, lamp, planFor, post, proj, put, refresh,
  setShipConfirm, shipCache, shipConfirm, short, statusEl, tasksOf, toast, view
} from './core.js';
import { stampCell } from './run.js';

// ----- Ship: your folder + push to GitHub (fast-forward only, owner confirms) -----
// Push to GitHub never pushes directly: it shows the confirm step in Ship.
function askPush(pid) { setShipConfirm(pid); renderShip(); }
// Push guard: one finding at a time can be allowed, after its own confirm step. There is no allow-all.
let pgConfirm = null, pgSeen = '';
const pgWhere = (f) => f.file ? `${f.file}${f.line ? ':' + f.line : ''}` : 'this change';
function askOverride(pid, findingId) { pgConfirm = { pid, findingId }; renderShip(); }
async function overrideOne(pid, findingId) {
  pgConfirm = null;
  const r = await post(`/api/projects/${encodeURIComponent(pid)}/push-override`, { findingId });
  if (r) toast('Allowed that one finding');
  loadShip(pid);
}
// A 409 from push or push-now carries the findings: show them in Ship instead of a generic error.
function pushBlocked(pid, j) {
  const d = shipCache[pid]?.data;
  if (d) shipCache[pid] = { ...shipCache[pid], data: { ...d, findings: j.findings, canPush: false } };
  else loadShip(pid);
  setShipConfirm(null);
  if (view !== 'ship') go({ view: 'ship' }); else renderShip();
}
function pgPanel(p, d) {
  const fs = d.findings || [];
  if (!fs.length) return null;
  const sig = fs.map((f) => f.id).join('|');
  if (sig !== pgSeen) { pgSeen = sig; announce(`Push blocked: ${fs.length} finding${fs.length === 1 ? '' : 's'} to review in Ship`); }
  const rows = fs.map((f) => {
    const asking = pgConfirm && pgConfirm.pid === p.id && pgConfirm.findingId === f.id;
    return h('li', { class: 'pg-row', 'data-finding': f.id },
      h('span', { class: 'pg-file mono', text: pgWhere(f) }),
      h('span', { class: 'pg-reason', text: f.reason }),
      f.excerpt ? h('code', { class: 'pg-excerpt mono', text: f.excerpt }) : null,
      asking
        ? h('div', { class: 'pg-acts' },
            h('span', { class: 'pg-ask', text: `Allow pushing ${pgWhere(f)} even though: ${f.reason}? This allows only this one finding.` }),
            h('button', { class: 'btn primary', 'data-override-confirm': '', onclick: () => overrideOne(p.id, f.id) }, 'Confirm: allow this one'),
            h('button', { class: 'btn ghost', 'data-default': '', onclick: () => { pgConfirm = null; renderShip(); } }, 'Cancel'))
        : h('div', { class: 'pg-acts' },
            h('button', { class: 'btn', 'data-override': '', 'aria-label': `Allow this one: ${pgWhere(f)}`, onclick: () => askOverride(p.id, f.id) }, 'Allow this one')));
  });
  return h('div', { class: 'pg', id: 'pgBlocked', role: 'group', 'aria-labelledby': 'pgTitle' },
    h('h3', { id: 'pgTitle', text: `Push blocked: ${fs.length} finding${fs.length === 1 ? '' : 's'} to review` }),
    h('p', { text: 'Before anything leaves your computer, Local checks what would be pushed for secrets, private key files and files that should not be public. Fix each one and commit, or allow it yourself if you are sure it is safe.' }),
    h('ul', { class: 'pg-rows' }, rows),
    d.overridden ? h('p', { text: `${d.overridden} other finding${d.overridden === 1 ? ' is' : 's are'} already allowed by you.` }) : null);
}
async function loadShip(pid, fetchGithub = true) {
  shipCache[pid] = { ...(shipCache[pid] || {}), loading: true };
  if (view === 'ship') renderShip();
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(pid)}/ship?fetch=${fetchGithub ? 1 : 0}`);
    const j = await r.json();
    shipCache[pid] = r.ok ? { data: j, at: Date.now() } : { error: j.error || `failed (${r.status})`, at: Date.now() };
  } catch { shipCache[pid] = { error: 'Local is not reachable', at: Date.now() }; }
  if (view === 'ship') renderShip();
}
function renderShip() {
  const p = proj(), c = shipCache[p.id];
  if (!c) { loadShip(p.id); return; }
  const d = c.data;
  const merged = tasksOf(p.id).filter((t) => t.merge_sha && (t.status === 'merged' || t.status === 'merging'))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  const recheck = h('button', { class: 'btn ghost', disabled: !!c.loading, onclick: () => loadShip(p.id) }, icon('retry'), c.loading ? 'Checking' : 'Check again');

  // Folder card
  const f = d?.folder;
  const folderLine = !f ? 'Folder status unavailable'
    : f.branch !== p.base_branch ? `On branch ${f.branch}, so it is not updated automatically`
    : f.dirty ? 'You have uncommitted changes, so it is not updated automatically'
    : f.ahead ? `Has ${f.ahead} commit(s) that Local's main does not have, so it is not updated automatically`
    : f.behind ? `${f.behind} commit${f.behind === 1 ? '' : 's'} behind ${p.base_branch}` : 'Up to date with local merges';
  const folderCard = h('div', { class: 'card form' },
    h('div', { style: 'display:flex; align-items:center; gap:16px' }, h('h2', { class: 'grow', text: 'Your folder' }),
      f && f.behind && !f.dirty && !f.ahead && f.branch === p.base_branch ? h('button', { class: 'btn', onclick: async () => {
        const r = await post(`/api/projects/${p.id}/sync`); if (r) { toast(r.synced ? 'Folder updated' : r.reason); loadShip(p.id, false); } } }, 'Update folder now') : null),
    h('p', { class: 'mono t2' }, p.repo_path, copyBtn(p.repo_path, 'folder path')),
    h('p', { class: 'status' }, lamp(f && f.branch === p.base_branch && !f.behind && !f.dirty && !f.ahead ? 'ok' : f ? 'wait' : ''), folderLine));

  // GitHub card
  let gh;
  if (!d) gh = h('p', { class: c.error ? 'note-bad' : 'muted', text: c.error || 'Checking GitHub' });
  else if (!d.remote) {
    const input = h('input', { type: 'text', class: 'mono', placeholder: 'https://github.com/you/repo.git', 'aria-label': 'GitHub repo URL', spellcheck: 'false' });
    gh = [emptyState('No GitHub repo connected', 'Pushing needs a repo; create an empty one on github.com and paste its URL below'),
      h('div', { style: 'display:flex; gap:8px' }, h('div', { class: 'grow field' }, input),
        h('button', { class: 'btn', onclick: async () => { if (await post(`/api/projects/${p.id}/github`, { url: input.value })) { toast('GitHub repo connected'); loadShip(p.id); } } }, 'Connect'))];
  } else {
    const n = d.aheadCount;
    const line = d.fetchError ? h('p', { class: 'note-bad', text: 'Could not reach GitHub: ' + d.fetchError })
      : d.behind ? h('p', { class: 'note-bad', text: `GitHub has ${d.behind} commit(s) Local does not have. Pushing is blocked so nothing on GitHub is overwritten` })
      : !n ? h('p', { class: 'status' }, lamp('ok'), 'GitHub is up to date')
      : h('p', { class: 't2', text: `${n} commit${n > 1 ? 's' : ''} on Local's main that GitHub does not have` });
    const confirming = shipConfirm === p.id && d.canPush; // the palette can ask before Ship has loaded
    const blocked = pgPanel(p, d);
    if (!blocked) pgSeen = '';
    gh = [h('p', { class: 'mono t2', text: d.remote }), line, blocked,
      n && !d.behind && !d.fetchError ? h('div', { class: 'ship-commits' }, d.ahead.slice(0, 10).map((x) => h('div', { class: 'c' }, h('span', { class: 'mono muted' }, x.sha.slice(0, 8), copyBtn(x.sha, 'SHA')), h('span', { class: 'ellipsis', text: x.subject }))),
        n > 10 ? h('div', { class: 'c' }, h('span'), h('span', { class: 'muted', text: `+${n - 10} more` })) : null) : null,
      h('div', { style: 'display:flex; gap:8px; align-items:center; flex-wrap:wrap' },
        confirming
          ? [h('button', { class: 'btn primary', onclick: async () => {
                setShipConfirm(null);
                const r = await post(`/api/projects/${p.id}/push`, { sha: d.local }, (m, j) => { if (j?.findings) pushBlocked(p.id, j); else toast(m, true); });
                if (r) toast(`Pushed ${r.pushed} commit${r.pushed > 1 ? 's' : ''} to GitHub`);
                loadShip(p.id);
              } }, icon('ship'), `Confirm: push ${n} to ${p.base_branch}`),
             h('button', { class: 'btn ghost', onclick: () => { setShipConfirm(null); renderShip(); } }, 'Cancel'),
             h('span', { class: 'muted', style: 'font-size:13px', text: 'Fast-forward only. Uses your own git sign-in' })]
          // Promoted to primary after render: only one of the two push buttons exists at a time
          : [h('button', { class: 'btn', 'data-push': '', disabled: !d.canPush || !!c.loading, 'aria-describedby': blocked ? 'pgPushWhy' : null, onclick: () => askPush(p.id) }, icon('ship'), n ? `Push ${n} commit${n > 1 ? 's' : ''} to GitHub` : 'Push to GitHub'),
             blocked ? h('span', { id: 'pgPushWhy', class: 'muted', style: 'font-size:13px', text: 'Disabled until every finding above is fixed or allowed' }) : null])];
  }
  put($('v-ship'), h('div', { class: 'narrow content-w' },
    h('div', { style: 'display:flex; align-items:center; gap:16px' }, h('h1', { class: 'grow', text: 'Ship' }), recheck),
    folderCard,
    h('div', { class: 'card form' }, h('h2', { text: 'GitHub' }), gh),
    h('div', { style: 'display:flex; align-items:baseline; gap:12px' }, h('h2', { text: 'Local merge history' }), h('span', { class: 'mono muted', text: String(merged.length) })),
    merged.length ? h('div', { class: 'card', style: 'overflow:auto' }, h('table', { class: 'ship-table' },
      h('thead', {}, h('tr', {}, [...['Task', 'Plan', 'Model', 'PR', 'Merge commit', 'Status'], 'Merged', 'Run'].map((x) => h('th', { text: x })))),
      h('tbody', {}, merged.map((t) => h('tr', {},
        h('td', {}, h('button', { class: 'btn ghost project-link', onclick: () => go({ view: 'run', selTask: t.id }), text: t.title })), h('td', { class: 'mono t2', text: 'v' + (planFor(t.plan_id)?.version ?? '') }),
        h('td', { class: 'mono t2', 'data-ship-model': '', text: t.model || 'default' }),
        h('td', { class: 'mono t2' }, t.pr_number ? h('span', { class: 'ship-ref', title: 'PR #' + t.pr_number }, h('span', { text: '#' + t.pr_number }), copyBtn(t.pr_number, 'PR number')) : null),
        h('td', { class: 'mono' }, h('span', { class: 'ship-ref', title: t.merge_sha }, h('span', { text: short(t.merge_sha) }), copyBtn(t.merge_sha, 'SHA'))),
        h('td', {}, statusEl(t.status)), stampCell(t.updated_at),
        h('td', {}, h('a', { href: '#', 'data-ship-run': '', onclick: (e) => { e.preventDefault(); go({ view: 'run', selTask: t.id }); }, text: 'Open run' })))))))
      : emptyState('Nothing merged yet', 'Each task that merges into your local main will be listed here')));
  $('v-ship').querySelector('[data-push]')?.classList.add('primary');
  $('v-ship').querySelector('.pg-row [data-default]')?.focus();
}

let pushing = false;
async function pushAll() {
  const p = proj(); if (!p || pushing) return;
  pushing = true;
  try {
    const r = await post(`/api/projects/${p.id}/push-now`, null, (m, j) => { if (j?.findings) pushBlocked(p.id, j); else toast(m, true); });
    if (r) { toast(`Pushed ${r.pushed} commit${r.pushed === 1 ? '' : 's'} to GitHub, tagged ${r.tag}`); delete shipCache[p.id]; refresh(); }
  } finally { pushing = false; }
}

// A merge, sync or push can change what Ship shows: reload it when open, otherwise drop the stale copy.
hooks.events.push((e) => {
  if (['task_merged', 'folder_synced', 'pushed_to_github'].includes(e.type) && shipCache[e.project_id] && Date.now() - (shipCache[e.project_id].at || 0) > 2000) {
    if (view === 'ship' && e.project_id === current) loadShip(e.project_id, false); else delete shipCache[e.project_id];
  }
});

export { askPush, pushAll, renderShip };
// </script>
