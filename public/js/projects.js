// <script>
// projects.js: Projects view (#v-projects): project table, project settings, add project and the global limit.
// The first and last lines are markers the static UI tests read modules by; keep them.
import {
  $, canNotify, current, emptyState, go, h, notifyOn, post, proj, projectStatus, put, refresh, running,
  setNotify, setRoute, state, toast, writeHash
} from './core.js';

// ----- Forge and review gate -----
// Built here, not in index.html: this module owns the card. Every server string goes in through h()/put()/textContent.
const GATES = [
  ['off', 'Off', 'No security review'],
  ['report', 'Report', 'Review every PR and show findings, never hold merges'],
  ['block', 'Block', 'Hold merges with critical or high findings until you fix them or merge anyway']
];
const radio = (name, value, label, note, onchange) => h('label', { class: 'check', style: 'align-items:flex-start' },
  h('input', { type: 'radio', name, value, onchange }),
  h('span', {}, label, note ? h('small', { class: 'muted', style: 'display:block;font-size:12px;line-height:16px', text: note }) : null));
const fRepo = h('input', { type: 'text', id: 'sGithubRepo', class: 'mono', spellcheck: 'false', placeholder: 'owner/name', autocomplete: 'off' });
const fCheck = h('input', { type: 'text', id: 'sGithubCheck', class: 'mono', spellcheck: 'false', placeholder: 'ci', autocomplete: 'off' });
const repoField = h('label', { class: 'field' }, h('span', { text: 'Repository' }), fRepo);
const forgeStatus = h('small', { id: 'forgeStatus', class: 'muted', role: 'status' });
const forgeError = h('small', { id: 'forgeError', role: 'alert', style: 'color:var(--neg-text)', hidden: true });
const gateError = h('small', { id: 'gateError', role: 'alert', style: 'color:var(--neg-text)', hidden: true });
const forgeRadios = [['local', 'Local', 'Merges land in the project folder'], ['github', 'GitHub', 'Merges go through pull requests on GitHub']]
  .map(([v, l, n]) => radio('forgeKind', v, l, n, () => { repoField.hidden = chosenForge() !== 'github'; }));
const gateRadios = GATES.map(([v, l, n]) => radio('reviewGate', v, l, n, () => saveGate(v)));
const chosenForge = () => forgeRadios.map((r) => r.querySelector('input')).find((i) => i.checked)?.value || 'local';
const showErr = (el, m) => { el.textContent = m || ''; el.hidden = !m; };

const trustedCard = h('div', { class: 'card form', id: 'trustedCard', hidden: true },
  h('h2', { text: 'Forge and review' }),
  h('div', { class: 'field', role: 'radiogroup', 'aria-label': 'Forge' }, h('span', { text: 'Forge' }), forgeRadios),
  repoField,
  h('label', { class: 'field' }, h('span', { text: 'Required check' }), fCheck,
    h('small', { text: 'The check that must pass before a pull request merges' })),
  forgeStatus, forgeError,
  h('div', {}, h('button', { class: 'btn', type: 'button', onclick: () => saveForge() }, 'Save forge')),
  h('div', { class: 'field', role: 'radiogroup', 'aria-label': 'Review gate' }, h('span', { text: 'Review gate' }), gateRadios),
  gateError);
$('settingsForm').after(trustedCard);

async function saveForge() {
  const p = proj(); if (!p) return;
  showErr(forgeError, '');
  const r = await post(`/api/projects/${encodeURIComponent(p.id)}/config`,
    { forgeKind: chosenForge(), githubRepo: fRepo.value.trim(), githubCheck: fCheck.value.trim() || 'ci' }, (m) => showErr(forgeError, m));
  if (r) { toast('Forge saved'); refresh(); }
}
async function saveGate(reviewGate) {
  const p = proj(); if (!p) return;
  showErr(gateError, '');
  const r = await post(`/api/projects/${encodeURIComponent(p.id)}/config`, { reviewGate }, (m) => {
    showErr(gateError, m); setChecked(gateRadios, p.review_gate || 'block');
  });
  if (r) { toast('Review gate saved'); refresh(); }
}
function setChecked(radios, value) { for (const r of radios) { const i = r.querySelector('input'); i.checked = i.value === value; } }

function renderTrusted(p, fresh) {
  trustedCard.hidden = !p;
  if (!p) return;
  if (fresh) {
    setChecked(forgeRadios, p.forge_kind === 'github' ? 'github' : 'local');
    fRepo.value = p.github_repo || ''; fCheck.value = p.github_check || 'ci';
    setChecked(gateRadios, p.review_gate || 'block');
    repoField.hidden = chosenForge() !== 'github';
    showErr(forgeError, ''); showErr(gateError, '');
  }
  const f = p.forge;
  forgeStatus.textContent = !f ? '' : f.ready ? 'Ready' : f.problem || 'Not ready';
}

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
  renderTrusted(p, !!p && (settingsFor !== p.id || !trustedCard.contains(document.activeElement)));
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
