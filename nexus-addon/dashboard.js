// Dashboard orchestrator: storage load, status bar, tab switching and
// global controls. Tab rendering lives in tabs/*.js, shared helpers in
// common.js (load order matters — this file comes last).

// ── Storage ────────────────────────────────────────────────────────────────

import { activeTab, activeUniverse, confirmDialog, dayKey, fuelForMode, getLabelKey, getMode, infoDialog, periodLabelFor, renderMarkdown, renderNetCards, setActiveTab, setActiveUniverse, setStore, store, storeKey } from './common.js';
import { renderBattlesTab } from './tabs/battles.js';
import { renderDebrisTab } from './tabs/debris.js';
import { renderExpeditionsTab, setExpPage } from './tabs/expeditions.js';
import { renderWormholesTab, setWhPage } from './tabs/wormholes.js';
import { initAsteroidsTab } from './tabs/asteroids.js';
import { renderFleetsTab } from './tabs/fleets.js';
import { initScoutingTab } from './tabs/scouting.js';
import { initXenoTab, renderXenoTab, setXnReportPage } from './tabs/xeno.js';
import { initFinderTab } from './tabs/finder.js';
import { initMarketTab } from './tabs/market.js';
import { renderGlobalTab } from './tabs/global.js';
import { renderMiningTab, setMiningPage } from './tabs/mining.js';
import { renderPiratesTab, setPirateCurrentPage } from './tabs/pirates.js';
import { getEventBreakdownForMode, getResourcesLostForMode, getSeriesForMode, getTotalsForMode, populateEventOptions, renderByEventChart, renderCollected, renderEventsChart, renderLost, renderResourceChart, renderTable, setCurrentPage } from './tabs/surveys.js';
import { renderTechTreeTab } from './tabs/techtree.js';

// All data keys loaded from storage per scrape run.
const UNIVERSE_STORE_KEYS = [
  'totals', 'daily', 'hourly', 'resources_lost', 'event_breakdown',
  'recent_reports', 'ships', 'last_scrape', 'last_error', 'records_cap',
  'pirate_totals', 'pirate_daily', 'pirate_resources_lost',
  'pirate_outcomes', 'pirate_debris_total', 'pirate_recent_reports',
  'mining_totals', 'mining_daily', 'mining_resources_lost', 'mining_recent_reports',
  'debris_fields', 'debris_last_check',
  'debris_collected', 'debris_active_runs', 'debris_collection_log', 'debris_resources_lost',
  'exp_totals', 'expedition_totals', 'wormhole_totals', 'exp_daily', 'exp_recent_reports',
  'expedition_resources_lost', 'wormhole_resources_lost', 'stats_drift',
  'xeno_totals', 'xeno_daily', 'xeno_recent_reports', 'xeno_resources_lost',
  'pvp_recent_reports',
  'research', 'research_speed_mult', 'active_research', 'fuel_log',
  'fleet_templates', 'tt_queue_targets', 'live_search',
];

export async function loadAll(universe) {
  const u = universe || activeUniverse;
  let raw;
  if (u) {
    // Fetch all keys with universe prefix, then strip prefix for the store.
    const scopedKeys = UNIVERSE_STORE_KEYS.map(k => storeKey(u, k));
    const scopedRaw = await browser.storage.local.get(scopedKeys);
    const unscoped = {};
    for (const k of UNIVERSE_STORE_KEYS) unscoped[k] = scopedRaw[storeKey(u, k)];
    // Add global keys (no universe prefix).
    const globalRaw = await browser.storage.local.get(['records_cap']);
    if (unscoped.records_cap == null) unscoped.records_cap = globalRaw.records_cap;
    raw = unscoped;
  } else {
    // No universe configured yet — load with unscoped keys as fallback.
    raw = await browser.storage.local.get(UNIVERSE_STORE_KEYS);
  }
  setStore(raw);
  const cap = raw.records_cap ?? 5000;
  document.getElementById('records-cap').value = cap === Infinity ? 0 : cap;
  updateStatus(raw.last_scrape, raw.last_error);
  renderAll();
  updateStorageFooter();
}

// Archived record counts + rough storage size, shown in the footer.
export async function updateStorageFooter() {
  const el = document.getElementById('storage-footer');
  if (!el) return;
  const u = activeUniverse;
  const sk = k => u ? `${u}:${k}` : k;
  const all = await browser.storage.local.get(null);
  const idx = all[sk('archive_index')] || {};
  const reports = (idx.survey?.count || (all[sk('recent_reports')] || []).length) +
    (idx.pirate?.count || (all[sk('pirate_recent_reports')] || []).length) +
    (idx.mining?.count || (all[sk('mining_recent_reports')] || []).length) +
    (idx.exp?.count || (all[sk('exp_recent_reports')] || []).length) +
    (idx.xeno?.count || (all[sk('xeno_recent_reports')] || []).length);
  let bytes = 0;
  try { bytes = JSON.stringify(all).length; } catch { /* ignore */ }
  const size = bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
  const backup = all.last_backup ? new Date(all.last_backup).toLocaleDateString() : 'never';
  el.textContent = `${reports.toLocaleString()} reports archived · ~${size} stored · last auto-backup: ${backup}`;
}

export function updateStatus(lastScrape, lastError) {
  const el = document.getElementById('status-text');
  el.textContent = '';
  if (lastError) {
    const span = document.createElement('span');
    span.className = 'error';
    span.textContent = `Error: ${lastError}`;
    el.appendChild(span);
  } else if (lastScrape) {
    el.textContent = `Last scrape: ${new Date(lastScrape).toLocaleString()}`;
  } else {
    el.textContent = 'Never scraped.';
  }
  if (store.stats_drift) {
    const warn = document.createElement('span');
    warn.className = 'error';
    warn.style.marginLeft = '10px';
    warn.title = `Fields out of sync: ${(store.stats_drift.fields || []).join(', ')}`;
    warn.textContent = '⚠ Stats drift detected — click "Rebuild stats".';
    el.appendChild(warn);
  }
}

// ── Render ─────────────────────────────────────────────────────────────────

export function renderAll() {
  if (activeTab === 'global') {
    renderGlobalTab();
    return;
  }
  if (activeTab === 'pirates') {
    renderPiratesTab();
    return;
  }
  if (activeTab === 'mining') {
    renderMiningTab();
    return;
  }
  if (activeTab === 'battles') {
    renderBattlesTab();
    return;
  }
  if (activeTab === 'debris') {
    renderDebrisTab();
    return;
  }
  if (activeTab === 'expeditions') {
    renderExpeditionsTab();
    return;
  }
  if (activeTab === 'wormholes') {
    renderWormholesTab();
    return;
  }
  if (activeTab === 'finder') {
    initFinderTab();
    return;
  }
  if (activeTab === 'asteroids') {
    initAsteroidsTab();
    return;
  }
  if (activeTab === 'fleets') {
    renderFleetsTab();
    return;
  }
  if (activeTab === 'scouting') {
    initScoutingTab();
    return;
  }
  if (activeTab === 'xeno') {
    initXenoTab();
    renderXenoTab();
    return;
  }
  if (activeTab === 'market') {
    initMarketTab();
    return;
  }
  if (activeTab === 'techtree') {
    renderTechTreeTab();
    return;
  }
  if (activeTab === 'settings') {
    renderSettingsTab();
    return;
  }
  if (activeTab === 'simulator') return;   // iframe handles its own rendering
  populateEventOptions();
  const mode = getMode();
  const t = getTotalsForMode();
  const rl = getResourcesLostForMode();
  const events = getEventBreakdownForMode();
  const series = getSeriesForMode();
  const labelKey = getLabelKey(mode);
  const periodLabel = periodLabelFor(mode);

  renderCollected(t, periodLabel);
  renderLost(rl, periodLabel);
  renderNetCards('stats-net', t, rl, periodLabel, fuelForMode('survey', getMode()));
  renderResourceChart(series, labelKey);
  renderEventsChart(events);
  renderByEventChart(events);
  renderTable();
}

// Tabs that can never be hidden.
const PROTECTED_TABS = new Set(['global', 'settings']);

const TAB_LABELS = {
  global: 'Global', surveys: 'Surveys', pirates: 'Pirates', mining: 'Mining',
  battles: 'Battles', debris: 'Debris', expeditions: 'Expeditions', wormholes: 'Wormhole',
  finder: 'Galaxy Scout', asteroids: 'Asteroids Fields', fleets: 'Fleet Templates',
  scouting: 'Scouting', xeno: 'Xeno', market: 'Market', techtree: 'Tech Tree',
  simulator: '⚔ Combat Simulator',
};

// Tab prefs stored as { s0: { hidden: [] }, nf: { hidden: ['xeno'] } } — per universe.
async function loadTabPrefs(universe) {
  const u = universe || activeUniverse || 's0';
  const raw = await browser.storage.local.get('nx:tab_prefs');
  const all = raw['nx:tab_prefs'] || {};
  return all[u] || { hidden: [] };
}

async function saveTabPrefs(prefs, universe) {
  const u = universe || activeUniverse || 's0';
  const raw = await browser.storage.local.get('nx:tab_prefs');
  const all = raw['nx:tab_prefs'] || {};
  all[u] = prefs;
  await browser.storage.local.set({ 'nx:tab_prefs': all });
}

// Shows/hides tab buttons for the active universe; switches away from a hidden tab if needed.
async function applyTabPrefs(universe) {
  const prefs = await loadTabPrefs(universe);
  const hidden = new Set(prefs.hidden || []);
  document.querySelectorAll('.tab[data-tab]').forEach(btn => {
    const tab = btn.dataset.tab;
    if (PROTECTED_TABS.has(tab)) return;
    btn.style.display = hidden.has(tab) ? 'none' : '';
  });
  if (hidden.has(activeTab)) {
    document.querySelector('.tab[data-tab="global"]')?.click();
  }
}

// ── Tabs ───────────────────────────────────────────────────────────────────

export const TAB_CONTENT = {
  global: 'global-content',
  surveys: 'main-content',
  pirates: 'pirates-content',
  mining: 'mining-content',
  battles: 'battles-content',
  debris: 'debris-content',
  expeditions: 'expeditions-content',
  wormholes: 'wormholes-content',
  finder: 'finder-content',
  asteroids: 'asteroids-content',
  fleets: 'fleets-content',
  scouting: 'scouting-content',
  xeno: 'xeno-content',
  market: 'market-content',
  techtree: 'techtree-content',
  simulator: 'simulator-content',
  settings: 'settings-content',
};

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    setActiveTab(btn.dataset.tab);
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
    for (const [tab, id] of Object.entries(TAB_CONTENT)) {
      document.getElementById(id).style.display = tab === activeTab ? '' : 'none';
    }
    // View mode and records cap are meaningless on these tabs.
    document.getElementById('global-controls').style.display =
      (activeTab === 'finder' || activeTab === 'asteroids' || activeTab === 'fleets' || activeTab === 'scouting' || activeTab === 'techtree' || activeTab === 'market' || activeTab === 'battles' || activeTab === 'settings' || activeTab === 'simulator') ? 'none' : '';
    // Update simulator iframe src when switching to the simulator tab.
    if (activeTab === 'simulator') {
      const iframe = document.getElementById('sim-iframe');
      const u = activeUniverse;
      const want = `simulator.html${u ? `?universe=${encodeURIComponent(u)}` : ''}`;
      if (iframe && !iframe.src.endsWith(want)) iframe.src = browser.runtime.getURL(want);
    }
    positionControls();
    renderAll();
  });
});

// Open directly on a tab when linked with a hash, e.g. dashboard.html#asteroids
// (used by the live-search results window).
if (location.hash) {
  document.querySelector(`.tab[data-tab="${location.hash.slice(1)}"]`)?.click();
}

// Keep the View/Window/Zone bar directly above the active tab's graphs.
export function positionControls() {
  const bar = document.getElementById('global-controls');
  const content = document.getElementById(TAB_CONTENT[activeTab]);
  const charts = content && content.querySelector('.charts');
  if (charts) charts.parentNode.insertBefore(bar, charts);
}

// ── Controls ───────────────────────────────────────────────────────────────

document.getElementById('btn-scrape').addEventListener('click', async function () {
  this.disabled = true;
  this.textContent = 'Scraping…';
  try {
    await browser.runtime.sendMessage({ type: 'SCRAPE_NOW', universe: activeUniverse });
    await loadAll(activeUniverse);
    this.textContent = 'Done ✓';
  } catch {
    this.textContent = 'Error';
  } finally {
    setTimeout(() => { this.disabled = false; this.textContent = 'Scrape Now'; }, 2000);
  }
});

export function onViewChange() {
  setCurrentPage(1);
  setPirateCurrentPage(1);
  setMiningPage(1);
  setExpPage(1);
  setWhPage(1);
  setXnReportPage(1);
  renderAll();
}

// Switching View fills the Days picker: All time clears it (= all history),
// Daily/Hourly = today, Last N = a trailing range. The user can still edit it.
document.getElementById('mode-select').addEventListener('change', () => {
  const mode = getMode();
  const from = document.getElementById('window-from');
  const to = document.getElementById('window-to');
  const span = { last3: 3, last7: 7, last30: 30 }[mode];
  if (mode === 'all') {
    from.value = ''; to.value = '';
  } else {
    const now = Date.now();
    to.value = dayKey(now);
    from.value = dayKey(now - ((span || 1) - 1) * 86400000);
  }
  onViewChange();
});
document.getElementById('zone-select').addEventListener('change', onViewChange);
document.getElementById('window-from').addEventListener('change', onViewChange);
document.getElementById('window-to').addEventListener('change', onViewChange);
document.getElementById('event-select').addEventListener('change', () => { setCurrentPage(1); renderAll(); });

document.getElementById('btn-reset').addEventListener('click', async function () {
  if (!confirm('Drop all recorded data? A backup is written to Downloads/NexusAccounting first.')) return;
  await browser.runtime.sendMessage({ type: 'BACKUP_NOW', reason: 'pre-reset' });
  const { records_cap } = await browser.storage.local.get('records_cap');
  await browser.storage.local.clear();
  if (records_cap) await browser.storage.local.set({ records_cap });
  await initUniverseBar();
  await loadAll(activeUniverse);
});

document.getElementById('records-cap').addEventListener('input', function () {
  const raw = this.value.trim();
  const n = parseInt(raw, 10);
  const invalid = raw === '' || isNaN(n) || n < 0 || String(n) !== raw;
  this.style.borderColor = invalid ? '#ff7b72' : '#30363d';
  this.style.color = invalid ? '#ff7b72' : '#e6edf3';
  document.getElementById('cap-warning').style.display = invalid ? '' : 'none';
});

document.getElementById('btn-save-cap').addEventListener('click', async function () {
  const input = document.getElementById('records-cap');
  const raw = parseInt(input.value.trim(), 10);
  if (isNaN(raw) || raw < 0) return;
  const val = raw === 0 ? Infinity : raw;
  await browser.storage.local.set({ records_cap: val });
  input.value = val === Infinity ? 0 : val;
  input.style.borderColor = '#30363d';
  input.style.color = '#e6edf3';
  document.getElementById('cap-warning').style.display = 'none';
  this.textContent = 'Saved ✓';
  setTimeout(() => { this.textContent = 'Save'; }, 1500);
});

// ── Rebuild aggregates ─────────────────────────────────────────────────────

document.getElementById('btn-rebuild').addEventListener('click', async function () {
  const u = activeUniverse;
  const idxKey = u ? `${u}:archive_index` : 'archive_index';
  const rrKey = u ? `${u}:recent_reports` : 'recent_reports';
  const s = await browser.storage.local.get([idxKey, rrKey,
    ...(u ? ['pirate', 'mining', 'exp', 'xeno'].flatMap(t => [`${u}:${t}_recent_reports`]) : []
    )]);
  const idx = s[idxKey] || {};
  const reports = (idx.survey?.count || (s[rrKey] || []).length);
  if (!confirm(
    `Recompute all aggregated stats from the stored report records?\n\n` +
    'Mining alloys/rares, stolen-cargo breakdown and mining loss valuation ' +
    'cannot be reconstructed and will reset.')) return;

  this.disabled = true;
  this.textContent = 'Rebuilding…';
  try {
    await browser.runtime.sendMessage({ type: 'REBUILD_AGGREGATES', universe: u });
    await loadAll(u);
    this.textContent = 'Rebuilt ✓';
  } catch {
    this.textContent = 'Error';
  } finally {
    setTimeout(() => { this.disabled = false; this.textContent = 'Rebuild stats'; }, 2000);
  }
});

// ── Export / Import ────────────────────────────────────────────────────────

document.getElementById('btn-export').addEventListener('click', async function () {
  const all = await browser.storage.local.get(null);
  const u = activeUniverse;
  // Filter to only keys for the active universe (prefix `u:`) plus global keys.
  const data = {};
  for (const [k, v] of Object.entries(all)) {
    if (u && k.startsWith(`${u}:`)) {
      data[k] = v;  // keep universe-scoped keys as-is
    } else if (!k.includes(':')) {
      data[k] = v;  // global keys (no colon prefix)
    }
  }
  if (data.records_cap === Infinity) data.records_cap = 0;
  const payload = {
    nexus_accounting_backup: 1,
    exported_at: new Date().toISOString(),
    universe: u || null,
    data,
  };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `nexus-accounting-backup-${u || 'all'}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  this.textContent = 'Exported ✓';
  setTimeout(() => { this.textContent = 'Export JSON'; }, 2000);
});

document.getElementById('btn-import').addEventListener('click', () => {
  document.getElementById('import-file').click();
});

// Shape checks on a backup before anything is cleared. Catches truncated or
// hand-edited files; unknown keys are allowed through untouched.
export function validateBackupData(data) {
  const arrays = [
    'recent_reports', 'daily', 'hourly', 'event_breakdown', 'seen_ids',
    'pirate_recent_reports', 'pirate_seen_ids', 'pirate_daily', 'pirate_outcomes',
    'mining_recent_reports', 'mining_seen_ids', 'mining_daily',
    'exp_recent_reports', 'exp_seen_ids', 'exp_daily',
    'xeno_recent_reports', 'xeno_seen_ids', 'xeno_daily',
    'survey_archive', 'pirate_archive', 'mining_archive', 'exp_archive', 'xeno_archive',
    'spy_reports', 'camp_scout_reports', 'debris_fields',
  ];
  const objects = [
    'totals', 'pirate_totals', 'mining_totals', 'exp_totals', 'xeno_totals',
    'expedition_totals', 'wormhole_totals', 'ships',
    'resources_lost', 'pirate_resources_lost', 'mining_resources_lost',
    'expedition_resources_lost', 'wormhole_resources_lost', 'xeno_resources_lost',
    'pirate_debris_total', 'archive_index',
  ];
  for (const k of arrays) {
    if (k in data && !Array.isArray(data[k])) throw new Error(`backup field "${k}" should be a list`);
  }
  for (const k of objects) {
    if (k in data && (typeof data[k] !== 'object' || data[k] === null || Array.isArray(data[k]))) {
      throw new Error(`backup field "${k}" should be an object`);
    }
  }
  if ('records_cap' in data && typeof data.records_cap !== 'number') {
    throw new Error('backup field "records_cap" should be a number');
  }
}

document.getElementById('import-file').addEventListener('change', async function () {
  const file = this.files[0];
  this.value = '';                    // allow re-selecting the same file
  if (!file) return;

  const btn = document.getElementById('btn-import');
  try {
    const payload = JSON.parse(await file.text());
    if (!payload || payload.nexus_accounting_backup !== 1 || !payload.data || Array.isArray(payload.data) || typeof payload.data !== 'object') {
      throw new Error('not a Nexus Accounting backup file');
    }
    validateBackupData(payload.data);
    const exportedAt = payload.exported_at ? new Date(payload.exported_at).toLocaleString() : 'unknown date';
    const exportedUniverse = payload.universe || null;
    let confirmMsg = `Replace ALL current data with backup from ${exportedAt}?\n\nA snapshot of the current data is written to Downloads/NexusAccounting first.`;
    if (exportedUniverse && exportedUniverse !== activeUniverse) {
      confirmMsg = `⚠ This backup is from universe "${exportedUniverse}" but you are currently on "${activeUniverse}".\n\n` + confirmMsg;
    }
    if (!confirm(confirmMsg)) return;

    await browser.runtime.sendMessage({ type: 'BACKUP_NOW', reason: 'pre-import' });
    const data = payload.data;
    if (data.records_cap === 0) data.records_cap = Infinity;
    await browser.storage.local.clear();
    await browser.storage.local.set(data);
    await initUniverseBar();
    await loadAll(activeUniverse);
    btn.textContent = 'Imported ✓';
  } catch (e) {
    alert(`Import failed: ${e.message}`);
    btn.textContent = 'Error';
  } finally {
    setTimeout(() => { btn.textContent = 'Import JSON'; }, 2000);
  }
});

// ── Init ───────────────────────────────────────────────────────────────────

// On launch, if the stored report count is very large, offer a one-click purge
// down to the last 3 days. Runs once (not on every scrape-driven reload).
const PURGE_WARN_THRESHOLD = 10000;
async function maybeWarnStorage() {
  const u = activeUniverse;
  const idxKey = u ? `${u}:archive_index` : 'archive_index';
  const reportKeys = u
    ? ['recent_reports','pirate_recent_reports','mining_recent_reports','exp_recent_reports','xeno_recent_reports'].map(k => `${u}:${k}`)
    : ['recent_reports','pirate_recent_reports','mining_recent_reports','exp_recent_reports','xeno_recent_reports'];
  const all = await browser.storage.local.get([idxKey, ...reportKeys]);
  const idx = all[idxKey] || {};
  const rr = k => all[u ? `${u}:${k}` : k] || [];
  const total = (idx.survey?.count || rr('recent_reports').length) +
    (idx.pirate?.count || rr('pirate_recent_reports').length) +
    (idx.mining?.count || rr('mining_recent_reports').length) +
    (idx.exp?.count || rr('exp_recent_reports').length) +
    (idx.xeno?.count || rr('xeno_recent_reports').length);
  if (total <= PURGE_WARN_THRESHOLD) return;
  if (!await confirmDialog(`⚠ Large storage: ${total.toLocaleString()} reports kept.\n\nPurge old data and keep only the last 3 days?`)) return;
  await browser.runtime.sendMessage({ type: 'PURGE_OLD', days: 3, universe: u });
  await loadAll(u);
}

positionControls();
applyTabPrefs();
initUniverseBar().then(u => {
  return loadAll(u);
}).then(maybeWarnStorage);
maybeShowWhatsNew();

// ── Universe bar ───────────────────────────────────────────────────────────

// Reads nx:settings, renders universe tab buttons, sets activeUniverse.
// Returns the active universe string (or null).
export async function initUniverseBar() {
  const settings = await browser.runtime.sendMessage({ type: 'GET_NX_SETTINGS' }) || {};
  const universes = settings.universes || {};
  const enabled = Object.entries(universes).filter(([, cfg]) => cfg.enabled);

  const bar = document.getElementById('universe-bar');
  bar.innerHTML = '';

  if (!enabled.length) {
    bar.innerHTML = '<span id="universe-bar-hint" style="font-size:0.75rem;color:#484f58;">No universe enabled — open ⚙ Settings to configure.</span>';
    setActiveUniverse(null);
    return null;
  }

  let firstUniverse = null;
  for (const [u, cfg] of enabled) {
    if (!firstUniverse) firstUniverse = u;
    const btn = document.createElement('button');
    btn.className = 'universe-tab' + (u === activeUniverse ? ' active' : '');
    btn.style.setProperty('--u-color', cfg.color || '#56d364');
    btn.dataset.universe = u;
    btn.innerHTML = `<span class="universe-dot"></span>${cfg.label || u.toUpperCase()}`;
    btn.addEventListener('click', () => {
      setActiveUniverse(u);
      document.querySelectorAll('.universe-tab').forEach(b => b.classList.toggle('active', b.dataset.universe === u));
      // Update simulator iframe immediately if it's the active tab.
      if (activeTab === 'simulator') {
        const iframe = document.getElementById('sim-iframe');
        if (iframe) iframe.src = browser.runtime.getURL(`simulator.html?universe=${encodeURIComponent(u)}`);
      }
      applyTabPrefs(u);
      loadAll(u);
    });
    bar.appendChild(btn);
  }

  // Set active universe to the first enabled one if not already set.
  const toActivate = (activeUniverse && universes[activeUniverse]?.enabled) ? activeUniverse : firstUniverse;
  setActiveUniverse(toActivate);
  document.querySelectorAll('.universe-tab').forEach(b => b.classList.toggle('active', b.dataset.universe === toActivate));
  return toActivate;
}

// ── Settings tab ────────────────────────────────────────────────────────────

export async function renderSettingsTab() {
  const settings = await browser.runtime.sendMessage({ type: 'GET_NX_SETTINGS' }) || {};
  const universes = settings.universes || {};
  const container = document.getElementById('settings-universes');
  container.innerHTML = '';

  if (!Object.keys(universes).length) {
    container.innerHTML = '<p style="color:#8b949e;font-size:0.85rem;">No universes configured yet.</p>';
  }

  for (const [u, cfg] of Object.entries(universes)) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; gap:10px; align-items:center; margin-bottom:10px; flex-wrap:wrap;';

    const chk = document.createElement('input');
    chk.type = 'checkbox'; chk.checked = !!cfg.enabled; chk.title = 'Enable this universe';
    chk.addEventListener('change', async () => {
      const s = await browser.runtime.sendMessage({ type: 'GET_NX_SETTINGS' }) || {};
      if (!s.universes) s.universes = {};
      if (!s.universes[u]) s.universes[u] = {};
      s.universes[u].enabled = chk.checked;
      await browser.runtime.sendMessage({ type: 'SET_NX_SETTINGS', settings: s });
      await initUniverseBar();
    });

    const subdomain = document.createElement('code');
    subdomain.textContent = u;
    subdomain.style.cssText = 'background:#161b22; border:1px solid #30363d; padding:2px 8px; border-radius:4px; font-size:0.85rem; color:#58a6ff;';

    const labelInput = document.createElement('input');
    labelInput.type = 'text'; labelInput.value = cfg.label || ''; labelInput.placeholder = 'Label';
    labelInput.style.cssText = 'width:130px; background:#21262d; border:1px solid #30363d; color:#e6edf3; padding:4px 8px; border-radius:6px; font-size:0.85rem;';
    labelInput.addEventListener('change', async () => {
      const s = await browser.runtime.sendMessage({ type: 'GET_NX_SETTINGS' }) || {};
      s.universes[u].label = labelInput.value;
      await browser.runtime.sendMessage({ type: 'SET_NX_SETTINGS', settings: s });
      await initUniverseBar();
    });

    const colorInput = document.createElement('input');
    colorInput.type = 'color'; colorInput.value = cfg.color || '#56d364';
    colorInput.style.cssText = 'width:40px; height:30px; background:#21262d; border:1px solid #30363d; border-radius:6px; cursor:pointer; padding:2px;';
    colorInput.addEventListener('change', async () => {
      const s = await browser.runtime.sendMessage({ type: 'GET_NX_SETTINGS' }) || {};
      s.universes[u].color = colorInput.value;
      await browser.runtime.sendMessage({ type: 'SET_NX_SETTINGS', settings: s });
      await initUniverseBar();
    });

    // Session detection badge
    const sessionBadge = document.createElement('span');
    sessionBadge.style.cssText = 'font-size:0.7rem; color:#8b949e;';
    sessionBadge.textContent = '…';
    browser.runtime.sendMessage({ type: 'CHECK_UNIVERSE_SESSION', universe: u })
      .then(r => { sessionBadge.textContent = r?.hasSession ? '✓ Logged in' : '— No session'; sessionBadge.style.color = r?.hasSession ? '#56d364' : '#484f58'; })
      .catch(() => {});

    const resetBtn = document.createElement('button');
    resetBtn.textContent = 'Reset data';
    resetBtn.style.cssText = 'background:#21262d; border:1px solid #ff7b7244; color:#ff7b72; padding:3px 10px; border-radius:6px; cursor:pointer; font-size:0.75rem;';
    resetBtn.addEventListener('click', async () => {
      if (!await confirmDialog(`Delete ALL data for universe "${cfg.label || u}" (${u})?\n\nThis cannot be undone.`)) return;
      // Remove all keys starting with `${u}:`
      const all = await browser.storage.local.get(null);
      const toRemove = Object.keys(all).filter(k => k.startsWith(`${u}:`));
      if (toRemove.length) await browser.storage.local.remove(toRemove);
      resetBtn.textContent = 'Deleted ✓';
      setTimeout(() => { resetBtn.textContent = 'Reset data'; }, 2000);
      if (activeUniverse === u) await loadAll(u);
    });

    row.append(chk, subdomain, labelInput, colorInput, sessionBadge, resetBtn);
    container.appendChild(row);
  }

  // "Add Universe" button handler (wired once).
  const addBtn = document.getElementById('btn-settings-add');
  if (addBtn && !addBtn.dataset.bound) {
    addBtn.dataset.bound = '1';
    addBtn.addEventListener('click', async () => {
      const sub = document.getElementById('settings-add-subdomain').value.trim().toLowerCase();
      const label = document.getElementById('settings-add-label').value.trim();
      const color = document.getElementById('settings-add-color').value;
      if (!sub || !/^[a-z0-9-]+$/.test(sub)) { alert('Invalid subdomain.'); return; }
      const s = await browser.runtime.sendMessage({ type: 'GET_NX_SETTINGS' }) || {};
      if (!s.universes) s.universes = {};
      if (s.universes[sub]) { alert(`Universe "${sub}" already exists.`); return; }
      s.universes[sub] = { enabled: true, label: label || sub.toUpperCase(), color };
      await browser.runtime.sendMessage({ type: 'SET_NX_SETTINGS', settings: s });
      document.getElementById('settings-add-subdomain').value = '';
      document.getElementById('settings-add-label').value = '';
      await initUniverseBar();
      await renderSettingsTab();
    });
  }

  // ── Tab visibility ────────────────────────────────────────────────────────
  const tabSection = document.getElementById('settings-tab-visibility');
  if (tabSection) {
    tabSection.innerHTML = '';
    const u = activeUniverse;
    const prefs = await loadTabPrefs(u);
    const hidden = new Set(prefs.hidden || []);
    if (u) {
      const hint = document.createElement('p');
      hint.style.cssText = 'font-size:0.75rem; color:#8b949e; margin-bottom:8px;';
      hint.textContent = `Showing settings for universe: ${u.toUpperCase()}`;
      tabSection.appendChild(hint);
    }
    for (const [tab, label] of Object.entries(TAB_LABELS)) {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:8px; font-size:0.85rem; cursor:pointer;';
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = !hidden.has(tab);
      chk.addEventListener('change', async () => {
        const p = await loadTabPrefs(u);
        const h = new Set(p.hidden || []);
        if (chk.checked) h.delete(tab); else h.add(tab);
        p.hidden = [...h];
        await saveTabPrefs(p, u);
        await applyTabPrefs(u);
      });
      row.append(chk, document.createTextNode(label));
      tabSection.appendChild(row);
    }
  }
}

// Show the latest changelog section once after an update (flag set by the
// background's onInstalled handler).
async function maybeShowWhatsNew() {
  const { whatsnew_pending } = await browser.storage.local.get('whatsnew_pending');
  if (!whatsnew_pending) return;
  await browser.storage.local.remove('whatsnew_pending');
  let body = 'See CHANGELOG.md for details.';
  try {
    const md = await (await fetch(browser.runtime.getURL('CHANGELOG.md'))).text();
    const m = md.match(/## \[[^\]]+\][^\n]*\n([\s\S]*?)(?=\n## \[|$)/);
    if (m) body = renderMarkdown(m[1].trim());
  } catch { /* keep fallback */ }
  infoDialog(`What's new in v${whatsnew_pending}`, body);
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const u = activeUniverse;
  const relevant = u
    ? (changes[`${u}:last_scrape`] || changes[`${u}:totals`] || changes[`${u}:pirate_totals`])
    : (changes.last_scrape || changes.totals || changes.pirate_totals);
  if (relevant) loadAll(u);
});
