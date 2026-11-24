// <script>
// update.js: the update indicator, its panel and the updates settings card.
// The first and last lines are markers the static UI tests read modules by; keep them.
import { $, announce, h, post, put } from './core.js';

// ---------- updates ----------
// Everything here is text: commit subjects and error text are set with textContent, never as markup.
// The UI never names an update source. The server fixes it at launch and the requests below carry no URL.
const UPD_DISMISSED = 'vizor.update.dismissed';
const UPD_REASON = {
  'local-changes': 'You have local changes',
  'ahead-of-upstream': 'This copy is ahead of upstream',
  'not-a-git-install': 'This copy isn’t a git install',
  'worker-running': 'A worker is running; wait for it to finish',
};
let upd = null, updBusy = false, updErrGone = false;
const updBehind = () => (upd?.check?.state === 'ok' ? upd.check.behind : 0);
const updDismissed = () => { try { return localStorage.getItem(UPD_DISMISSED); } catch { return null; } };
const updWhy = (e) => UPD_REASON[e.reason] || e.message || '';
function updRepoLink(a) {
  const url = String(upd?.repositoryUrl || '');
  a.hidden = !/^https:\/\//.test(url);
  if (!a.hidden) a.href = url;
}
const updPanelOpen = () => !$('updPanel').hidden;
function openUpd() {
  $('updPanel').hidden = false; $('updInd').setAttribute('aria-expanded', 'true');
  [...$('updPanel').querySelectorAll('button, a')].find((n) => !n.hidden && !n.closest('[hidden]'))?.focus();
}
function closeUpd(refocus) {
  $('updPanel').hidden = true; $('updInd').setAttribute('aria-expanded', 'false');
  if (refocus && !$('updInd').hidden) $('updInd').focus();
}
function updProgress(text) {
  const p = $('updProgress'); p.textContent = text; p.hidden = false;
  announce(text);
}
function renderUpdate() {
  const on = !!upd;
  $('updCard').hidden = !on;
  const behind = updBehind();
  const showInd = on && behind > 0 && !updBusy && updDismissed() !== upd.check.upstreamSha;
  $('updInd').hidden = !showInd;
  $('updIndCount').textContent = showInd ? `· ${behind}` : '';
  if (!showInd && updPanelOpen() && !updBusy) closeUpd(false);
  if (!on) { $('updErr').hidden = true; announceUpdateStatus(); return; }

  // Panel
  if (behind > 0 && !updBusy) {
    $('updCount').textContent = `${behind} new commit${behind === 1 ? '' : 's'}`;
    put($('updSubjects'), (upd.check.subjects || []).map((s) => h('li', { text: String(s) })));
    const e = upd.eligibility;
    $('updNow').hidden = !e.eligible;
    $('updReason').hidden = !!e.eligible;
    if (!e.eligible) $('updReason').textContent = updWhy(e);
    updRepoLink($('updRepo')); if (e.reason !== 'not-a-git-install') $('updRepo').hidden = true;
    $('updActs').hidden = false; $('updProgress').hidden = true;
  }

  // Settings
  $('updAuto').checked = !!upd.checkEnabled;
  $('updCheck').disabled = updBusy || !upd.checkEnabled || !upd.gitInstall;
  const zip = !upd.gitInstall;
  $('updCardReason').hidden = !zip;
  if (zip) $('updCardReason').textContent = UPD_REASON['not-a-git-install'];
  updRepoLink($('updCardRepo')); if (!zip) $('updCardRepo').hidden = true;
  const canRevert = !!upd.revert?.available;
  $('updRevertBox').hidden = !canRevert;
  if (!canRevert) { $('updRevertConfirm').hidden = true; }

  // A failed or rolled-back run, shown once until dismissed
  const le = upd.lastError;
  $('updErr').hidden = !le || updErrGone;
  if (le) {
    $('updErrTitle').textContent = le.kind === 'revert' ? 'Revert did not finish' : 'Update did not finish';
    $('updErrText').textContent = String(le.error);
  }
  announceUpdateStatus();
}
// Lets other modules (the nav footer) re-render when update status changes.
function announceUpdateStatus() { document.dispatchEvent(new CustomEvent('vizor:update-status')); }
// A fresh snapshot of the update state for the palette and the sidebar.
function updateInfo() {
  const eligible = upd?.eligibility?.eligible === true;
  return {
    loaded: upd !== null,
    behind: updBehind(),
    checkEnabled: !!upd?.checkEnabled,
    gitInstall: !!upd?.gitInstall,
    busy: updBusy,
    eligible,
    reason: upd && !eligible ? updWhy(upd.eligibility || {}) : null,
  };
}
async function fetchUpdate() {
  if (updBusy) return;
  try {
    const r = await fetch('/api/update/status');
    upd = r.ok ? await r.json() : null;
  } catch { upd = null; }
  renderUpdate();
}
function updResultText() {
  const c = upd.check;
  if (c.state === 'ok') return c.behind > 0 ? `Update available · ${c.behind}` : 'Up to date';
  if (c.state === 'failed') return `Could not check: ${c.error}`;
  if (c.state === 'disabled') return c.message;
  return upd.eligibility.reason === 'not-a-git-install' ? UPD_REASON['not-a-git-install'] : 'Not checked yet';
}
function updResult(text) { $('updResult').textContent = text; announce(text); }
async function checkUpdateNow() {
  const b = $('updCheck'); b.disabled = true; updResult('Checking…');
  const r = await post('/api/update/check', null, (m, j) => { if (j?.status) upd = j.status; updResult(m); });
  if (r) { upd = r; updResult(updResultText()); }
  renderUpdate();
}
async function setUpdateCheck(on) {
  const r = await post('/api/update/settings', { checkEnabled: on });
  if (r) { upd = r; updResult(on ? 'Automatic checks on' : 'Automatic checks off'); } else $('updAuto').checked = !on;
  renderUpdate();
}
// After apply the server stops and restarts; poll until it answers again, then reload onto the new version.
async function runUpdate(path) {
  if (updBusy) return;
  updBusy = true;
  $('updTitle').textContent = path === 'revert' ? 'Reverting' : 'Updating';
  $('updCount').textContent = ''; $('updSubjects').hidden = true;
  $('updReason').hidden = true; $('updRepo').hidden = true; $('updActs').hidden = true;
  $('updInd').hidden = true; $('updCheck').disabled = true; $('updRevertConfirm').hidden = true;
  if (!updPanelOpen()) { $('updPanel').hidden = false; }
  updProgress('Backing up…');
  const r = await post(`/api/update/${path}`, null, (m) => {
    updBusy = false; $('updSubjects').hidden = false; $('updTitle').textContent = 'Update available';
    $('updProgress').hidden = true; $('updActs').hidden = false;
    $('updReason').hidden = false; $('updReason').textContent = m; announce(m);
    fetchUpdate();
  });
  if (!r) return;
  updProgress('Updating…');
  const started = Date.now(); let sawDown = false;
  const tick = async () => {
    let s = null;
    try { const res = await fetch('/api/update/status'); if (res.ok) s = await res.json(); } catch { /* server is restarting */ }
    if (!s) { if (!sawDown) { sawDown = true; updProgress('Restarting…'); } }
    else if (sawDown || !s.inProgress) return location.reload();
    if (Date.now() - started > 180000) return updProgress('This is taking longer than expected. Reload this page to check');
    setTimeout(tick, 1500);
  };
  setTimeout(tick, 1500);
}
$('updInd').onclick = () => (updPanelOpen() ? closeUpd(true) : openUpd());
$('updNow').onclick = () => runUpdate('apply');
$('updLater').onclick = () => {
  const sha = upd?.check?.upstreamSha;
  if (sha) { try { localStorage.setItem(UPD_DISMISSED, sha); } catch { /* storage unavailable */ } }
  closeUpd(false); renderUpdate(); $('goHome').focus();
};
$('updErrDismiss').onclick = async () => {
  updErrGone = true; $('updErr').hidden = true; $('goHome').focus();
  await post('/api/update/dismiss-error');
};
$('updAuto').onchange = (e) => setUpdateCheck(e.target.checked);
$('updCheck').onclick = checkUpdateNow;
$('updRevert').onclick = () => {
  const open = $('updRevertConfirm').hidden;
  $('updRevertConfirm').hidden = !open; $('updRevert').setAttribute('aria-expanded', String(open));
  if (open) $('updRevertCancel').focus();
};
$('updRevertCancel').onclick = () => { $('updRevertConfirm').hidden = true; $('updRevert').setAttribute('aria-expanded', 'false'); $('updRevert').focus(); };
$('updRevertGo').onclick = () => runUpdate('revert');
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && updPanelOpen() && !updBusy && $('palette').hidden) { e.preventDefault(); closeUpd(true); } });
fetchUpdate();
setInterval(() => { if (!document.hidden) fetchUpdate(); }, 10 * 60 * 1000);

export { checkUpdateNow, runUpdate, openUpd, updateInfo };

// </script>
