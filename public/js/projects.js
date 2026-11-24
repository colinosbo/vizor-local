// <script>
// projects.js: Projects view (#v-projects): project table, project settings, add project and the global limit.
// The first and last lines are markers the static UI tests read modules by; keep them.
import {
  $, canNotify, current, emptyState, go, h, notifyOn, post, proj, projectStatus, put, refresh, running,
  setNotify, setRoute, state, toast, writeHash
} from './core.js';

// ----- Projects -----
let settingsFor = null;
function renderProjects() {
  put($('ptable'), ...(state.projects.length ? state.projects.map((p) => h('tr', { class: p.id === current ? 'sel' : '' },
    h('td', {}, h('button', { class: 'btn ghost project-link', 'aria-pressed': String(p.id === current),
      onclick: () => go({ current: p.id, selTask: null }), text: p.name })),
    h('td', { style: 'max-width:420px' },
      h('div', { class: 'mono ellipsis', title: p.repo_path, text: p.repo_path }),
      h('div', { class: 'mono ellipsis', style: 'color:' + (p.origin_error ? 'var(--neg-text)' : 'var(--muted)'), title: p.origin || p.origin_error,
        text: p.origin ? 'merges land in ' + p.origin : p.origin_error || '' })),
    h('td', { class: 't2', text: projectStatus(p)[0] || 'Idle' }),
    h('td', { class: 'mono', style: 'white-space:nowrap', text: `${running(p.id)} of ${p.max_workers}` + (p.paused ? ' · paused' : '') })))
    : [h('tr', {}, h('td', { colspan: '4' }, emptyState('No projects yet', 'Local has no project folder to work on',
      { label: 'Add project', onclick: () => $('aPath').focus() })))]));
  const p = proj();
  $('settingsForm').hidden = !p;
  if (p && (settingsFor !== p.id || !$('settingsForm').contains(document.activeElement))) {
    settingsFor = p.id;
    $('settingsTitle').textContent = `Settings for ${p.name}`;
    $('sCi').value = p.ci_command; $('sWorkers').value = p.max_workers; $('sAutoPush').checked = !!p.auto_push;
    $('sAutoApprove').checked = p.auto_approve === 1;
    $('sPlannerModel').value = p.planner_model || 'auto'; $('sWorkerModel').value = p.worker_model || 'auto';
    $('sNotify').checked = notifyOn(p.id);
  }
  if (document.activeElement !== $('gWorkers')) $('gWorkers').value = state.settings.find((s) => s.key === 'global_max_workers')?.value ?? 4;
}

$('settingsForm').onsubmit = async (e) => {
  e.preventDefault(); const p = proj(); if (!p) return;
  if (await post(`/api/projects/${p.id}/config`, { ciCommand: $('sCi').value, maxWorkers: Number($('sWorkers').value), autoPush: $('sAutoPush').checked,
    planner_model: $('sPlannerModel').value, worker_model: $('sWorkerModel').value })) { toast('Settings saved'); document.activeElement.blur(); refresh(); }
};
$('sAutoApprove').onchange = async (e) => {
  const box = e.currentTarget, p = proj(); if (!p) return;
  if (await post(`/api/projects/${p.id}/config`, { autoApprove: box.checked })) { toast(box.checked ? 'Auto-approve on' : 'Auto-approve off'); refresh(); } else box.checked = !box.checked;
};
$('sNotifyRow').hidden = $('sNotifyHint').hidden = !canNotify;
// The only place permission is requested: when the owner ticks the box, never on load.
$('sNotify').onchange = async (e) => {
  const box = e.currentTarget, p = proj(); if (!p) return;
  if (!box.checked) { setNotify(p.id, false); toast(`Desktop notifications off for ${p.name}`); return; }
  const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (perm !== 'granted') {
    box.checked = false; setNotify(p.id, false);
    toast(perm === 'denied'
      ? 'The browser blocks notifications for this page. Allow them in its site settings, then tick the box again'
      : 'Notifications need your permission. Tick the box again to be asked', true);
    return;
  }
  setNotify(p.id, true); toast(`Desktop notifications on for ${p.name}`);
};
$('addForm').onsubmit = async (e) => {
  e.preventDefault();
  const r = await post('/api/projects', { path: $('aPath').value.trim(), name: $('aName').value.trim() || undefined, ciCommand: $('aCi').value.trim(),
    maxWorkers: Number($('aWorkers').value), createOrigin: $('aCreate').checked });
  if (r) { toast(`Added ${r.name}`); $('aPath').value = ''; $('aName').value = ''; setRoute({ current: r.id, view: 'plan' }); writeHash(); refresh(); }
};
$('globalForm').onsubmit = async (e) => {
  e.preventDefault();
  if (await post('/api/settings/global', { globalMaxWorkers: Number($('gWorkers').value) })) { toast('Limit saved'); document.activeElement.blur(); refresh(); }
};

export { renderProjects };
// </script>
