// The `browser.*` polyfill is loaded by the service-worker entry
// (background-sw.js) via a static import before this module runs, so `browser`
// is defined here on both Chrome (polyfilled) and Firefox (native). Tests import
// this file directly with a stubbed `browser`, skipping the polyfill entirely.

const DEFAULT_UNIVERSE = 's0';
const SETTINGS_KEY = 'nx:settings';   // global, never universe-scoped
function gameUrl(u) { return `https://${u}.nexuslegacy.space`; }
function storeKey(u, k) { return `${u}:${k}`; }   // 's0:totals', 'nf:fleets', …
const REPORTS_PATH = '/api/fleet/survey-reports';
const PIRATES_PATH = '/api/fleet/pirate-reports';
const PVP_PATH = '/api/fleet/reports';   // player-vs-player combat reports
const SPY_PATH = '/api/fleet/spy-reports';
const CAMP_SCOUT_PATH = '/api/fleet/camp-scout-reports';
const PIRATE_CAMPS_PATH = '/api/fleet/pirate-camps';
const WORMHOLES_PATH = '/api/fleet/wormholes';
const MISSIONS_PATH = '/api/fleet/missions';
const RESEARCH_PATH = '/api/research';
const MINING_PATH = '/api/fleet/mining-reports';
const EXPEDITION_PATH = '/api/fleet/expedition-reports';
const WORMHOLE_PATH = '/api/fleet/wormhole-runs';
// xeno_survey (ruins survey) results aren't a fleet report — they arrive as a
// system message with subject "Xeno Survey Complete", body text like "Your
// science team finished the xeno survey. 0 fragments recovered, plus an
// artifact for your collection." No structured loot/moon/zone data at all.
const XENO_MESSAGES_PATH = '/api/messages/system';
const SYSTEM_DEBRIS_PATH = '/api/fleet/system-debris';
const INTEL_KEEP = 200;
const ALARM = 'nexus-scrape';
const INTERVAL_MIN = 15;
// Bump this when stored data shape changes; add a MIGRATIONS entry for it.
const SCHEMA_VERSION = 11;

// ── Setup ──────────────────────────────────────────────────────────────────

// Returns the nx:settings object with default values filled in.
async function getSettings() {
  const raw = await browser.storage.local.get(SETTINGS_KEY);
  const s = raw[SETTINGS_KEY] || {};
  if (!s.universes) s.universes = { [DEFAULT_UNIVERSE]: { enabled: true, label: 'Standard', color: '#56d364' } };
  return s;
}

async function saveSettings(s) {
  await browser.storage.local.set({ [SETTINGS_KEY]: s });
}

// Returns array of enabled universe subdomain strings.
async function getEnabledUniverses() {
  const s = await getSettings();
  return Object.entries(s.universes || {})
    .filter(([, cfg]) => cfg.enabled)
    .map(([u]) => u);
}

browser.runtime.onInstalled.addListener(async details => {
  browser.alarms.create(ALARM, { periodInMinutes: INTERVAL_MIN });
  // Re-arm live-search alarms for any enabled universe that had it on.
  const universes = await getEnabledUniverses();
  for (const u of universes) {
    const key = storeKey(u, 'live_search');
    const raw = await browser.storage.local.get(key);
    if (raw[key]?.enabled) browser.alarms.create(LS_ALARM, { periodInMinutes: LS_INTERVAL_MIN });
  }
  // Snapshot existing data before the new version touches it.
  if (details.reason === 'update') {
    await browser.storage.local.set({ whatsnew_pending: browser.runtime.getManifest().version });
    try {
      await backupToDownloads(`pre-update-${details.previousVersion || 'unknown'}`);
    } catch (err) {
      console.warn('[NexusAccounting] Pre-update backup failed:', err);
    }
  }
  await scrape();
});

browser.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) scrape();
  if (alarm.name === LS_ALARM) liveSearchScanAll();
});

// ── Asteroid live search ───────────────────────────────────────────────────
// Scans the N nearest explored systems every 5 minutes (background alarm, runs
// regardless of focus) and fires a system notification when a field newly
// matches the saved filter. Mirrors tabs/asteroids.js scan(), API-only.
const LS_ALARM = 'nexus-livesearch';
const LS_INTERVAL_MIN = 5;
const LS_REQ_DELAY_MS = 40;            // polite spacing between API calls
const LS_ABORT_AFTER_ERRORS = 6;       // bail the scan after this many consecutive API failures
const lsSectorCache = new Map();       // sectorId → { at, systems }, reused across scans
const LS_SECTOR_TTL = 15 * 60 * 1000;

async function setLiveSearch(config, universe = DEFAULT_UNIVERSE) {
  const key = storeKey(universe, 'live_search');
  await browser.storage.local.set({ [key]: config });
  if (config && config.enabled) {
    browser.alarms.create(LS_ALARM, { periodInMinutes: LS_INTERVAL_MIN });
    // Config (filter/planet) may have changed — reset seen so matches re-notify.
    await browser.storage.local.set({ [storeKey(universe, 'live_search_seen')]: [] });
    liveSearchScan(universe);   // run one immediately so the user isn't waiting 5 min
  } else {
    // Only clear the alarm if NO enabled universe has live-search on.
    const universes = await getEnabledUniverses();
    const anyOn = await Promise.any(universes.map(async u => {
      const k = storeKey(u, 'live_search');
      const r = await browser.storage.local.get(k);
      if (r[k]?.enabled) return true;
      return Promise.reject();
    })).catch(() => false);
    if (!anyOn) browser.alarms.clear(LS_ALARM);
  }
  return { ok: true };
}

async function stopLiveSearch(universe = DEFAULT_UNIVERSE) {
  const key = storeKey(universe, 'live_search');
  const raw = await browser.storage.local.get(key);
  await browser.storage.local.set({ [key]: { ...(raw[key] || {}), enabled: false } });
  // Clear global alarm only if no other universe has it on.
  const universes = await getEnabledUniverses();
  const anyOn = await Promise.any(universes.map(async u => {
    const k = storeKey(u, 'live_search');
    const r = await browser.storage.local.get(k);
    if (r[k]?.enabled) return true;
    return Promise.reject();
  })).catch(() => false);
  if (!anyOn) browser.alarms.clear(LS_ALARM);
  return { ok: true };
}

// Sector systems with a cross-scan TTL cache (names/zones change rarely).
async function lsSectorSystems(sectorId, token, universe) {
  const cacheKey = `${universe}:${sectorId}`;
  const hit = lsSectorCache.get(cacheKey);
  if (hit && Date.now() - hit.at < LS_SECTOR_TTL) return hit.systems;
  const systems = (await apiFetch(`/api/galaxy/sectors/${sectorId}/systems`, token, { polite: true }, universe)).systems || [];
  lsSectorCache.set(cacheKey, { at: Date.now(), systems });
  return systems;
}

function fieldMatches(f, cfg) {
  const leftPct = f.totalResources ? (f.remainingResources / f.totalResources) * 100 : null;
  if (cfg.types?.length && !cfg.types.includes(f.fieldType)) return false;
  if (cfg.zones?.length && !cfg.zones.includes(f.zone)) return false;
  if (cfg.multMin != null && !((f.richness ?? -Infinity) >= cfg.multMin)) return false;
  if (cfg.qtyMin != null && !((f.remainingResources ?? -Infinity) >= cfg.qtyMin)) return false;
  if (cfg.leftMin != null && !((leftPct ?? -Infinity) >= cfg.leftMin)) return false;
  return true;
}

async function liveSearchScanAll() {
  const universes = await getEnabledUniverses();
  for (const u of universes) await liveSearchScan(u);
}

async function liveSearchScan(universe = DEFAULT_UNIVERSE) {
  const cfgKey = storeKey(universe, 'live_search');
  const raw = await browser.storage.local.get(cfgKey);
  const cfg = raw[cfgKey];
  if (!cfg || !cfg.enabled || cfg.planetId == null) return;
  const token = await getToken(universe);
  if (!token) return;

  try {
    const planets = (await getPlanets(universe)).planets || [];
    const planet = planets.find(p => p.id === cfg.planetId);
    if (!planet || planet.systemId == null) return;
    const map = await apiFetch('/api/galaxy/map', token, { polite: true }, universe);
    const src = (map.systems || []).find(s => s.id === planet.systemId);
    if (!src) return;

    const want = Math.max(1, Math.min(500, cfg.near || 25));
    const targets = (map.systems || [])
      .filter(s => s.id !== src.id && (s.visibility === 'full' || s.visibility === 'partial'))
      .map(s => ({ s, d: Math.hypot(s.x - src.x, s.y - src.y) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, want)
      .map(o => o.s);

    const matches = [];
    let errStreak = 0;
    for (const sys of targets) {
      let sector;
      try { sector = await lsSectorSystems(sys.sectorId, token, universe); }
      catch { if (++errStreak >= LS_ABORT_AFTER_ERRORS) break; continue; }
      const meta = sector.find(s => s.id === sys.id);
      if (!meta || !meta.planetCount) { errStreak = 0; continue; }
      let data;
      try { data = await apiFetch(`/api/galaxy/systems/${sys.id}/planets`, token, { polite: true }, universe); }
      catch { if (++errStreak >= LS_ABORT_AFTER_ERRORS) break; continue; }
      errStreak = 0;
      for (const f of (data.asteroidFields || [])) {
        const zone = meta.securityZone || 'unknown';
        if (fieldMatches({ ...f, zone }, cfg)) {
          matches.push({
            id: f.id,
            name: f.name || `#${f.id}`,
            system: meta.name || `#${sys.id}`,
            systemId: sys.id,
            type: f.fieldType || '—',
            mult: f.richness ?? null,
            remaining: f.remainingResources ?? null,
            leftPct: f.totalResources ? Math.round((f.remainingResources / f.totalResources) * 100) : null,
            zone,
            controllerName: f.controllerName || null,
          });
        }
      }
      await new Promise(r => setTimeout(r, LS_REQ_DELAY_MS));   // be polite to the game API
    }

    const seenKey = storeKey(universe, 'live_search_seen');
    const seenRaw = await browser.storage.local.get(seenKey);
    const seen = new Set(seenRaw[seenKey] || []);
    const fresh = matches.filter(m => !seen.has(m.id));
    // Keep the full current match list + timestamp for the on-click results window.
    await browser.storage.local.set({
      [storeKey(universe, 'live_search_seen')]: matches.map(m => m.id),
      [storeKey(universe, 'live_search_last_matches')]: matches,
      [storeKey(universe, 'live_search_last_at')]: Date.now(),
    });

    if (fresh.length) {
      const top = fresh[0];
      browser.notifications.create(`${LS_ALARM}-${universe}-${Date.now()}`, {
        type: 'basic',
        iconUrl: browser.runtime.getURL('icons/icon128.png'),
        title: `🪨 [${universe.toUpperCase()}] Asteroid match`,
        message: fresh.length === 1
          ? `${top.name} (${top.type}) in ${top.system} matches your live search.`
          : `${fresh.length} new fields match your live search — incl. ${top.name} in ${top.system}.`,
      });
    }
  } catch (err) {
    console.warn('[NexusAccounting] Live search failed:', err);
  }
}

// Clicking a live-search notification focuses (or opens) the correct universe game tab.
browser.notifications?.onClicked?.addListener(async id => {
  if (!id.startsWith(LS_ALARM)) return;
  browser.notifications.clear(id);
  // Extract universe from notification id: `nexus-livesearch-{universe}-{timestamp}`
  const parts = id.split('-');
  const universe = parts[2] || DEFAULT_UNIVERSE;
  const gameOrigin = gameUrl(universe) + '/';
  const panelKey = storeKey(universe, 'live_search_open_panel');
  const tabs = await browser.tabs.query({ url: `*://${universe}.nexuslegacy.space/*` });
  if (tabs.length) {
    const t = tabs[0];
    await browser.tabs.update(t.id, { active: true });
    if (t.windowId != null) browser.windows.update(t.windowId, { focused: true });
    browser.tabs.sendMessage(t.id, { type: 'SHOW_LS_RESULTS' }).catch(() => {});
  } else {
    await browser.storage.local.set({ [panelKey]: true });
    browser.tabs.create({ url: gameOrigin });
  }
});

browser.action.onClicked.addListener(() => {
  browser.tabs.create({ url: browser.runtime.getURL('dashboard.html') });
});

browser.runtime.onMessage.addListener(msg => {
  const u = msg.universe || DEFAULT_UNIVERSE;
  if (msg.type === 'SCRAPE_NOW') return scrapeUniverse(u).then(() => ({ ok: true }));
  if (msg.type === 'GET_FLEET') return getFleet(msg.planetId, u);
  if (msg.type === 'GET_SHIP_DEFS') return getShipDefs(u);
  if (msg.type === 'GET_PLANET_SHIPS') return getPlanetShips(msg.planetId, u);
  if (msg.type === 'GET_MISSIONS') return apiGet('/api/fleet/missions', u);
  if (msg.type === 'GET_FUEL_ESTIMATE') {
    // POST: routed through the game tab (same-origin) — a Bearer POST from the
    // extension carries an Origin header the server 500s on.
    return gamePost('/api/fleet/fuel-estimate', msg.body, u).then(r => (r && r.ok) ? r.data : r);
  }
  if (msg.type === 'GET_SURVEY_COOLDOWNS') return apiGet('/api/fleet/survey-cooldowns', u);
  if (msg.type === 'GET_SURVEY_REPORTS') return apiGet('/api/fleet/survey-reports', u);
  if (msg.type === 'SEND_MINE') {
    return gamePost('/api/fleet/mine', {
      sourcePlanetId: msg.sourcePlanetId, targetFieldId: msg.targetFieldId,
      ships: msg.ships, miningDuration: msg.miningDuration,
    }, u);
  }
  if (msg.type === 'SEND_SURVEY') {
    return gamePost('/api/fleet/survey', {
      sourcePlanetId: msg.sourcePlanetId, targetSystemId: msg.targetSystemId, ships: msg.ships,
    }, u);
  }
  if (msg.type === 'SEND_INVESTIGATE') {
    return gamePost('/api/fleet/investigate', {
      sourcePlanetId: msg.sourcePlanetId, reportId: msg.reportId, ships: msg.ships,
    }, u);
  }
  if (msg.type === 'COLLECT_DEBRIS') {
    return gamePost('/api/fleet/collect-debris', {
      sourcePlanetId: msg.sourcePlanetId, debrisId: msg.debrisId, ships: msg.ships,
    }, u);
  }
  if (msg.type === 'COLLECT_SALVAGE') {
    return gamePost('/api/fleet/collect-salvage', {
      sourcePlanetId: msg.sourcePlanetId, reportId: msg.reportId, ships: msg.ships,
    }, u);
  }
  if (msg.type === 'SEND_EXPEDITION') {
    return gamePost('/api/fleet/expedition', {
      sourcePlanetId: msg.sourcePlanetId, ships: msg.ships, zone: msg.zone, depth: msg.depth,
    }, u);
  }
  if (msg.type === 'SEND_XENO_SURVEY') {
    return gamePost('/api/fleet/xeno-survey', {
      sourcePlanetId: msg.sourcePlanetId, targetMoonId: msg.targetMoonId, ships: msg.ships,
    }, u);
  }
  if (msg.type === 'GET_PLANETS') return getPlanets(u);
  if (msg.type === 'REBUILD_AGGREGATES') return enqueue(() => rebuildAggregates(u)).then(() => ({ ok: true }));
  if (msg.type === 'PURGE_OLD') return enqueue(() => purgeOldData(msg.days ?? 3, u)).then(() => ({ ok: true }));
  if (msg.type === 'BACKUP_NOW') return backupToDownloads(msg.reason || 'manual').then(() => ({ ok: true })).catch(e => ({ error: e.message }));
  if (msg.type === 'GET_ARMS') return apiGet('/api/galaxy/arms', u);
  if (msg.type === 'GET_GALAXY_MAP') return apiGet('/api/galaxy/map', u);
  if (msg.type === 'GET_SYSTEM_PLANETS') return apiGet(`/api/galaxy/systems/${msg.systemId}/planets`, u);
  if (msg.type === 'GET_ARM_SECTORS') return apiGet(`/api/galaxy/arms/${msg.armId}/sectors`, u);
  if (msg.type === 'GET_SECTOR_SYSTEMS') return apiGet(`/api/galaxy/sectors/${msg.sectorId}/systems`, u);
  if (msg.type === 'GET_PLAYER_ALLIANCE_TAG') return getPlayerAllianceTag(msg.name, u);
  if (msg.type === 'GET_AUTH_ME') return apiGet('/api/auth/me', u);
  if (msg.type === 'GET_SYSTEM_COORDS') return getSystemCoords(msg.names || [], msg.ids || [], u);
  if (msg.type === 'GET_ALLIANCE') return getAlliance(u);
  if (msg.type === 'GET_PLAYER_RANK') return getPlayerRanks(msg.name, u);
  if (msg.type === 'GET_RESOURCES') return getResources(u);
  if (msg.type === 'GET_HUBS') return apiGet('/api/market/hubs', u);
  if (msg.type === 'GET_MARKET_ORDERS') return getOrders('/api/market/orders', u);
  if (msg.type === 'GET_ALLIANCE_ORDERS') return getOrders('/api/alliance-trade/orders', u);
  if (msg.type === 'START_RESEARCH') return startResearch(msg.researchId, msg.planetId, msg.useFragments, u);
  if (msg.type === 'SET_LIVE_SEARCH') return setLiveSearch(msg.config, u);
  if (msg.type === 'STOP_LIVE_SEARCH') return stopLiveSearch(u);
  if (msg.type === 'GET_NX_SETTINGS') return getSettings();
  if (msg.type === 'SET_NX_SETTINGS') return saveSettings(msg.settings).then(() => ({ ok: true }));
  if (msg.type === 'CHECK_UNIVERSE_SESSION') return checkUniverseSession(msg.universe);
});

// Launch a research on a planet: POST /api/research/{id}/start { planetId }.
// (Endpoint mirrors the game client.) Refreshes stored state on success so the
// dashboard reflects the new active research.
async function startResearch(researchId, planetId, useFragments = false, universe = DEFAULT_UNIVERSE) {
  const token = await getToken(universe);
  if (!token) return { error: `Not logged in to ${universe}.nexuslegacy.space.` };
  if (researchId == null || planetId == null) return { error: 'Missing research or planet id.' };
  try {
    const body = { planetId };
    if (useFragments) body.useFragments = true;
    const r = await fetch(`${gameUrl(universe)}/api/research/${researchId}/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let m = `${r.status}`;
      try { const j = await r.json(); m = j.message || j.error || m; } catch { /* non-JSON */ }
      return { error: `Start failed: ${m}` };
    }
    const data = await r.json().catch(() => ({}));
    await scrape();   // pick up the new active research
    return { ok: true, data };
  } catch (e) {
    return { error: e.message };
  }
}

// The highest-level Research Lab building in a planet response, or null.
// `buildings` sits at the response wrapper level (a sibling of `planet`), so
// pass the whole response; scan every array field for the research_lab entry.
function findResearchLab(resp) {
  let best = null;
  for (const v of Object.values(resp || {})) {
    if (!Array.isArray(v)) continue;
    for (const b of v) {
      if (b?.definition?.key === 'research_lab' || b?.key === 'research_lab') {
        if (!best || (b.level || 0) > (best.level || 0)) best = b;
      }
    }
  }
  return best;
}

// Total stored resources + production rates across all your planets, plus
// research-planner inputs: highest research-lab level (+ its definition and the
// host planet's build-speed), the count of planets (= parallel research slots),
// and any in-progress lab upgrade end time.
async function getResources(universe = DEFAULT_UNIVERSE) {
  const token = await getToken(universe);
  if (!token) return { error: `Not logged in to ${universe}.nexuslegacy.space.` };
  try {
    const data = await apiFetch('/api/planets', token, {}, universe);
    const planets = data.planets || [];
    const keys = ['ore', 'silicates', 'hydrogen', 'alloys',
      'oreRate', 'silicatesRate', 'hydrogenRate', 'alloysRate'];
    const tot = Object.fromEntries(keys.map(k => [k, 0]));
    let labLevel = 0, labDef = null, buildSpeedMult = 1, labUpgradeEndsAt = null;
    const researchPlanets = [];
    for (const p of planets) {
      const d = await apiFetch(`/api/planets/${p.id}`, token, {}, universe);
      const pl = d.planet || d;
      for (const k of keys) tot[k] += pl[k] || 0;
      const lab = findResearchLab(d);
      if (lab && (lab.level || 0) > labLevel) {
        labLevel = lab.level || 0;
        labDef = lab.definition || null;
        buildSpeedMult = d.buildSpeedMult || 1;
        labUpgradeEndsAt = lab.isUpgrading ? (lab.upgradeEndsAt || null) : null;
      }
      try {
        const r = await apiFetch(`/api/research?planetId=${p.id}`, token, {}, universe);
        researchPlanets.push({ id: p.id, name: p.name || `Planet #${p.id}`, mult: r.researchSpeedMult || 1 });
      } catch { /* skip this planet's slot */ }
    }
    tot.labLevel = labLevel;
    tot.labDef = labDef;
    tot.buildSpeedMult = buildSpeedMult;
    tot.labUpgradeEndsAt = labUpgradeEndsAt;
    tot.planetCount = planets.length;
    tot.researchPlanets = researchPlanets;
    tot.planetSpeeds = researchPlanets.map(rp => rp.mult);
    return tot;
  } catch (err) {
    return { error: err.message };
  }
}

// Your alliance tag + member ids, so the finder can flag alliance-owned
// planets it scans.
async function getAlliance(universe = DEFAULT_UNIVERSE) {
  const token = await getToken(universe);
  if (!token) return { error: `Not logged in to ${universe}.nexuslegacy.space.` };
  try {
    const data = await apiFetch('/api/alliances/my', token, {}, universe);
    const a = data.alliance || {};
    const members = a.members || [];
    return {
      tag: a.tag || null,
      name: a.name || null,
      memberIds: members.map(m => m.userId).filter(x => x != null),
    };
  } catch (err) {
    return { error: err.message };
  }
}

// Look up a player's per-category leaderboard ranks by exact name (finder
// rank columns). `category=` re-ranks the board; `rank` then holds that
// category's rank. One request per category.
async function getPlayerRanks(name, universe = DEFAULT_UNIVERSE) {
  if (!name) return { military: null, economy: null, research: null };
  const out = { military: null, economy: null, research: null };
  for (const cat of ['military', 'economy', 'research']) {
    const data = await apiGet(`/api/rankings/players?category=${cat}&search=${encodeURIComponent(name)}`, universe);
    if (data.error) return data;
    const lb = data.leaderboard || [];
    const e = lb.find(x => x.username === name) || lb[0];
    if (e) out[cat] = e.rank;
  }
  return out;
}

// A player's current alliance tag by exact username (asteroid field outpost
// owners), via the same leaderboard search endpoint.
async function getPlayerAllianceTag(name, universe = DEFAULT_UNIVERSE) {
  if (!name) return { tag: null };
  const data = await apiGet(`/api/rankings/players?category=military&search=${encodeURIComponent(name)}`, universe);
  if (data.error) return data;
  const e = (data.leaderboard || []).find(x => x.username === name);
  return { tag: e ? (e.allianceTag || null) : null };
}

function jwtRace(token) {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(payload)).race ?? null;
  } catch {
    return null;
  }
}

// All open orders from a paginated orders endpoint (public market or alliance
// trade), across every page.
async function getOrders(path, universe = DEFAULT_UNIVERSE) {
  const token = await getToken(universe);
  if (!token) return { error: `Not logged in to ${universe}.nexuslegacy.space.` };
  try {
    const first = await apiFetch(`${path}?page=1&limit=100`, token, {}, universe);
    const limit = first.pagination?.limit || 100;        // server may cap below 100
    const total = first.pagination?.total ?? (first.orders || []).length;
    const orders = [...(first.orders || [])];
    const pages = Math.ceil(total / limit);
    if (pages > 1) {
      const rest = await Promise.all(
        Array.from({ length: pages - 1 }, (_, i) =>
          apiFetch(`${path}?page=${i + 2}&limit=${limit}`, token, {}, universe)
            .then(d => d.orders || []).catch(() => [])));
      for (const o of rest) orders.push(...o);
    }
    return { orders };
  } catch (err) {
    return { error: err.message };
  }
}

// Authenticated GET for dashboard pages (they have no cookie access of their own).
async function apiGet(path, universe = DEFAULT_UNIVERSE) {
  const token = await getToken(universe);
  if (!token) return { error: `Not logged in to ${universe}.nexuslegacy.space.` };
  try {
    return await apiFetch(path, token, {}, universe);
  } catch (err) {
    return { error: err.message };
  }
}

// ── Error Handling ────────────────────────────────────────────────────────────

/**
 * Typed API error with status code for better error handling and logging.
 */
class NexusAPIError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'NexusAPIError';
    this.status = status;
  }
}

// ── Auth ───────────────────────────────────────────────────────────────────

// Find the nexus_token cookie for a specific universe. Searches all cookie stores.
async function getToken(universe = DEFAULT_UNIVERSE) {
  const NAME = 'nexus_token';
  const base = gameUrl(universe);
  const urls = [base, 'https://nexuslegacy.space'];

  const lookup = async (storeId) => {
    const store = storeId ? { storeId } : {};
    for (const url of urls) {
      try {
        const c = await browser.cookies.get({ url, name: NAME, ...store });
        if (c?.value) return c.value;
      } catch { /* store may not support get */ }
    }
    try {
      const all = await browser.cookies.getAll({ domain: 'nexuslegacy.space', name: NAME, ...store });
      const hit = (all || []).find(c => c.value);
      if (hit) return hit.value;
    } catch { /* ignore */ }
    return null;
  };

  const direct = await lookup(null);
  if (direct) return direct;

  let storeIds = [];
  try {
    const stores = await browser.cookies.getAllCookieStores();
    storeIds = (stores || []).map(s => s.id);
    for (const s of (stores || [])) {
      const v = await lookup(s.id);
      if (v) return v;
    }
  } catch (e) {
    console.warn('[NexusAccounting] getAllCookieStores failed:', e.message);
  }

  console.warn(`[NexusAccounting][${universe}] nexus_token not found. Checked default + stores: [${storeIds.join(', ')}]. ` +
    `Open the game (logged in) in a normal tab, or check the cookie exists on ${universe}.nexuslegacy.space.`);
  return null;
}

// Check if the user has an active session for a specific universe (for Settings auto-detection).
async function checkUniverseSession(universe) {
  const token = await getToken(universe);
  return { hasSession: !!token };
}

// ── API ────────────────────────────────────────────────────────────────────

// Proactive rate-limit throttle. The server advertises its budget on every
// response (`RateLimit-Remaining` / `RateLimit-Reset`, policy 400/60s). Track the
// last-seen values and pause before sending once the remaining budget dips below
// RL_MIN_REMAINING, until the window resets — so a big scan self-paces instead of
// waiting to get 429'd. The reactive Retry-After path below still backstops.
const RL_MIN_REMAINING = 20;     // headroom to keep under the limit
let rlRemaining = Infinity;      // last-seen RateLimit-Remaining
let rlResetAt = 0;               // epoch ms when the current window resets

function updateRateLimit(headers) {
  const rem = parseInt(headers.get('ratelimit-remaining'), 10);
  const reset = parseFloat(headers.get('ratelimit-reset'));   // seconds until reset
  if (Number.isFinite(rem)) rlRemaining = rem;                // authoritative — corrects drift
  if (Number.isFinite(reset)) rlResetAt = Date.now() + reset * 1000;
}

// Wait while low on budget and the window hasn't reset, then reserve one slot
// optimistically (corrected by the next response header) so parallel callers
// don't all slip through before any response updates the count.
// polite: if true, uses larger buffer (40) for background scans; if false, uses smaller buffer (5).
async function rateLimitGate(polite = false) {
  const buffer = polite ? 40 : 5;
  while (rlRemaining <= buffer && Date.now() < rlResetAt) {
    await new Promise(res => setTimeout(res, Math.min(Math.max(rlResetAt - Date.now(), 0) + 100, 2000)));
  }
  rlRemaining--;
}

// Enhanced API fetch with robust error handling, retry logic, and optional polite mode.
// options: { polite?: boolean } - if true, uses larger rate-limit buffer for background ops
async function apiFetch(path, token, options = {}, universe = DEFAULT_UNIVERSE) {
  const { polite = false } = options;
  const baseUrl = gameUrl(universe);
  let lastError = null;
  let delayMs = 1000;
  const maxAttempts = 4;

  // Retry on 429 (rate limit), 5xx errors, or network issues with exponential backoff.
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await rateLimitGate(polite);
    let r;
    try {
      r = await fetch(`${baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (e) {
      // Network error (fetch failed entirely)
      if (attempt < maxAttempts) {
        lastError = e;
        await new Promise(res => setTimeout(res, delayMs));
        delayMs *= 2; // exponential backoff
        continue;
      }
      throw new NexusAPIError(0, `API ${path} → network error: ${e.message}`);
    }

    updateRateLimit(r.headers);

    // Handle success
    if (r.ok) {
      // Parse JSON or empty response; fallback to empty object on empty body
      try {
        const text = await r.text();
        return text ? JSON.parse(text) : {};
      } catch (e) {
        throw new NexusAPIError(r.status, `API ${path} → failed to parse response: ${e.message}`);
      }
    }

    // Handle 401 Unauthorized — dispatch global auth event
    if (r.status === 401) {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('nexus:auth-failed'));
      }
      const msg = `API ${path} → ${r.status} Unauthorized. Please log in to Nexus Legacy.`;
      throw new NexusAPIError(401, msg);
    }

    // Parse error message from response
    let errorMsg = `${r.statusText || 'Request failed with status ' + r.status}`;
    try {
      const errorText = await r.text();
      if (errorText) {
        const errorData = JSON.parse(errorText);
        errorMsg = errorData.message || errorData.error || errorMsg;
      }
    } catch { /* fallback to default errorMsg */ }

    // Retry on 429 or 5xx errors
    if ((r.status === 429 || r.status >= 500) && attempt < maxAttempts) {
      lastError = new NexusAPIError(r.status, `API ${path} → ${errorMsg}`);
      const retryAfter = parseFloat(r.headers.get('Retry-After'));
      const waitTime = Number.isFinite(retryAfter) ? retryAfter * 1000 : delayMs;
      await new Promise(res => setTimeout(res, waitTime));
      delayMs *= 2; // exponential backoff
      continue;
    }

    // Non-retryable error
    throw new NexusAPIError(r.status, `API ${path} → ${errorMsg}`);
  }

  throw lastError || new NexusAPIError(0, `API ${path} → fetch failed after ${maxAttempts} attempts`);
}

// Home planet id, discovered once via /api/planets and cached per universe.
async function getHomePlanetId(token, universe = DEFAULT_UNIVERSE) {
  const key = storeKey(universe, 'planet_id');
  const raw = await browser.storage.local.get(key);
  if (raw[key]) return raw[key];
  const data = await apiFetch('/api/planets', token, {}, universe);
  const planets = data.planets || [];
  const home = planets.find(p => p.isHomeworld) || planets[0];
  if (!home) throw new Error('No planets found for this account');
  await browser.storage.local.set({ [key]: home.id });
  console.log(`[NexusAccounting][${universe}] Home planet: ${home.name} (#${home.id})`);
  return home.id;
}

// ── Fuel ─────────────────────────────────────────────────────────────────────
// Hydrogen burned by a mission: fuel = Σ(fuelRate × qty) × (FUEL_K × distance + FUEL_BASE)
// Constants fitted to 14 real send-fleet costs spanning mixed fleets and
// distances (mean error ~6%). Verified accurate for survey missions.
// NOTE: m.distance from the API is NOT in the same units as galaxy-map
// coordinates — the simulator uses COORD_TO_FUEL_AU (1/57.4) to convert.
const FUEL_K    = 0.0496;
const FUEL_BASE = 3.48;

// Map a mission type to a dashboard tab key for fuel accounting.
function fuelMissionType(t) {
  const s = (t || '').toLowerCase();
  if (s.includes('debris')) return 'debris';
  if (s.includes('xeno')) return 'xeno';   // must precede the 'survey' check below
  if (s.includes('survey') || s.includes('investigate') || s.includes('anomaly')) return 'survey';
  if (s.includes('min')) return 'mining';
  if (s.includes('raid') || s.includes('pirate') || s.includes('attack')) return 'pirate';
  if (s.includes('expedition') || s.includes('wormhole')) return 'expedition';
  return 'other';
}

function fleetFuelRate(fleetMap, ships) {
  // `ships` is keyed by numeric id; build a key→def index (fleets use keys).
  const byKey = {};
  for (const d of Object.values(ships || {})) if (d && d.key) byKey[d.key] = d;
  let rate = 0;
  for (const [key, qty] of Object.entries(fleetMap || {})) {
    const def = ships[key] || byKey[key];
    if (def) rate += (def.fuelRate || 0) * qty;
  }
  return rate;
}

// Precise fuel from a captured mission: its real fleet + real distance.
function missionFuel(mo, ships) {
  if (!mo || mo.distance == null || !(mo.fleet && mo.fleet.length)) return null;
  const fleetMap = mo.fleet.reduce((m, i) => { m[i.key] = (m[i.key] || 0) + (i.quantity || 1); return m; }, {});
  const rate = fleetFuelRate(fleetMap, ships);
  if (!rate) return null;
  return Math.round(rate * (FUEL_K * mo.distance + FUEL_BASE));
}

// Exact fuel from the game's own fuel-estimate, using the mission's real fleet
// and route. Returns null if the route/fleet is incomplete or no game tab is
// open (the POST must route through one) — caller falls back to missionFuel().
async function apiMissionFuel(m) {
  if (m.sourcePlanetId == null || m.targetSystemId == null) return null;
  const ships = (m.fleetComposition || [])
    .map(f => ({ shipDefId: f.shipDefId, quantity: f.quantity || 1 }))
    .filter(s => s.shipDefId != null && s.quantity > 0);
  if (!ships.length) return null;
  const r = await gamePost('/api/fleet/fuel-estimate', {
    sourcePlanetId: m.sourcePlanetId, targetSystemId: m.targetSystemId, ships,
  });
  const data = (r && r.ok) ? r.data : r;
  return (data && data.error == null && data.fuelCost != null) ? data.fuelCost : null;
}

// Current stationed fleet as { shipKey: usableQuantity } — for the simulator.
async function getPlanets(universe = DEFAULT_UNIVERSE) {
  const token = await getToken(universe);
  if (!token) return { error: `Not logged in to ${universe}.nexuslegacy.space.` };
  try {
    const data = await apiFetch('/api/planets', token, {}, universe);
    const planets = (data.planets || []).map(p => ({
      id: p.id,
      name: p.name || `Planet ${p.id}`,
      isHomeworld: !!p.isHomeworld,
      systemId: p.systemId ?? p.system?.id ?? null,
      systemName: p.systemName || null,
    }));
    return { planets };
  } catch (err) {
    return { error: err.message };
  }
}

async function getFleet(planetId, universe = DEFAULT_UNIVERSE) {
  const token = await getToken(universe);
  if (!token) return { error: `Not logged in to ${universe}.nexuslegacy.space.` };
  try {
    let targets;
    if (planetId === 'all') {
      const data = await apiFetch('/api/planets', token, {}, universe);
      targets = (data.planets || []).map(p => p.id);
    } else {
      // 'home' is the static HTML fallback when the dropdown hasn't been populated yet.
      targets = [(!planetId || planetId === 'home') ? await getHomePlanetId(token, universe) : planetId];
    }
    const fleet = {};
    for (const id of targets) {
      const data = await apiFetch(`/api/planets/${id}/fleet`, token, {}, universe);
      for (const f of (data.fleet || [])) {
        const key = f.definition?.key;
        const qty = (f.quantity || 0) - (f.damagedQuantity || 0);
        if (key && qty > 0) fleet[key] = (fleet[key] || 0) + qty;
      }
    }
    return { fleet };
  } catch (err) {
    return { error: err.message };
  }
}

// Full ship catalog (all types, owned or not) from the shipyard.
async function getShipDefs(universe = DEFAULT_UNIVERSE) {
  const token = await getToken(universe);
  if (!token) return { error: `Not logged in to ${universe}.nexuslegacy.space.` };
  try {
    const planetId = await getHomePlanetId(token, universe);
    const data = await apiFetch(`/api/planets/${planetId}/shipyard`, token, {}, universe);
    const race = jwtRace(token);
    const ships = (data.ships || []).map(s => ({
      shipDefId: s.id,
      key: s.key || '',
      name: s.name || `#${s.id}`,
      cargoCapacity: s.cargoCapacity || 0,
      imageUrl: (race && s.key) ? `${gameUrl(universe)}/api/images/ships/${race}/${s.key}.webp` : null,
      shipClass: s.shipClass || '',
      miningCargo: s.miningCargoCapacity || 0,
      sortOrder: s.sortOrder || 0,
      attack: s.attack || 0,
      hp: s.hp || 0,
      shieldHp: s.shieldHp || 0,
      weaponType: s.weaponType || null,
      armorType: s.armorType || '',
    }));
    return { ships };
  } catch (err) {
    return { error: err.message };
  }
}

// Ships actually available on one planet, as { shipDefId: undamagedQuantity }.
async function getPlanetShips(planetId, universe = DEFAULT_UNIVERSE) {
  const token = await getToken(universe);
  if (!token) return { error: `Not logged in to ${universe}.nexuslegacy.space.` };
  if (planetId == null) return { error: 'No planet selected.' };
  try {
    const data = await apiFetch(`/api/planets/${planetId}/fleet`, token, {}, universe);
    const available = {};
    for (const f of (data.fleet || [])) {
      const qty = (f.quantity || 0) - (f.damagedQuantity || 0);
      if (qty > 0) available[f.shipDefId] = qty;
    }
    return { available };
  } catch (err) {
    return { error: err.message };
  }
}

// fuel-estimate has its own tighter scope (40/10s, 120/min) separate from the
// global RateLimit-* budget apiFetch tracks. gamePost responses come back via
// the content script as {ok,data}/{error} with no headers relayed, so this
// gates client-side on the known caps instead of reading server state.
const FUEL_EST_TIMES = [];
async function fuelEstimateGate() {
  for (;;) {
    const now = Date.now();
    while (FUEL_EST_TIMES.length && now - FUEL_EST_TIMES[0] > 60000) FUEL_EST_TIMES.shift();
    const in10s = FUEL_EST_TIMES.filter(t => now - t <= 10000).length;
    if (FUEL_EST_TIMES.length < 120 && in10s < 40) break;
    await new Promise(res => setTimeout(res, 250));
  }
  FUEL_EST_TIMES.push(Date.now());
}

// POST a fleet action through the game tab's content script (same-origin + cookies).
async function gamePost(path, body, universe = DEFAULT_UNIVERSE) {
  if (!(body.ships || []).length) return { error: 'No ships selected.' };
  if (path === '/api/fleet/fuel-estimate') await fuelEstimateGate();
  const token = await getToken(universe);
  const gameTabUrl = `https://${universe}.nexuslegacy.space/*`;
  // Use native API (chrome for Chrome, browser for Firefox via polyfill)
  const api = typeof chrome !== 'undefined' && chrome.tabs ? chrome : browser;
  const tabs = await api.tabs.query({ url: gameTabUrl });
  if (!tabs.length) return { error: `Open the ${universe.toUpperCase()} game in a tab first.` };

  // Preferred path: delegate to the content script which is already running in
  // the page context with the correct origin and session cookies.
  try {
    const tabs2 = await browser.tabs.query({ url: gameTabUrl });
    if (!tabs2.length) return { error: `Open the ${universe.toUpperCase()} game in a tab first.` };
    // Retry on 429, honouring Retry-After, then exponential backoff — same policy as apiFetch.
    for (let attempt = 0; ; attempt++) {
      const r = await browser.tabs.sendMessage(tabs2[0].id, { type: 'GAME_FETCH', method: 'POST', path, token, body });
      if (r && r.status === 429 && attempt < 4) {
        const ra = parseFloat(r.retryAfter);
        await new Promise(res => setTimeout(res, Number.isFinite(ra) ? ra * 1000 : 500 * 2 ** attempt));
        continue;
      }
      return r;
    }
  } catch (e) {
    if (!e.message || !e.message.includes('Receiving end does not exist')) {
      return { error: e.message };
    }
    // Content script not running — fall through to scripting API fallback.
  }

  // Fallback: execute the fetch directly in the page context via the scripting API
  // (available because the `scripting` permission + host_permissions cover this origin).
  // All args must be JSON-serialisable — path (string), token (string), body (object) are.
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: async (fetchPath, fetchToken, fetchBody) => {
        const r = await fetch(fetchPath, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            ...(fetchToken ? { Authorization: `Bearer ${fetchToken}` } : {}),
          },
          body: JSON.stringify(fetchBody),
        });
        const text = await r.text();
        if (!r.ok) {
          let m = `${r.status}`;
          try { const j = JSON.parse(text); m = j.message || j.error || m; }
          catch { if (text) m = `${r.status}: ${text.slice(0, 200)}`; }
          return { error: m };
        }
        let data = {};
        try { data = JSON.parse(text); } catch { /* empty / non-JSON body is fine */ }
        return { ok: true, data };
      },
      args: [path, token, body],
    });
    return results[0]?.result ?? { error: 'Script injection returned no result.' };
  } catch (e2) {
    return { error: `Could not reach the game tab. Please reload it and try again. (${e2.message})` };
  }
}

// ── Processing queue ───────────────────────────────────────────────────────
// All storage writes go through one chain so an intercepted game response
// and a scheduled scrape can never interleave their read-modify-write cycles.

let processing = Promise.resolve();

function enqueue(fn) {
  processing = processing.then(fn).catch(async err => {
    console.error('[NexusAccounting] Processing failed:', err);
    await browser.storage.local.set({ last_error: err.message });
  });
  return processing;
}

// ── Report archives ─────────────────────────────────────────────────────────
// Uncapped history, sharded by month (`survey_archive_2026-06`, …) so a scrape
// only rewrites the current month instead of the whole history. The index
// tracks shard months and counts per type.

const ARCHIVE_TYPES = ['survey', 'pirate', 'mining', 'exp', 'xeno'];

// Backfills any ARCHIVE_TYPES entry missing from a stored index (e.g. a type
// added after the index was first written, like 'xeno') so every caller can
// assume idx[type] exists without checking.
async function getArchiveIndex(universe = DEFAULT_UNIVERSE) {
  const key = storeKey(universe, 'archive_index');
  const raw = await browser.storage.local.get(key);
  const idx = raw[key] || {};
  for (const t of ARCHIVE_TYPES) if (!idx[t]) idx[t] = { months: [], count: 0 };
  return idx;
}

async function appendToArchive(type, records, universe = DEFAULT_UNIVERSE) {
  if (!records.length) return;
  const index = await getArchiveIndex(universe);
  const byMonth = {};
  for (const r of records) {
    const m = (r.created_at || '').slice(0, 7) || 'unknown';
    (byMonth[m] = byMonth[m] || []).push(r);
  }
  for (const [m, recs] of Object.entries(byMonth)) {
    const archKey = storeKey(universe, `${type}_archive_${m}`);
    const cur = (await browser.storage.local.get(archKey))[archKey] || [];
    await browser.storage.local.set({ [archKey]: [...recs, ...cur] });
    if (!index[type].months.includes(m)) index[type].months.push(m);
    index[type].count += recs.length;
  }
  index[type].months.sort();
  await browser.storage.local.set({ [storeKey(universe, 'archive_index')]: index });
}

async function loadArchive(type, universe = DEFAULT_UNIVERSE) {
  const index = await getArchiveIndex(universe);
  const keys = index[type].months.map(m => storeKey(universe, `${type}_archive_${m}`));
  if (!keys.length) return [];
  const got = await browser.storage.local.get(keys);
  const out = [];
  for (const k of keys) out.push(...(got[k] || []));
  return out;
}

// Drop every stored record older than `days`, keeping only the recent window.
async function purgeOldData(days = 3, universe = DEFAULT_UNIVERSE) {
  const cutoff = Date.now() - days * 86400000;
  const keep = r => new Date(r.created_at || 0).getTime() >= cutoff;
  const index = await getArchiveIndex(universe);
  const patch = {};
  const remove = [];
  for (const type of ARCHIVE_TYPES) {
    const months = index[type].months || [];
    const keys = months.map(m => storeKey(universe, `${type}_archive_${m}`));
    const got = keys.length ? await browser.storage.local.get(keys) : {};
    const keptMonths = [];
    let count = 0;
    for (const m of months) {
      const key = storeKey(universe, `${type}_archive_${m}`);
      const kept = (got[key] || []).filter(keep);
      if (kept.length) { patch[key] = kept; keptMonths.push(m); count += kept.length; }
      else remove.push(key);
    }
    index[type] = { months: keptMonths, count };
  }
  patch[storeKey(universe, 'archive_index')] = index;
  const recentKeys = ['recent_reports', 'pirate_recent_reports', 'mining_recent_reports', 'exp_recent_reports']
    .map(k => storeKey(universe, k));
  const recents = await browser.storage.local.get(recentKeys);
  for (const k of recentKeys) if (Array.isArray(recents[k])) patch[k] = recents[k].filter(keep);
  await browser.storage.local.set(patch);
  if (remove.length) await browser.storage.local.remove(remove);
  await rebuildAggregates(universe);
  return { ok: true };
}

// ── Processors ─────────────────────────────────────────────────────────────

function parseShipsLost(shipsLost) {
  const counts = {};
  for (const item of (shipsLost || [])) {
    const id = item.shipDefId;
    if (id != null) counts[id] = (counts[id] || 0) + (item.quantity || 1);
  }
  return counts;
}

// A damaged ship costs half its build cost to repair.
const REPAIR_FACTOR = 0.5;

function emptyResources() {
  return { ore: 0, silicates: 0, hydrogen: 0, alloys: 0, rare: {} };
}

// Value a tolerant ship-loss array into `into`. Items may be keyed by
// shipDefId ({ shipDefId, quantity }) or by ship key ({ key, lost }) — combat
// results (shipsDestroyed) use the latter. ships is the defId-keyed catalog.
function addLossCost(arr, ships, into, factor = 1) {
  if (!arr || !arr.length) return;
  let byKey = addLossCost._byKey;
  if (!byKey || byKey._for !== ships) {
    byKey = { _for: ships };
    for (const s of Object.values(ships)) if (s && s.key) byKey[s.key] = s;
    addLossCost._byKey = byKey;
  }
  for (const it of arr) {
    const ship = (it.shipDefId != null && ships[it.shipDefId]) || (it.key && byKey[it.key]);
    if (!ship) continue;
    const q = (it.quantity ?? it.lost ?? it.destroyed ?? 1) * factor;
    into.ore += q * (ship.costOre || 0);
    into.silicates += q * (ship.costSilicates || 0);
    into.hydrogen += q * (ship.costHydrogen || 0);
    into.alloys += q * (ship.costAlloys || 0);
    for (const [k, v] of Object.entries(ship.rareCosts || {})) {
      into.rare[k] = (into.rare[k] || 0) + q * v;
    }
  }
}
function emptyLost() {
  return { destroyed: emptyResources(), repair: emptyResources() };
}

// Add the build-cost value of a { shipDefId: qty } map into `into`, scaled by
// factor (1 for destroyed ships, REPAIR_FACTOR for damaged ones).
function addShipCost(detail, ships, into, factor) {
  for (const [defId, qty] of Object.entries(detail || {})) {
    const ship = ships[defId];
    if (!ship) continue;
    const q = qty * factor;
    into.ore += q * ship.costOre;
    into.silicates += q * ship.costSilicates;
    into.hydrogen += q * ship.costHydrogen;
    into.alloys += q * ship.costAlloys;
    for (const [k, v] of Object.entries(ship.rareCosts || {})) {
      into.rare[k] = (into.rare[k] || 0) + q * v;
    }
  }
}

// ── Security zones ──────────────────────────────────────────────────────────
// Only survey reports carry securityZone directly. For others we resolve the
// zone from the system in their location string via a cached system→zone map
// built from the galaxy map (refreshed at most once a day — it's large).

const ZONE_REFRESH_MS = 24 * 3600 * 1000;

async function getSystemZones(token, universe = DEFAULT_UNIVERSE) {
  const k = (s) => storeKey(universe, s);
  const keys = [k('system_zones'), k('system_zones_at'), k('system_coords_by_id')];
  const stored = await browser.storage.local.get(keys);
  const system_zones = stored[k('system_zones')];
  const system_zones_at = stored[k('system_zones_at')];
  if (system_zones && system_zones_at && stored[k('system_coords_by_id')] && Date.now() - system_zones_at < ZONE_REFRESH_MS) {
    return system_zones;
  }
  try {
    const data = await apiFetch('/api/galaxy/map', token, {}, universe);
    const map = {};
    const byId = {};
    const coordsById = {};
    const coordsByName = {};
    for (const s of (data.systems || [])) {
      if (s.securityZone) {
        if (s.name) map[s.name] = s.securityZone;
        if (s.id != null) byId[s.id] = s.securityZone;
      }
      if (s.id != null && s.x != null) {
        coordsById[s.id] = { x: s.x, y: s.y, name: s.name || null };
        if (s.name) coordsByName[s.name] = { x: s.x, y: s.y };
      }
    }
    await browser.storage.local.set({
      [k('system_zones')]: map, [k('system_zone_by_id')]: byId, [k('system_zones_at')]: Date.now(),
      [k('system_coords_by_id')]: coordsById, [k('system_coords_by_name')]: coordsByName,
    });
    return map;
  } catch {
    return system_zones || {};
  }
}

async function getSystemCoords(names, ids, universe = DEFAULT_UNIVERSE) {
  const keys = [storeKey(universe, 'system_coords_by_id'), storeKey(universe, 'system_coords_by_name')];
  const stored = await browser.storage.local.get(keys);
  const byId = stored[storeKey(universe, 'system_coords_by_id')] || {};
  const byName = stored[storeKey(universe, 'system_coords_by_name')] || {};
  const result = {};
  for (const n of names) result[n] = byName[n] || null;
  for (const id of ids) result[id] = byId[id] || null;
  return result;
}

// "A12-27 / A12-27-AF1" or "A12-27-AF1" → system "A12-27".
function systemFromLocation(loc) {
  if (!loc) return null;
  const dest = loc.includes('/') ? loc.split('/').pop().trim() : loc.trim();
  const m = dest.match(/^([A-Za-z]+\d+-\d+)/);
  return m ? m[1] : null;
}

function resolveZone(systemName, zones) {
  return (systemName && zones[systemName]) || 'unknown';
}

// Pirate reports reference only a campId; pirate-camps maps that to a system,
// which the galaxy map maps to a zone. Cached so completed-raid reports (and
// the back-fill) can resolve their zone.
async function getCampZones(token, zones, universe = DEFAULT_UNIVERSE) {
  const key = storeKey(universe, 'camp_zones');
  let camps;
  try {
    camps = (await apiFetch(PIRATE_CAMPS_PATH, token, {}, universe)).camps || [];
  } catch {
    const raw = await browser.storage.local.get(key);
    return raw[key] || {};
  }
  const raw = await browser.storage.local.get(key);
  const map = { ...(raw[key] || {}) };
  for (const c of camps) {
    if (c.id != null) map[c.id] = resolveZone(c.systemName, zones);
  }
  await browser.storage.local.set({ [key]: map });
  return map;
}

async function getWormholeZones(token, zones, universe = DEFAULT_UNIVERSE) {
  const wzKey = storeKey(universe, 'wormhole_zones');
  const wcKey = storeKey(universe, 'wormhole_classes');
  let holes;
  try {
    holes = (await apiFetch(WORMHOLES_PATH, token, {}, universe)).wormholes || [];
  } catch {
    const raw = await browser.storage.local.get(wzKey);
    return raw[wzKey] || {};
  }
  const got = await browser.storage.local.get([wzKey, wcKey]);
  const map = { ...(got[wzKey] || {}) };
  const classes = { ...(got[wcKey] || {}) };
  for (const w of holes) {
    if (w.id == null) continue;
    map[w.id] = resolveZone(w.systemName, zones);
    if (w.wormholeClass) classes[w.id] = w.wormholeClass;
  }
  await browser.storage.local.set({ [wzKey]: map, [wcKey]: classes });
  return map;
}

async function backfillZones(zones, campZones = {}, wormholeZones = {}, universe = DEFAULT_UNIVERSE) {
  const bfKey = storeKey(universe, 'zones_backfilled');
  const raw = await browser.storage.local.get(bfKey);
  if (raw[bfKey]) return;

  const recentKey = {
    survey: storeKey(universe, 'recent_reports'), pirate: storeKey(universe, 'pirate_recent_reports'),
    mining: storeKey(universe, 'mining_recent_reports'), exp: storeKey(universe, 'exp_recent_reports'),
    xeno: storeKey(universe, 'xeno_recent_reports'),
  };
  const whId = r => r.wormhole_id ?? (String(r.location || '').match(/Wormhole #(\d+)/) || [])[1];
  const stamp = (r, type) => {
    if (r.zone) return r;
    if (type === 'survey') r.zone = resolveZone(r.system_name, zones);
    else if (type === 'mining') r.zone = resolveZone(systemFromLocation(r.location), zones);
    else if (type === 'exp') r.zone = wormholeZones[whId(r)] || resolveZone(systemFromLocation(r.location), zones);
    else if (type === 'pirate') r.zone = campZones[r.camp_id] || 'unknown';
    else r.zone = 'unknown';
    return r;
  };

  const idx = await getArchiveIndex(universe);
  for (const type of ARCHIVE_TYPES) {
    const keys = [recentKey[type], ...idx[type].months.map(m => storeKey(universe, `${type}_archive_${m}`))];
    for (const key of keys) {
      const got = await browser.storage.local.get(key);
      if (got[key]) await browser.storage.local.set({ [key]: got[key].map(r => stamp(r, type)) });
    }
  }
  await browser.storage.local.set({ [bfKey]: true });
  console.log(`[NexusAccounting][${universe}] Zone back-fill complete.`);
}

// Ship catalog keyed by shipDefId
function buildShipCatalog(shipyardData) {
  const ships = {};
  for (const s of (shipyardData.ships || [])) {
    ships[s.id] = {
      key: s.key,
      name: s.name,
      costOre: s.costOre || 0,
      costSilicates: s.costSilicates || 0,
      costHydrogen: s.costHydrogen || 0,
      costAlloys: s.costAlloys || 0,
      rareCosts: s.rareCosts || {},
      // Combat stats for the simulator
      hp: s.hp || 0,
      shieldHp: s.shieldHp || 0,
      attack: s.attack || 0,
      weaponType: s.weaponType || null,
      armorType: s.armorType || null,
      shipClass: s.shipClass || 'utility',
      shipSize: s.shipSize || 'small',
      sortOrder: s.sortOrder || 0,
      // Logistics
      fuelRate: s.fuelRate || 0,            // hydrogen per AU travelled
      cargoCapacity: s.cargoCapacity || 0,
    };
  }
  return ships;
}

// Alloys + exotic resources collected (beyond ore/silicates/hydrogen).
const EXTRA_RES_KEYS = ['alloys', 'cryo_ice', 'quantum_dust', 'plasma_core', 'dark_matter', 'antimatter'];
function addExtraRes(target, loot) {
  for (const k of EXTRA_RES_KEYS) { const v = loot[k] || 0; if (v) target[k] = (target[k] || 0) + v; }
}
function extrasOf(loot) {
  const o = {};
  for (const k of EXTRA_RES_KEYS) { const v = loot[k] || 0; if (v) o[k] = v; }
  return o;
}

async function processSurveyReports(reports, ships, zones = {}, universe = DEFAULT_UNIVERSE) {
  const keys = ['seen_ids', 'totals', 'daily', 'hourly', 'resources_lost',
    'event_breakdown', 'recent_reports', 'records_cap'].map(k => storeKey(universe, k));
  const stored = await browser.storage.local.get(keys);
  const sk = k => storeKey(universe, k);
  const recordsCap = stored[sk('records_cap')] ?? 5000;

  const seenIds = new Set(stored[sk('seen_ids')] || []);
  const totals = stored[sk('totals')] || {
    ore: 0, hydrogen: 0, silicates: 0, missions: 0, ships_lost: 0,
    first_report: null, last_report: null,
  };

  const dailyMap = {};
  for (const d of (stored[sk('daily')] || [])) dailyMap[d.day] = { ...d };

  const hourlyMap = {};
  for (const h of (stored[sk('hourly')] || [])) hourlyMap[h.hour] = { ...h };

  const resourcesLost = stored[sk('resources_lost')]?.destroyed ? stored[sk('resources_lost')] : emptyLost();

  const eventMap = {};
  for (const e of (stored[sk('event_breakdown')] || [])) eventMap[e.event_type] = { ...e };

  const recentReports = [...(stored[sk('recent_reports')] || [])];

  const newReports = reports.filter(r => !seenIds.has(r.id));

  for (const r of newReports) {
    // Not yet investigated — anomaly pending exploration, skip and retry next scrape.
    if (!r.investigated) continue;
    // Loot not yet collected — skip and retry next scrape.
    if (r.uncollectedLoot !== null) continue;

    seenIds.add(r.id);
    const loot = r.loot || {};
    const ore = loot.ore || 0;
    const hydrogen = loot.hydrogen || 0;
    const silicates = loot.silicates || 0;
    const nLost = (r.shipsLost || []).reduce((sum, item) => sum + (item.quantity || 1), 0);
    const lostDetail = parseShipsLost(r.shipsLost);
    const damagedDetail = parseShipsLost(r.shipsDamaged);
    const nDamaged = Object.values(damagedDetail).reduce((sum, q) => sum + q, 0);

    totals.ore += ore;
    totals.hydrogen += hydrogen;
    totals.silicates += silicates;
    totals.missions += 1;
    totals.ships_lost += nLost;
    addExtraRes(totals, loot);

    const day = r.createdAt.slice(0, 10);
    if (!dailyMap[day]) dailyMap[day] = { day, ore: 0, hydrogen: 0, silicates: 0, missions: 0, ships_lost: 0 };
    dailyMap[day].ore += ore;
    dailyMap[day].hydrogen += hydrogen;
    dailyMap[day].silicates += silicates;
    dailyMap[day].missions += 1;
    dailyMap[day].ships_lost += nLost;
    addExtraRes(dailyMap[day], loot);

    const hour = r.createdAt.slice(0, 13) + ':00';
    if (!hourlyMap[hour]) hourlyMap[hour] = { hour, ore: 0, hydrogen: 0, silicates: 0, missions: 0, ships_lost: 0 };
    hourlyMap[hour].ore += ore;
    hourlyMap[hour].hydrogen += hydrogen;
    hourlyMap[hour].silicates += silicates;
    hourlyMap[hour].missions += 1;
    hourlyMap[hour].ships_lost += nLost;
    addExtraRes(hourlyMap[hour], loot);

    const et = r.eventType || 'unknown';
    if (!eventMap[et]) eventMap[et] = { event_type: et, count: 0, ore: 0, hydrogen: 0, silicates: 0 };
    eventMap[et].count += 1;
    eventMap[et].ore += ore;
    eventMap[et].hydrogen += hydrogen;
    eventMap[et].silicates += silicates;
    addExtraRes(eventMap[et], loot);

    addShipCost(lostDetail, ships, resourcesLost.destroyed, 1);
    addShipCost(damagedDetail, ships, resourcesLost.repair, REPAIR_FACTOR);

    recentReports.unshift({
      id: r.id,
      created_at: r.createdAt,
      system_name: r.systemName,
      event_type: r.eventType,
      zone: r.securityZone || resolveZone(r.systemName, zones),
      ore, hydrogen, silicates, ...extrasOf(loot),
      ships_lost: nLost,
      ships_damaged: nDamaged,
      wormholes_detected: r.wormholesDetected || 0,
      ships_lost_detail: lostDetail,
      ships_damaged_detail: damagedDetail,
      ...(r.combatLog ? (d => ({
        combat_outcome: r.combatLog.outcome || r.outcome || null,
        debris_ore: d.ore, debris_alloys: d.alloys, debris_silicates: d.silicates,
        rounds: combatRounds(r),
        your_fleet: combatFleet(r, 'attackerFleet'), enemy_fleet: combatFleet(r, 'defenderFleet'),   // you investigate, pirates defend
      }))(combatDebris(r)) : {}),
    });
  }

  // Backfill: enrich already-stored combat surveys whose record predates the
  // combat fields (or stored a null outcome from the old top-level `r.outcome`
  // path — survey outcome is actually nested in combatLog). Patches in place,
  // never touches totals/seen, so no double-count. Idempotent + self-limiting:
  // gated on `your_fleet` (the last-added field) so records enriched by an
  // earlier build — which set combat_outcome but not the fleets — still get
  // patched, while fully-enriched records are skipped.
  // ponytail: runs every scrape but only mutates records still missing fields.
  const recentById = new Map(recentReports.map(rr => [rr.id, rr]));
  for (const r of reports) {
    if (!r.combatLog) continue;
    const rec = recentById.get(r.id);
    if (!rec || (rec.your_fleet && rec.your_fleet.length)) continue;   // re-patch records left with an empty fleet
    const d = combatDebris(r);
    rec.combat_outcome = r.combatLog.outcome || r.outcome || null;
    rec.debris_ore = d.ore; rec.debris_alloys = d.alloys; rec.debris_silicates = d.silicates;
    rec.rounds = combatRounds(r);
    rec.your_fleet = combatFleet(r, 'attackerFleet');
    rec.enemy_fleet = combatFleet(r, 'defenderFleet');
  }

  const timestamps = reports.map(r => r.createdAt).sort();
  if (timestamps.length) {
    totals.first_report = timestamps[0];
    totals.last_report = timestamps[timestamps.length - 1];
  }

  const addedSurveys = recentReports.length - (stored[sk('recent_reports')] || []).length;
  await appendToArchive('survey', recentReports.slice(0, addedSurveys), universe);

  await browser.storage.local.set({
    [sk('seen_ids')]: [...seenIds],
    [sk('totals')]: totals,
    [sk('daily')]: Object.values(dailyMap).sort((a, b) => a.day.localeCompare(b.day)),
    [sk('hourly')]: Object.values(hourlyMap).sort((a, b) => a.hour.localeCompare(b.hour)),
    [sk('resources_lost')]: resourcesLost,
    [sk('event_breakdown')]: Object.values(eventMap).sort((a, b) => b.count - a.count),
    [sk('recent_reports')]: recentReports.slice(0, recordsCap),
    [sk('last_scrape')]: new Date().toISOString(),
    [sk('last_error')]: null,
    schema_version: SCHEMA_VERSION,
  });

  return newReports.length;
}

async function processPirateReports(pirateReports, ships, campZones = {}, universe = DEFAULT_UNIVERSE) {
  const sk = k => storeKey(universe, k);
  const keys = ['pirate_seen_ids', 'pirate_totals', 'pirate_daily', 'pirate_resources_lost',
    'pirate_outcomes', 'pirate_debris_total', 'pirate_recent_reports', 'records_cap'].map(sk);
  const pstored = await browser.storage.local.get(keys);
  const recordsCap = pstored[sk('records_cap')] ?? 5000;

  const pirateSeen = new Set(pstored[sk('pirate_seen_ids')] || []);
  const pirateTotals = pstored[sk('pirate_totals')] || {
    ore: 0, hydrogen: 0, silicates: 0, raids: 0,
    ships_destroyed: 0, ships_damaged: 0, pirates_destroyed: 0,
    first_report: null, last_report: null,
  };

  const pirateDailyMap = {};
  for (const d of (pstored[sk('pirate_daily')] || [])) pirateDailyMap[d.day] = { ...d };

  const pirateLost = pstored[sk('pirate_resources_lost')]?.destroyed ? pstored[sk('pirate_resources_lost')] : emptyLost();

  const outcomeMap = {};
  for (const o of (pstored[sk('pirate_outcomes')] || [])) outcomeMap[o.outcome] = { ...o };

  const pirateDebris = pstored[sk('pirate_debris_total')] || { ore: 0, alloys: 0, silicates: 0 };
  const pirateRecent = [...(pstored[sk('pirate_recent_reports')] || [])];

  const newPirateReports = pirateReports.filter(r => !pirateSeen.has(r.id));

  for (const r of newPirateReports) {
    pirateSeen.add(r.id);
    const loot = r.loot || {};
    const ore = loot.ore || 0;
    const hydrogen = loot.hydrogen || 0;
    const silicates = loot.silicates || 0;

    // attackerLosses items: { shipDefId, lost, damaged, destroyed } —
    // only destroyed ships are gone for good, damaged ones survive.
    const destroyedDetail = {};
    const damagedDetail = {};
    let nDestroyed = 0, nDamaged = 0;
    for (const item of (r.attackerLosses || [])) {
      const destroyed = item.destroyed ?? item.lost ?? 0;
      const damaged = item.damaged || 0;
      nDestroyed += destroyed;
      nDamaged += damaged;
      if (item.shipDefId != null && destroyed) {
        destroyedDetail[item.shipDefId] = (destroyedDetail[item.shipDefId] || 0) + destroyed;
      }
      if (item.shipDefId != null && damaged) {
        damagedDetail[item.shipDefId] = (damagedDetail[item.shipDefId] || 0) + damaged;
      }
    }
    const piratesDestroyed = (r.pirateLosses || [])
      .reduce((sum, i) => sum + (i.destroyed ?? i.lost ?? 0), 0);

    pirateTotals.ore += ore;
    pirateTotals.hydrogen += hydrogen;
    pirateTotals.silicates += silicates;
    pirateTotals.raids += 1;
    pirateTotals.ships_destroyed += nDestroyed;
    pirateTotals.ships_damaged += nDamaged;
    pirateTotals.pirates_destroyed += piratesDestroyed;
    addExtraRes(pirateTotals, loot);

    const day = r.createdAt.slice(0, 10);
    if (!pirateDailyMap[day]) pirateDailyMap[day] = { day, ore: 0, hydrogen: 0, silicates: 0, raids: 0, ships_destroyed: 0 };
    pirateDailyMap[day].ore += ore;
    pirateDailyMap[day].hydrogen += hydrogen;
    pirateDailyMap[day].silicates += silicates;
    addExtraRes(pirateDailyMap[day], loot);
    pirateDailyMap[day].raids += 1;
    pirateDailyMap[day].ships_destroyed += nDestroyed;

    const outcome = r.outcome || 'unknown';
    if (!outcomeMap[outcome]) outcomeMap[outcome] = { outcome, count: 0, ore: 0, hydrogen: 0, silicates: 0 };
    outcomeMap[outcome].count += 1;
    outcomeMap[outcome].ore += ore;
    outcomeMap[outcome].hydrogen += hydrogen;
    outcomeMap[outcome].silicates += silicates;

    const debris = r.debris || {};
    pirateDebris.ore += debris.ore || 0;
    pirateDebris.alloys += debris.alloys || 0;
    pirateDebris.silicates += debris.silicates || 0;

    addShipCost(destroyedDetail, ships, pirateLost.destroyed, 1);
    addShipCost(damagedDetail, ships, pirateLost.repair, REPAIR_FACTOR);

    pirateRecent.unshift({
      id: r.id,
      created_at: r.createdAt,
      camp_id: r.campId,
      zone: r.securityZone || campZones[r.campId] || 'unknown',
      outcome,
      ore, hydrogen, silicates, ...extrasOf(loot),
      ships_lost: nDestroyed,
      ships_damaged: nDamaged,
      pirates_destroyed: piratesDestroyed,
      debris_ore: debris.ore || 0,
      debris_alloys: debris.alloys || 0,
      debris_silicates: debris.silicates || 0,
      ships_lost_detail: destroyedDetail,
      ships_damaged_detail: damagedDetail,
      // Fleet compositions kept so the simulator can replay this battle
      // and measure engine accuracy against the real outcome.
      attacker_fleet: (r.attackerFleet || []).map(i => ({ key: i.key, quantity: i.quantity || 1 })),
      pirate_fleet: (r.pirateFleet || []).map(i => ({ key: i.key, quantity: i.quantity || 1 })),
      rounds: combatRounds(r),
    });
  }

  const pirateTimestamps = pirateReports.map(r => r.createdAt).sort();
  if (pirateTimestamps.length) {
    pirateTotals.first_report = pirateTimestamps[0];
    pirateTotals.last_report = pirateTimestamps[pirateTimestamps.length - 1];
  }

  // Backfill: pirate records stored before the round log was captured keep their
  // fleets but no rounds, so the tab can't render them like survey/mining. Patch
  // rounds in place from the live API. Gated on a non-empty rounds array.
  // ponytail: runs every scrape but only mutates records still missing rounds.
  const pirateById = new Map(pirateRecent.map(rr => [rr.id, rr]));
  for (const r of pirateReports) {
    const rec = pirateById.get(r.id);
    if (!rec || (rec.rounds && rec.rounds.length)) continue;
    rec.rounds = combatRounds(r);
  }

  await appendToArchive('pirate', pirateRecent.slice(0, pirateRecent.length - (pstored[sk('pirate_recent_reports')] || []).length), universe);

  await browser.storage.local.set({
    [sk('pirate_seen_ids')]: [...pirateSeen],
    [sk('pirate_totals')]: pirateTotals,
    [sk('pirate_daily')]: Object.values(pirateDailyMap).sort((a, b) => a.day.localeCompare(b.day)),
    [sk('pirate_resources_lost')]: pirateLost,
    [sk('pirate_outcomes')]: Object.values(outcomeMap).sort((a, b) => b.count - a.count),
    [sk('pirate_debris_total')]: pirateDebris,
    [sk('pirate_recent_reports')]: pirateRecent.slice(0, recordsCap),
    [sk('last_scrape')]: new Date().toISOString(),
    [sk('last_error')]: null,
    schema_version: SCHEMA_VERSION,
  });

  return newPirateReports.length;
}

// Tolerant fleet extraction: any array of { key, quantity } shaped items.
function extractFleet(arr) {
  const out = [];
  for (const i of (arr || [])) {
    if (i && typeof i.key === 'string' && (i.quantity || 0) > 0) {
      out.push({ key: i.key, quantity: i.quantity });
    }
  }
  return out;
}

// Spy reports → defender intel for the simulator (latest INTEL_KEEP kept).
async function processSpyReports(reports, universe = DEFAULT_UNIVERSE) {
  if (!reports.length) return 0;
  const key = storeKey(universe, 'spy_reports');
  const raw = await browser.storage.local.get(key);
  const byId = {};
  for (const r of (raw[key] || [])) byId[r.id] = r;
  for (const r of reports) {
    byId[r.id] = {
      id: r.id,
      created_at: r.createdAt,
      outcome: r.outcome,
      target_name: r.targetPlanetName || r.targetStationName || r.targetFieldName || 'unknown target',
      target_user: r.targetUsername || null,
      target_system_id:   r.targetSystemId   || null,
      target_system_name: r.targetSystemName || null,
      fleet: extractFleet(r.fleetData),
      buildings: r.buildingData || [],
      defense: r.defenseData || null,
      resources: r.resourceData || {},
    };
  }
  const merged = Object.values(byId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, INTEL_KEEP);
  await browser.storage.local.set({ [storeKey(universe, 'spy_reports')]: merged });
  return merged.length;
}

// Camp scout reports → pirate camp intel.
async function processCampScoutReports(reports, universe = DEFAULT_UNIVERSE) {
  if (!reports.length) return 0;
  const key = storeKey(universe, 'camp_scout_reports');
  const raw = await browser.storage.local.get(key);
  const byId = {};
  for (const r of (raw[key] || [])) byId[r.id] = r;
  for (const r of reports) {
    const fleet = extractFleet(r.pirateFleet) .length ? extractFleet(r.pirateFleet)
      : extractFleet(r.fleet).length ? extractFleet(r.fleet)
      : extractFleet(r.campFleet);
    byId[r.id] = {
      id: r.id,
      created_at: r.createdAt,
      camp_id: r.campId ?? null,
      fleet,
    };
  }
  const merged = Object.values(byId)
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .slice(0, INTEL_KEEP);
  await browser.storage.local.set({ [storeKey(universe, 'camp_scout_reports')]: merged });
  return merged.length;
}

// Sum numeric resource entries, ignoring internal "_"-prefixed keys
// (mining resourcesDelivered carries _cyclesDone etc.).
function numericResources(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (!k.startsWith('_') && typeof v === 'number' && v > 0) out[k] = v;
  }
  return out;
}

// Alloy cost to repair one breakdown, per drill type (game cost). The broken
// drills show up as `damagedQuantity` on the report's fleetComposition entry.
// ponytail: only known drills charged; add a key when a new drill ships.
const DRILL_MAINTENANCE_ALLOY = { miner: 15, ice_drill: 25 };

// Total alloy maintenance for a mining report = Σ damagedQuantity × cost[key].
function maintenanceAlloys(fleetComposition) {
  let a = 0;
  for (const f of (fleetComposition || [])) a += (DRILL_MAINTENANCE_ALLOY[f.shipKey] || 0) * (f.damagedQuantity || 0);
  return a;
}

// Debris a combat report generated. Pirate reports carry it at the top level
// (r.debris); survey and mining-raid reports nest it under combatLog.debris.
function combatDebris(r) {
  const d = (r && r.debris) || (r && r.combatLog && r.combatLog.debris) || {};
  return { ore: d.ore || 0, alloys: d.alloys || 0, silicates: d.silicates || 0 };
}

// Normalize a combat fleet ([{ key/name, quantity }]) for the Battles tab,
// keeping the name so enemy ships absent from your shipyard still display.
function normFleet(arr) {
  return (arr || []).map(f => ({ key: f.key || f.shipKey, name: f.name || null, quantity: f.quantity || 1 }))
    .filter(f => f.quantity > 0 && (f.key || f.name));
}
// A named combat fleet — nested under combatLog for survey/mining raids,
// top-level for pirate reports.
function combatFleet(r, name) {
  return normFleet((r.combatLog && r.combatLog[name]) || r[name]);
}

// A fleet given by shipDefId ([{ shipDefId, quantity }] — wormhole currentFleet),
// resolved to key/name via the ship catalog.
function defIdFleet(arr, ships) {
  return (arr || []).map(f => {
    const s = (ships && ships[f.shipDefId]) || {};
    return { key: s.key || null, name: s.name || `#${f.shipDefId}`, quantity: f.quantity || 1 };
  }).filter(f => f.quantity > 0);
}

// Trimmed combat encounters from a wormhole run's encounterLog — each is its own
// battle (own outcome + round log). Your fleet is the run's currentFleet.
function wormholeEncounters(r, ships) {
  const yourFleet = defIdFleet(r.currentFleet, ships);
  return (r.encounterLog || [])
    .filter(e => e && e.combat)
    .map((e, i) => ({
      title: e.title || e.type || `Encounter ${e.encounter ?? i + 1}`,
      outcome: e.outcome || null,
      lost: (e.shipsLost || []).reduce((s, x) => s + (x.quantity ?? x.lost ?? 1), 0),
      rounds: combatRounds({ rounds: e.combatRounds }),
      your_fleet: yourFleet,
    }));
}

// Trimmed round-by-round combat log for the Battles tab. Pirate reports keep
// rounds at the top level; survey/mining raids nest them under combatLog.
// Per round: damage + kills + remaining HP% for each side (attacker = you).
function combatRounds(r) {
  const raw = (r && r.rounds) || (r && r.combatRounds)
    || (r && r.combatLog && (r.combatLog.rounds || r.combatLog.combatRounds)) || [];
  const kills = e => ((e && e.shipsDestroyed) || []).map(s => ({ name: s.name || s.key, qty: s.lost || 0 }));
  return raw.map(rd => {
    const ev = {};
    for (const e of (rd.events || [])) ev[e.side] = e;
    return {
      round: rd.round,
      atk_dmg: (ev.attacker && ev.attacker.totalDamage) || 0,
      def_dmg: (ev.defender && ev.defender.totalDamage) || 0,
      atk_hp: rd.attackerHpPercent ?? null,
      def_hp: rd.defenderHpPercent ?? null,
      atk_killed: kills(ev.attacker),
      def_killed: kills(ev.defender),
    };
  });
}

const CORE_RESOURCES = ['ore', 'silicates', 'hydrogen', 'alloys'];

function addResources(target, res) {
  for (const [k, v] of Object.entries(res)) {
    if (CORE_RESOURCES.includes(k)) target[k] += v;
    else target.rare[k] = (target.rare[k] || 0) + v;
  }
}

// Player-vs-player combat reports for the battles tab. The list endpoint
// (/api/fleet/reports) omits the fleets/rounds/debris, so for each new report we
// fetch the detail (/api/fleet/reports/{id}) to store a full battle record: side
// fought on, win/loss, our real-ship losses (defense buildings have negative
// shipDefId + no build cost → excluded), opponent, both fleets, the round log, the
// debris field, and the loot (gained if we attacked, lost if we defended).
async function processPvpReports(reports, universe = DEFAULT_UNIVERSE) {
  const sk = k => storeKey(universe, k);
  const pvpKeys = ['pvp_seen_ids', 'pvp_recent_reports', 'records_cap'].map(sk);
  const stored = await browser.storage.local.get(pvpKeys);
  const cap = stored[sk('records_cap')] ?? 5000;
  const seen = new Set(stored[sk('pvp_seen_ids')] || []);
  const recent = [...(stored[sk('pvp_recent_reports')] || [])];
  const CORE = ['ore', 'silicates', 'hydrogen', 'alloys'];
  const fresh = reports.filter(r => !seen.has(r.id));
  if (!fresh.length) return 0;
  const token = await getToken(universe);
  let n = 0;
  for (const lite of fresh) {
    seen.add(lite.id);   // mark seen even if we skip it, so it's not reconsidered
    // /api/fleet/reports is a generic combat feed — most entries are pirate/NPC
    // encounters (no opponent profile). Keep only real player-vs-player fights.
    const liteSide = lite.currentUserBattleSide === 'defender' ? 'defender' : 'attacker';
    const liteOpp = liteSide === 'attacker' ? lite.defenderProfile : lite.attackerProfile;
    if (!liteOpp || !liteOpp.username) continue;
    let r = lite;
    if (token) {
      try { const det = await apiFetch(`/api/fleet/reports/${lite.id}`, token, {}, universe); if (det && det.report) r = det.report; }
      catch { /* fall back to the list record */ }
    }
    const side = r.currentUserBattleSide === 'defender' ? 'defender' : 'attacker';
    const won = (r.outcome === 'attacker_won' && side === 'attacker') ||
                (r.outcome === 'defender_won' && side === 'defender');
    const myLosses = (side === 'attacker' ? r.attackerLosses : r.defenderLosses) || [];
    const lostDetail = {}, dmgDetail = {};
    let lostN = 0, dmgN = 0;
    for (const it of myLosses) {
      const destroyed = it.destroyed ?? it.lost ?? 0, damaged = it.damaged || 0;
      lostN += destroyed; dmgN += damaged;
      if (it.shipDefId > 0) {   // real ships only (defense buildings have negative ids)
        if (destroyed) lostDetail[it.shipDefId] = (lostDetail[it.shipDefId] || 0) + destroyed;
        if (damaged) dmgDetail[it.shipDefId] = (dmgDetail[it.shipDefId] || 0) + damaged;
      }
    }
    const raw = numericResources(r.lootStolen);
    const loot = { ore: 0, silicates: 0, hydrogen: 0, alloys: 0, rare: {} };
    for (const [k, v] of Object.entries(raw)) { if (CORE.includes(k)) loot[k] = v; else loot.rare[k] = v; }
    const opp = side === 'attacker' ? r.defenderProfile : r.attackerProfile;
    const debris = r.debrisField || {};
    // The defender's fleet lists only ships; its planetary defenses live in
    // defenderDefenses.planetaryDefense — merge them so the defending side shows
    // its turrets too.
    const attackerFleet = r.attackerFleet || [];
    const defenderFleet = [
      ...(r.defenderFleet || []),
      ...((r.defenderDefenses && r.defenderDefenses.planetaryDefense) || []),
    ];
    recent.unshift({
      id: r.id, created_at: r.createdAt,
      planet: r.planetName || null,
      side, won, opponent: (opp && opp.username) || null,
      ships_lost_detail: lostDetail, ships_damaged_detail: dmgDetail, ships_lost: lostN, ships_damaged: dmgN,
      your_fleet: side === 'attacker' ? attackerFleet : defenderFleet,
      enemy_fleet: side === 'attacker' ? defenderFleet : attackerFleet,
      rounds: combatRounds(r),
      debris_ore: debris.ore || 0, debris_silicates: debris.silicates || 0, debris_alloys: debris.alloys || 0,
      loot,
    });
    n++;
  }
  recent.length = Math.min(recent.length, cap);
  await browser.storage.local.set({
    [sk('pvp_seen_ids')]: [...seen].slice(-20000),
    [sk('pvp_recent_reports')]: recent,
  });
  return n;
}

async function processMiningReports(reports, ships, zones = {}, universe = DEFAULT_UNIVERSE) {
  const sk = k => storeKey(universe, k);
  const mKeys = ['mining_seen_ids', 'mining_totals', 'mining_daily', 'mining_resources_lost',
    'mining_recent_reports', 'records_cap'].map(sk);
  const stored = await browser.storage.local.get(mKeys);
  const recordsCap = stored[sk('records_cap')] ?? 5000;

  const seen = new Set(stored[sk('mining_seen_ids')] || []);
  const totals = stored[sk('mining_totals')] || {
    ore: 0, silicates: 0, hydrogen: 0, alloys: 0, rare: {},
    deliveries: 0, cycles: 0, drill_breakdowns: 0, maintenance_alloys: 0, ships_lost: 0,
    stolen: { ore: 0, silicates: 0, hydrogen: 0, alloys: 0, rare: {} },
  };
  const dailyMap = {};
  for (const d of (stored[sk('mining_daily')] || [])) dailyMap[d.day] = { ...d };
  const lost = stored[sk('mining_resources_lost')]?.destroyed ? stored[sk('mining_resources_lost')] : emptyLost();
  const recent = [...(stored[sk('mining_recent_reports')] || [])];

  const fresh = reports.filter(r => !seen.has(r.id));

  for (const r of fresh) {
    if (seen.has(r.id)) continue; // duplicate id within one batch
    seen.add(r.id);
    const delivered = numericResources(r.resourcesDelivered);
    const stolen = numericResources(r.cargoStolen);
    const nLost = (r.shipsLost || []).reduce((sum, i) => sum + (i.quantity || 1), 0);
    const lostDetail = parseShipsLost(r.shipsLost);

    // Only 'delivery' reports count toward mining totals; 'pirate_raid' etc. are
    // kept for combat/loss tracking but aren't deliveries. Cycles come from
    // resourcesDelivered._cyclesDone; a finished delivery drops that meta, so
    // assume a full run of MAX cycles (10) when it's absent.
    const isDelivery = r.reportType === 'delivery';
    const cyc = isDelivery
      ? (typeof r.resourcesDelivered?._cyclesDone === 'number' ? r.resourcesDelivered._cyclesDone : 10)
      : 0;
    const maint = maintenanceAlloys(r.fleetComposition);

    addResources(totals.stolen, stolen);
    totals.maintenance_alloys = (totals.maintenance_alloys || 0) + maint;
    totals.ships_lost += nLost;
    if (isDelivery) {
      addResources(totals, delivered);
      totals.deliveries += 1;
      totals.cycles += cyc;
      totals.drill_breakdowns += r.drillBreakdowns || 0;
    }

    const day = r.createdAt.slice(0, 10);
    if (!dailyMap[day]) dailyMap[day] = { day, ore: 0, silicates: 0, hydrogen: 0, deliveries: 0, ships_lost: 0 };
    dailyMap[day].ships_lost += nLost;
    if (isDelivery) {
      dailyMap[day].ore += delivered.ore || 0;
      dailyMap[day].silicates += delivered.silicates || 0;
      dailyMap[day].hydrogen += delivered.hydrogen || 0;
      dailyMap[day].deliveries += 1;
      addExtraRes(dailyMap[day], delivered);
    }

    addShipCost(lostDetail, ships, lost.destroyed, 1);

    recent.unshift({
      id: r.id,
      created_at: r.createdAt,
      location: r.locationName || '—',
      planet: r.planetName || '—',
      zone: resolveZone(systemFromLocation(r.locationName), zones),
      report_type: r.reportType || 'delivery',
      source_planet_id: r.planetId ?? null,   // for the mining tab's per-row fuel estimate
      fleet: (r.fleetComposition || []).map(s => ({ shipDefId: s.shipDefId, quantity: s.quantity })),
      ore: delivered.ore || 0,
      silicates: delivered.silicates || 0,
      hydrogen: delivered.hydrogen || 0,
      ...extrasOf(delivered),
      cycles: cyc,
      drill_breakdowns: r.drillBreakdowns || 0,
      maintenance_alloys: maint,
      ships_lost: nLost,
      ships_lost_detail: lostDetail,   // shipDefId→qty, so losses can be valued per period
      stolen_total: Object.values(stolen).reduce((s, v) => s + v, 0),
      stolen,   // granular cargo the raid stole from you, valued as a loss in the battles tab
      combat_outcome: r.combatOutcome || null,
      ...(r.combatOutcome ? (d => ({
        debris_ore: d.ore, debris_alloys: d.alloys, debris_silicates: d.silicates, rounds: combatRounds(r),
        your_fleet: combatFleet(r, 'defenderFleet'), enemy_fleet: combatFleet(r, 'attackerFleet'),   // a raid: pirates attack, you defend
      }))(combatDebris(r)) : {}),
    });
  }

  // Backfill mining-raid records stored before combat detail was captured:
  // patch debris/rounds/fleets in place from the live API, never touching
  // totals/seen. Gated on your_fleet so partially-enriched records still get
  // their fleets; only raids (r.combatOutcome) are considered.
  // ponytail: runs every scrape but only mutates raids still missing fields.
  const recentById = new Map(recent.map(rr => [rr.id, rr]));
  for (const r of reports) {
    if (!r.combatOutcome) continue;
    const rec = recentById.get(r.id);
    if (!rec) continue;
    if (rec.stolen === undefined) rec.stolen = numericResources(r.cargoStolen);   // backfill granular cargo loss
    if (rec.your_fleet && rec.your_fleet.length) continue;   // combat detail already patched
    const d = combatDebris(r);
    rec.combat_outcome = r.combatOutcome;
    rec.debris_ore = d.ore; rec.debris_alloys = d.alloys; rec.debris_silicates = d.silicates;
    rec.rounds = combatRounds(r);
    rec.your_fleet = combatFleet(r, 'defenderFleet');
    rec.enemy_fleet = combatFleet(r, 'attackerFleet');
  }

  await appendToArchive('mining', recent.slice(0, recent.length - (stored[sk('mining_recent_reports')] || []).length), universe);

  await browser.storage.local.set({
    [sk('mining_seen_ids')]: [...seen],
    [sk('mining_totals')]: totals,
    [sk('mining_daily')]: Object.values(dailyMap).sort((a, b) => a.day.localeCompare(b.day)),
    [sk('mining_resources_lost')]: lost,
    [sk('mining_recent_reports')]: recent.slice(0, recordsCap),
    [sk('last_scrape')]: new Date().toISOString(),
    [sk('last_error')]: null,
  });

  return fresh.length;
}

// Expedition reports + wormhole runs share one tab. Wormhole runs put their
// aggregate loot in `totalLoot`; expedition shape is still unobserved, so the
// other keys are kept as tolerant fallbacks.
function extractLoot(r) {
  const src = r.totalLoot || r.loot || r.resourcesGained || r.resources || r.reward || r.rewards || {};
  return numericResources(src);
}

// Ships lost count: wormhole runs use `totalShipsLost`, combat uses
// `shipsDestroyed` ({ lost }), others `shipsLost` ({ quantity }).
function extractShipsLost(r) {
  const arr = r.totalShipsLost || r.shipsDestroyed || r.shipsLost || [];
  return arr.reduce((sum, i) => sum + (i.quantity ?? i.lost ?? 1), 0);
}

async function processExpeditionReports(reports, runs, ships, zones = {}, wormholeZones = {}, wormholeClasses = {}, universe = DEFAULT_UNIVERSE) {
  const items = [
    ...(reports || []).map(r => ({ r, kind: 'expedition', uid: `exp-${r.id}` })),
    ...(runs || []).map(r => ({ r, kind: 'wormhole', uid: `wh-${r.id}` })),
  ];
  if (!items.length) return 0;

  const sk = k => storeKey(universe, k);
  const eKeys = ['exp_seen_ids', 'exp_totals', 'expedition_totals', 'wormhole_totals', 'exp_daily', 'exp_recent_reports',
    'expedition_resources_lost', 'wormhole_resources_lost', 'records_cap'].map(sk);
  const stored = await browser.storage.local.get(eKeys);
  const recordsCap = stored[sk('records_cap')] ?? 5000;

  const emptyTotals = () => ({ ore: 0, silicates: 0, hydrogen: 0, alloys: 0, rare: {}, missions: 0, ships_lost: 0 });
  const seen = new Set(stored[sk('exp_seen_ids')] || []);
  const totals = stored[sk('exp_totals')] || emptyTotals();
  const expTotals = stored[sk('expedition_totals')] || emptyTotals();
  const whTotals = stored[sk('wormhole_totals')] || emptyTotals();
  // Ships lost tracked separately per kind.
  const expLost = stored[sk('expedition_resources_lost')]?.destroyed ? stored[sk('expedition_resources_lost')] : emptyLost();
  const whLost = stored[sk('wormhole_resources_lost')]?.destroyed ? stored[sk('wormhole_resources_lost')] : emptyLost();
  const dailyMap = {};
  for (const d of (stored[sk('exp_daily')] || [])) dailyMap[d.day] = { ...d };
  const recent = [...(stored[sk('exp_recent_reports')] || [])];

  let added = 0;
  for (const { r, kind, uid } of items) {
    if (seen.has(uid) || !r.createdAt) continue;
    // Skip runs still in progress — their totals are partial and `seen`
    // would lock the partial value in. Re-counted once completed.
    if (r.status && r.status !== 'completed') continue;
    seen.add(uid);
    added++;
    const loot = extractLoot(r);
    const destroyedArr = r.totalShipsLost || r.shipsDestroyed || r.shipsLost || [];
    const nLost = extractShipsLost(r);

    const kindTotals = kind === 'wormhole' ? whTotals : expTotals;
    addResources(totals, loot);
    addResources(kindTotals, loot);
    addLossCost(destroyedArr, ships, (kind === 'wormhole' ? whLost : expLost).destroyed, 1);
    totals.missions += 1;
    totals.ships_lost += nLost;
    kindTotals.missions += 1;
    kindTotals.ships_lost += nLost;

    const day = r.createdAt.slice(0, 10);
    if (!dailyMap[day]) dailyMap[day] = { day, ore: 0, silicates: 0, hydrogen: 0, missions: 0, ships_lost: 0 };
    dailyMap[day].ore += loot.ore || 0;
    dailyMap[day].silicates += loot.silicates || 0;
    dailyMap[day].hydrogen += loot.hydrogen || 0;
    dailyMap[day].missions += 1;
    dailyMap[day].ships_lost += nLost;

    recent.unshift({
      id: uid,
      created_at: r.createdAt,
      kind,
      wormhole_id: r.wormholeId ?? null,
      wclass: r.wormholeClass || wormholeClasses[r.wormholeId] || null,
      event: r.eventType || r.outcome || r.result || r.status || null,
      location: r.systemName || r.locationName || r.targetName ||
        (r.wormholeId != null ? `Wormhole #${r.wormholeId}` : '—'),
      zone: wormholeZones[r.wormholeId] || resolveZone(r.systemName || systemFromLocation(r.locationName), zones),
      loot,
      ships_lost: nLost,
      ships_destroyed_raw: destroyedArr,
      ...(kind === 'wormhole' ? { encounters: wormholeEncounters(r, ships) } : {}),
    });
  }

  // Backfill: wormhole runs stored before encounter combat was captured. Patch
  // the combat encounters (outcome + rounds + your fleet) in place from the live
  // API — no totals/seen change. Gated on a non-empty encounters array.
  // ponytail: runs every scrape but only mutates completed runs still missing it.
  const expById = new Map(recent.map(rr => [rr.id, rr]));
  let patched = false;
  for (const { r, kind, uid } of items) {
    if (kind !== 'wormhole' || (r.status && r.status !== 'completed')) continue;
    const rec = expById.get(uid);
    if (!rec || (rec.encounters && rec.encounters.length)) continue;
    rec.encounters = wormholeEncounters(r, ships);
    patched = true;
  }

  if (added || patched) {
    await appendToArchive('exp', recent.slice(0, recent.length - (stored[sk('exp_recent_reports')] || []).length), universe);
    await browser.storage.local.set({
      [sk('exp_seen_ids')]: [...seen],
      [sk('exp_totals')]: totals,
      [sk('expedition_totals')]: expTotals,
      [sk('wormhole_totals')]: whTotals,
      [sk('expedition_resources_lost')]: expLost,
      [sk('wormhole_resources_lost')]: whLost,
      [sk('exp_daily')]: Object.values(dailyMap).sort((a, b) => a.day.localeCompare(b.day)),
      [sk('exp_recent_reports')]: recent.slice(0, recordsCap),
      [sk('last_scrape')]: new Date().toISOString(),
      [sk('last_error')]: null,
    });
  }
  return added;
}

// Ruins survey (xeno_survey) results arrive as a system message, not a fleet
// report: subject "Xeno Survey Complete", body e.g. "Your science team
// finished the xeno survey. 0 fragments recovered, plus an artifact for your
// collection." No structured loot, and no moon/system/ships-lost data at all
// — location/zone/ships_lost are unknowable from this feed.
const XENO_FRAGMENTS_RE = /(\d+)\s*fragments?\s*recovered/i;
const XENO_ARTIFACT_RE = /plus\s+(\d+|an?)\s*artifacts?/i;

function parseXenoMessage(body) {
  const loot = {};
  const frag = XENO_FRAGMENTS_RE.exec(body || '');
  if (frag && +frag[1]) loot.precursor_fragments = +frag[1];
  const art = XENO_ARTIFACT_RE.exec(body || '');
  if (art) {
    const n = /^an?$/i.test(art[1]) ? 1 : +art[1];
    if (n) loot.artifact = n;
  }
  return loot;
}

async function processXenoReports(messages, universe = DEFAULT_UNIVERSE) {
  const xenoMsgs = (messages || []).filter(m => m.subject === 'Xeno Survey Complete');
  if (!xenoMsgs.length) return 0;

  const sk = k => storeKey(universe, k);
  const xKeys = ['xeno_seen_ids', 'xeno_totals', 'xeno_daily', 'xeno_recent_reports', 'records_cap'].map(sk);
  const stored = await browser.storage.local.get(xKeys);
  const recordsCap = stored[sk('records_cap')] ?? 5000;

  const seen = new Set(stored[sk('xeno_seen_ids')] || []);
  const totals = stored[sk('xeno_totals')] || {
    ore: 0, silicates: 0, hydrogen: 0, alloys: 0, rare: {}, missions: 0, ships_lost: 0,
  };
  const dailyMap = {};
  for (const d of (stored[sk('xeno_daily')] || [])) dailyMap[d.day] = { ...d };
  const recent = [...(stored[sk('xeno_recent_reports')] || [])];

  let added = 0;
  for (const m of xenoMsgs) {
    const uid = `xeno-${m.id}`;
    if (seen.has(uid) || !m.createdAt) continue;
    seen.add(uid);
    added++;
    const loot = parseXenoMessage(m.body);

    addResources(totals, loot);
    totals.missions += 1;

    const day = m.createdAt.slice(0, 10);
    if (!dailyMap[day]) dailyMap[day] = { day, ore: 0, silicates: 0, hydrogen: 0, missions: 0, ships_lost: 0 };
    dailyMap[day].missions += 1;

    recent.unshift({
      id: uid,
      created_at: m.createdAt,
      event: 'ruins_survey_complete',
      location: '—',
      zone: null,
      loot,
      ships_lost: 0,
      ships_destroyed_raw: [],
    });
  }

  if (added) {
    await appendToArchive('xeno', recent.slice(0, recent.length - (stored[sk('xeno_recent_reports')] || []).length), universe);
    await browser.storage.local.set({
      [sk('xeno_seen_ids')]: [...seen],
      [sk('xeno_totals')]: totals,
      [sk('xeno_daily')]: Object.values(dailyMap).sort((a, b) => a.day.localeCompare(b.day)),
      [sk('xeno_recent_reports')]: recent.slice(0, recordsCap),
    });
  }
  return added;
}

// system-debris is live state, not history. Snapshot it and treat decreases
// between snapshots as "collected by someone" (us or another player).
// Snapshot the live debris fields (with first-seen timestamps) for the
// "Live debris fields" table. Precise collection is tracked separately from
// returning collect_debris missions (processMissions).
async function processSystemDebris(debrisArr, zones = {}, universe = DEFAULT_UNIVERSE) {
  const key = storeKey(universe, 'debris_fields');
  const raw = await browser.storage.local.get(key);
  const prev = {};
  for (const f of (raw[key] || [])) prev[f.id] = f;

  const now = new Date().toISOString();
  const next = {};
  for (const d of (debrisArr || [])) {
    const id = String(d.id ?? `${d.systemId ?? '?'}-${d.position ?? ''}`);
    next[id] = {
      id,
      debrisId: d.id ?? null,         // numeric id for collect-debris
      systemId: d.systemId ?? null,   // for the fuel estimate
      system: d.systemName || d.locationName || (d.systemId != null ? `System #${d.systemId}` : 'unknown'),
      zone: resolveZone(d.systemName, zones),
      ore: d.ore || 0,
      silicates: d.silicates || 0,
      alloys: d.alloys || 0,
      first_seen: prev[id]?.first_seen || now,
      updated_at: now,
    };
  }

  await browser.storage.local.set({
    [storeKey(universe, 'debris_fields')]: Object.values(next),
    [storeKey(universe, 'debris_last_check')]: now,
  });
}

// Active fleet missions → precise debris collection. A returning
// `collect_debris` fleet's cargo is exactly what it salvaged, so we record
// each such mission once (deduped by mission id) as a real collection, plus
// keep the in-flight runs for a live view. zoneById: systemId → zone.
async function processMissions(missions, zoneById = {}, ships = {}, universe = DEFAULT_UNIVERSE) {
  const sk = k => storeKey(universe, k);
  if (missions && missions.length) {
    const fuelKeys = [sk('fuel_log'), sk('fuel_counted_ids')];
    const fuelRaw = await browser.storage.local.get(fuelKeys);
    const counted = new Set(fuelRaw[sk('fuel_counted_ids')] || []);
    const flog = [...(fuelRaw[sk('fuel_log')] || [])];
    for (const m of missions) {
      if (m.id == null || counted.has(m.id)) continue;
      counted.add(m.id);
      // Prefer the game's exact fuel-estimate; fall back to the fitted formula
      // when no game tab is open or the route/fleet is incomplete.
      const fuel = (await apiMissionFuel(m)) ?? missionFuel({
        distance: m.distance,
        fleet: (m.fleetComposition || []).map(f => ({ key: f.shipKey || f.key, quantity: f.quantity || 1 })),
      }, ships) ?? 0;
      if (!fuel) continue;
      flog.unshift({
        created_at: m.departsAt || m.createdAt || new Date().toISOString(),
        type: fuelMissionType(m.missionType),
        zone: zoneById[m.targetSystemId] || 'unknown',
        fuel,
      });
    }
    const countedArr = [...counted];
    await browser.storage.local.set({
      [sk('fuel_log')]: flog.slice(0, 4000),
      [sk('fuel_counted_ids')]: countedArr.slice(Math.max(0, countedArr.length - 5000)),
    });
  }

  const runs = (missions || []).filter(m => m.missionType === 'collect_debris');

  const debrisKeys = ['debris_collected', 'debris_collection_log', 'debris_collection_ids',
    'debris_resources_lost', 'debris_loss_ids', 'records_cap'].map(sk);
  const stored = await browser.storage.local.get(debrisKeys);
  const recordsCap = stored[sk('records_cap')] ?? 5000;
  const total = stored[sk('debris_collected')] || { ore: 0, silicates: 0, alloys: 0, hydrogen: 0 };
  const log = [...(stored[sk('debris_collection_log')] || [])];
  const seen = new Set(stored[sk('debris_collection_ids')] || []);
  const lost = stored[sk('debris_resources_lost')]?.destroyed ? stored[sk('debris_resources_lost')] : emptyLost();
  const lossSeen = new Set(stored[sk('debris_loss_ids')] || []);

  const active = [];
  for (const m of runs) {
    const cargo = m.cargo || {};
    const amount = (cargo.ore || 0) + (cargo.silicates || 0) + (cargo.alloys || 0) + (cargo.hydrogen || 0);
    // Collection now runs in repeating ticks (cargo grows each tick, same mission
    // id); `returnDepartsAt` is set from the first tick on as a rolling ETA, so it
    // no longer means the haul is final. `raidParams.collectionComplete` does.
    const returning = m.status === 'returning' || m.returnDepartsAt != null;
    const collectionDone = m.raidParams?.collectionComplete === true || m.status === 'returning';

    active.push({
      id: m.id,
      fleet: (m.fleetComposition || []).map(f => ({ key: f.shipKey || f.key, quantity: f.quantity || 1 })),
      system: m.targetSystemName || (m.targetSystemId != null ? `System #${m.targetSystemId}` : '—'),
      system_id: m.targetSystemId ?? null,   // so the UI can mark a field already collecting
      zone: zoneById[m.targetSystemId] || 'unknown',
      status: m.status || (returning ? 'returning' : 'outbound'),
      eta: m.returnArrivesAt || m.arrivesAt || null,
      ore: cargo.ore || 0, silicates: cargo.silicates || 0,
      alloys: cargo.alloys || 0, hydrogen: cargo.hydrogen || 0,
    });

    // Ships lost if the fleet was ambushed en route — valued once per mission.
    const destroyed = m.shipsDestroyed || m.shipsLost;
    if (destroyed?.length && !lossSeen.has(m.id)) {
      lossSeen.add(m.id);
      addLossCost(destroyed, ships, lost.destroyed, 1);
    }

    // Commit once the haul is known (collection tick loop finished, non-empty cargo).
    if (collectionDone && amount > 0 && !seen.has(m.id)) {
      seen.add(m.id);
      total.ore += cargo.ore || 0;
      total.silicates += cargo.silicates || 0;
      total.hydrogen += cargo.hydrogen || 0;
      addExtraRes(total, cargo);   // alloys + rares
      log.unshift({
        id: m.id,
        collected_at: new Date().toISOString(),
        system: m.targetSystemName || (m.targetSystemId != null ? `System #${m.targetSystemId}` : '—'),
        zone: zoneById[m.targetSystemId] || 'unknown',
        ore: cargo.ore || 0, silicates: cargo.silicates || 0,
        alloys: cargo.alloys || 0, hydrogen: cargo.hydrogen || 0, ...extrasOf(cargo),
      });
    }
  }

  await browser.storage.local.set({
    [sk('debris_active_runs')]: active,
    [sk('debris_collected')]: total,
    [sk('debris_collection_log')]: log.slice(0, recordsCap),
    [sk('debris_collection_ids')]: [...seen].slice(-2000),
    [sk('debris_resources_lost')]: lost,
    [sk('debris_loss_ids')]: [...lossSeen].slice(-2000),
  });
  return log.length;
}

// ── Aggregate rebuild ──────────────────────────────────────────────────────
// Recomputes every aggregate from the stored per-report records, repairing
// drift after partial failures. Limits: history beyond the records cap is
// lost from totals, and mining alloys/rares/stolen-breakdown and mining loss
// valuation cannot be reconstructed (per-report records lack the detail).

// Destroyed ships at full cost + damaged ships at the repair factor.
function costFromDetail(record, ships, into) {
  addShipCost(record.ships_lost_detail, ships, into.destroyed, 1);
  addShipCost(record.ships_damaged_detail, ships, into.repair, REPAIR_FACTOR);
}

async function rebuildAggregates(universe = DEFAULT_UNIVERSE) {
  const sk = k => storeKey(universe, k);
  const keys = ['recent_reports', 'pirate_recent_reports', 'mining_recent_reports',
    'exp_recent_reports', 'xeno_recent_reports', 'ships'].map(sk);
  const s = await browser.storage.local.get(keys);
  const ships = s[sk('ships')] || {};
  const out = {};
  // Archives hold every report ever seen; capped recents are the fallback
  // for data collected before archives existed.
  const archives = {};
  for (const t of ARCHIVE_TYPES) archives[t] = await loadArchive(t, universe);
  const surveyRecords = archives.survey.length ? archives.survey : (s[sk('recent_reports')] || []);
  const pirateRecords = archives.pirate.length ? archives.pirate : (s[sk('pirate_recent_reports')] || []);
  const miningRecords = archives.mining.length ? archives.mining : (s[sk('mining_recent_reports')] || []);
  const expRecords = archives.exp.length ? archives.exp : (s[sk('exp_recent_reports')] || []);
  const xenoRecords = archives.xeno.length ? archives.xeno : (s[sk('xeno_recent_reports')] || []);

  // Surveys
  {
    const totals = { ore: 0, hydrogen: 0, silicates: 0, missions: 0, ships_lost: 0, first_report: null, last_report: null };
    const daily = {}, hourly = {}, events = {};
    const lost = emptyLost();
    for (const r of surveyRecords) {
      totals.ore += r.ore || 0;
      totals.hydrogen += r.hydrogen || 0;
      totals.silicates += r.silicates || 0;
      totals.missions += 1;
      totals.ships_lost += r.ships_lost || 0;
      addExtraRes(totals, r);
      if (!totals.first_report || r.created_at < totals.first_report) totals.first_report = r.created_at;
      if (!totals.last_report || r.created_at > totals.last_report) totals.last_report = r.created_at;

      const day = r.created_at.slice(0, 10);
      if (!daily[day]) daily[day] = { day, ore: 0, hydrogen: 0, silicates: 0, missions: 0, ships_lost: 0 };
      daily[day].ore += r.ore || 0;
      daily[day].hydrogen += r.hydrogen || 0;
      daily[day].silicates += r.silicates || 0;
      daily[day].missions += 1;
      daily[day].ships_lost += r.ships_lost || 0;
      addExtraRes(daily[day], r);

      const hour = r.created_at.slice(0, 13) + ':00';
      if (!hourly[hour]) hourly[hour] = { hour, ore: 0, hydrogen: 0, silicates: 0, missions: 0, ships_lost: 0 };
      hourly[hour].ore += r.ore || 0;
      hourly[hour].hydrogen += r.hydrogen || 0;
      hourly[hour].silicates += r.silicates || 0;
      hourly[hour].missions += 1;
      hourly[hour].ships_lost += r.ships_lost || 0;
      addExtraRes(hourly[hour], r);

      const et = r.event_type || 'unknown';
      if (!events[et]) events[et] = { event_type: et, count: 0, ore: 0, hydrogen: 0, silicates: 0 };
      events[et].count += 1;
      events[et].ore += r.ore || 0;
      events[et].hydrogen += r.hydrogen || 0;
      events[et].silicates += r.silicates || 0;
      addExtraRes(events[et], r);

      costFromDetail(r, ships, lost);
    }
    out.totals = totals;
    out.daily = Object.values(daily).sort((a, b) => a.day.localeCompare(b.day));
    out.hourly = Object.values(hourly).sort((a, b) => a.hour.localeCompare(b.hour));
    out.event_breakdown = Object.values(events).sort((a, b) => b.count - a.count);
    out.resources_lost = lost;
  }

  // Pirates
  {
    const totals = {
      ore: 0, hydrogen: 0, silicates: 0, raids: 0,
      ships_destroyed: 0, ships_damaged: 0, pirates_destroyed: 0,
      first_report: null, last_report: null,
    };
    const daily = {}, outcomes = {};
    const lost = emptyLost();
    const debris = { ore: 0, alloys: 0, silicates: 0 };
    for (const r of pirateRecords) {
      totals.ore += r.ore || 0;
      totals.hydrogen += r.hydrogen || 0;
      totals.silicates += r.silicates || 0;
      totals.raids += 1;
      totals.ships_destroyed += r.ships_lost || 0;
      totals.ships_damaged += r.ships_damaged || 0;
      totals.pirates_destroyed += r.pirates_destroyed || 0;
      addExtraRes(totals, r);
      if (!totals.first_report || r.created_at < totals.first_report) totals.first_report = r.created_at;
      if (!totals.last_report || r.created_at > totals.last_report) totals.last_report = r.created_at;

      const day = r.created_at.slice(0, 10);
      if (!daily[day]) daily[day] = { day, ore: 0, hydrogen: 0, silicates: 0, raids: 0, ships_destroyed: 0 };
      daily[day].ore += r.ore || 0;
      daily[day].hydrogen += r.hydrogen || 0;
      daily[day].silicates += r.silicates || 0;
      addExtraRes(daily[day], r);
      daily[day].raids += 1;
      daily[day].ships_destroyed += r.ships_lost || 0;

      const o = r.outcome || 'unknown';
      if (!outcomes[o]) outcomes[o] = { outcome: o, count: 0, ore: 0, hydrogen: 0, silicates: 0 };
      outcomes[o].count += 1;
      outcomes[o].ore += r.ore || 0;
      outcomes[o].hydrogen += r.hydrogen || 0;
      outcomes[o].silicates += r.silicates || 0;

      debris.ore += r.debris_ore || 0;
      debris.alloys += r.debris_alloys || 0;
      debris.silicates += r.debris_silicates || 0;

      costFromDetail(r, ships, lost);
    }
    out.pirate_totals = totals;
    out.pirate_daily = Object.values(daily).sort((a, b) => a.day.localeCompare(b.day));
    out.pirate_outcomes = Object.values(outcomes).sort((a, b) => b.count - a.count);
    out.pirate_resources_lost = lost;
    out.pirate_debris_total = debris;
  }

  // Mining (alloys/rare/stolen breakdown and loss valuation are not rebuildable)
  {
    const totals = {
      ore: 0, silicates: 0, hydrogen: 0, alloys: 0, rare: {},
      deliveries: 0, cycles: 0, drill_breakdowns: 0, maintenance_alloys: 0, ships_lost: 0,
      stolen: { ore: 0, silicates: 0, hydrogen: 0, alloys: 0, rare: {} },
    };
    const daily = {};
    for (const r of miningRecords) {
      // Match live processing: only 'delivery' records are deliveries. Older
      // records predate report_type; treat those as deliveries (default).
      const isDelivery = (r.report_type || 'delivery') === 'delivery';
      totals.maintenance_alloys += r.maintenance_alloys || 0;
      totals.ships_lost += r.ships_lost || 0;
      totals.stolen.ore += r.stolen_total || 0; // breakdown unknown — lump into ore
      if (isDelivery) {
        totals.ore += r.ore || 0;
        totals.silicates += r.silicates || 0;
        totals.hydrogen += r.hydrogen || 0;
        totals.deliveries += 1;
        totals.cycles += r.cycles || 0;
        totals.drill_breakdowns += r.drill_breakdowns || 0;
        addExtraRes(totals, r);
      }

      const day = r.created_at.slice(0, 10);
      if (!daily[day]) daily[day] = { day, ore: 0, silicates: 0, hydrogen: 0, deliveries: 0, ships_lost: 0 };
      daily[day].ships_lost += r.ships_lost || 0;
      if (isDelivery) {
        daily[day].ore += r.ore || 0;
        daily[day].silicates += r.silicates || 0;
        daily[day].hydrogen += r.hydrogen || 0;
        addExtraRes(daily[day], r);
        daily[day].deliveries += 1;
      }
    }
    out.mining_totals = totals;
    out.mining_daily = Object.values(daily).sort((a, b) => a.day.localeCompare(b.day));
    out.mining_resources_lost = emptyLost();   // not rebuildable — records lack ship detail
  }

  // Expeditions (full loot map per record — fully rebuildable)
  {
    const emptyTotals = () => ({ ore: 0, silicates: 0, hydrogen: 0, alloys: 0, rare: {}, missions: 0, ships_lost: 0, fuel: 0 });
    const totals = emptyTotals();
    const expTotals = emptyTotals();
    const whTotals = emptyTotals();
    const expLost = emptyLost();
    const whLost = emptyLost();
    const daily = {};
    for (const r of expRecords) {
      const kindTotals = r.kind === 'wormhole' ? whTotals : expTotals;
      addResources(totals, r.loot || {});
      addResources(kindTotals, r.loot || {});
      addLossCost(r.ships_destroyed_raw, ships, (r.kind === 'wormhole' ? whLost : expLost).destroyed, 1);
      totals.missions += 1;
      totals.ships_lost += r.ships_lost || 0;
      kindTotals.missions += 1;
      kindTotals.ships_lost += r.ships_lost || 0;

      const day = r.created_at.slice(0, 10);
      if (!daily[day]) daily[day] = { day, ore: 0, silicates: 0, hydrogen: 0, missions: 0, ships_lost: 0 };
      daily[day].ore += r.loot?.ore || 0;
      daily[day].silicates += r.loot?.silicates || 0;
      daily[day].hydrogen += r.loot?.hydrogen || 0;
      daily[day].missions += 1;
      daily[day].ships_lost += r.ships_lost || 0;
    }
    out.exp_totals = totals;
    out.expedition_totals = expTotals;
    out.wormhole_totals = whTotals;
    out.expedition_resources_lost = expLost;
    out.wormhole_resources_lost = whLost;
    out.exp_daily = Object.values(daily).sort((a, b) => a.day.localeCompare(b.day));
  }

  // Xeno ruins surveys (full loot map per record — fully rebuildable)
  {
    const totals = { ore: 0, silicates: 0, hydrogen: 0, alloys: 0, rare: {}, missions: 0, ships_lost: 0 };
    const lost = emptyLost();
    const daily = {};
    for (const r of xenoRecords) {
      addResources(totals, r.loot || {});
      addLossCost(r.ships_destroyed_raw, ships, lost.destroyed, 1);
      totals.missions += 1;
      totals.ships_lost += r.ships_lost || 0;

      const day = r.created_at.slice(0, 10);
      if (!daily[day]) daily[day] = { day, ore: 0, silicates: 0, hydrogen: 0, missions: 0, ships_lost: 0 };
      daily[day].ore += r.loot?.ore || 0;
      daily[day].silicates += r.loot?.silicates || 0;
      daily[day].hydrogen += r.loot?.hydrogen || 0;
      daily[day].missions += 1;
      daily[day].ships_lost += r.ships_lost || 0;
    }
    out.xeno_totals = totals;
    out.xeno_resources_lost = lost;
    out.xeno_daily = Object.values(daily).sort((a, b) => a.day.localeCompare(b.day));
  }

  // Prefix all output keys with the universe before writing
  const scopedOut = {};
  for (const [k, v] of Object.entries(out)) scopedOut[storeKey(universe, k)] = v;
  await browser.storage.local.set(scopedOut);
  await browser.storage.local.remove(storeKey(universe, 'stats_drift'));
  console.log(`[NexusAccounting][${universe}] Aggregates rebuilt from stored records.`);
}

// ── Backups ─────────────────────────────────────────────────────────────────
// Full storage snapshots written to Downloads/NexusAccounting/: weekly while
// scraping runs, and before every destructive operation (reset, import,
// schema-fallback wipe). Same format as the manual dashboard export.

const BACKUP_INTERVAL_MS = 7 * 24 * 3600 * 1000;

async function backupToDownloads(reason) {
  const data = await browser.storage.local.get(null);
  if (data.records_cap === Infinity) data.records_cap = 0;
  const payload = {
    nexus_accounting_backup: 1,
    exported_at: new Date().toISOString(),
    reason,
    data,
  };
  // MV3 service workers have no URL.createObjectURL, so download from a data
  // URL instead of a blob URL.
  const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(payload));
  await browser.downloads.download({
    url,
    filename: `NexusAccounting/nexus-accounting-${reason}-${new Date().toISOString().slice(0, 10)}.json`,
    conflictAction: 'uniquify',
    saveAs: false,
  });
  await browser.storage.local.set({ last_backup: new Date().toISOString() });
  console.log(`[NexusAccounting] Backup written (${reason}).`);
}

async function maybeAutoBackup() {
  const { last_backup } = await browser.storage.local.get('last_backup');
  if (last_backup && Date.now() - new Date(last_backup).getTime() < BACKUP_INTERVAL_MS) return;
  try {
    await backupToDownloads('auto');
  } catch (err) {
    console.warn('[NexusAccounting] Auto-backup failed:', err);
  }
}

// ── Drift detection ─────────────────────────────────────────────────────────
// Recompute archive-derived sums and compare with the stored totals. Only
// fields that are fully reconstructible from archives are compared, so a
// legitimate rebuild never reports drift.

async function checkDrift(universe = DEFAULT_UNIVERSE) {
  const sk = k => storeKey(universe, k);
  const dKeys = ['totals', 'pirate_totals', 'mining_totals', 'exp_totals'].map(sk);
  const s = await browser.storage.local.get(dKeys);
  const surveyArchive = await loadArchive('survey', universe);
  const pirateArchive = await loadArchive('pirate', universe);
  const miningArchive = await loadArchive('mining', universe);
  const expArchive = await loadArchive('exp', universe);

  const sum = (arr, field) => (arr || []).reduce((t, r) => t + (r[field] || 0), 0);
  const problems = [];

  if (s[sk('totals')] && surveyArchive.length) {
    const totals = s[sk('totals')];
    for (const f of ['ore', 'hydrogen', 'silicates', 'ships_lost']) {
      if (sum(surveyArchive, f) !== (totals[f] || 0)) problems.push(`surveys.${f}`);
    }
    if (surveyArchive.length !== (totals.missions || 0)) problems.push('surveys.missions');
  }
  if (s[sk('pirate_totals')] && pirateArchive.length) {
    const totals = s[sk('pirate_totals')];
    for (const f of ['ore', 'hydrogen', 'silicates']) {
      if (sum(pirateArchive, f) !== (totals[f] || 0)) problems.push(`pirates.${f}`);
    }
    if (pirateArchive.length !== (totals.raids || 0)) problems.push('pirates.raids');
  }
  if (s[sk('mining_totals')] && miningArchive.length) {
    const totals = s[sk('mining_totals')];
    const miningDeliv = miningArchive.filter(r => (r.report_type || 'delivery') === 'delivery');
    for (const f of ['ore', 'silicates', 'hydrogen']) {
      if (sum(miningDeliv, f) !== (totals[f] || 0)) problems.push(`mining.${f}`);
    }
    if (miningDeliv.length !== (totals.deliveries || 0)) problems.push('mining.deliveries');
  }
  if (s[sk('exp_totals')] && expArchive.length) {
    if (expArchive.length !== (s[sk('exp_totals')].missions || 0)) problems.push('expeditions.missions');
  }

  if (problems.length) {
    await browser.storage.local.set({
      [sk('stats_drift')]: { detected_at: new Date().toISOString(), fields: problems },
    });
    console.warn(`[NexusAccounting][${universe}] Stats drift detected:`, problems.join(', '));
  } else {
    await browser.storage.local.remove(sk('stats_drift'));
  }
}

// ── Schema migrations ───────────────────────────────────────────────────────
// When a stored data shape changes, bump SCHEMA_VERSION and add a migration
// keyed by the NEW version that transforms existing data in place. Purely
// additive changes (new keys with defaults) need no bump at all. Since report
// archives exist, a record-shape migration is usually just "transform the
// archives, then rebuildAggregates()". Data is only wiped as a last resort,
// when a migration step is missing — and the user's records cap survives even
// that.

const MIGRATIONS = {
  // v4: archives moved from one big array per type to monthly shards.
  4: async () => {
    const legacyKeys = {
      survey: ['survey_archive', 'recent_reports'],
      pirate: ['pirate_archive', 'pirate_recent_reports'],
      mining: ['mining_archive', 'mining_recent_reports'],
      exp: ['exp_archive', 'exp_recent_reports'],
    };
    for (const [type, [legacy, fallback]] of Object.entries(legacyKeys)) {
      const s = await browser.storage.local.get([legacy, fallback]);
      await appendToArchive(type, s[legacy] || s[fallback] || []);
      await browser.storage.local.remove(legacy);
    }
  },
  // v5: the wormhole/expedition parser was broken (loot lives in `totalLoot`,
  // not `loot`), so stored runs have empty loot and block re-ingest via
  // seen_ids. Drop the expedition data so it re-ingests with the fixed parser.
  5: async () => {
    const idx = await getArchiveIndex();
    const shardKeys = (idx.exp?.months || []).map(m => `exp_archive_${m}`);
    await browser.storage.local.remove([
      ...shardKeys, 'exp_seen_ids', 'exp_totals', 'exp_daily', 'exp_recent_reports',
    ]);
    if (idx.exp) {
      idx.exp = { months: [], count: 0 };
      await browser.storage.local.set({ archive_index: idx });
    }
  },
  // v6: resources_lost split into { destroyed, repair }. Rebuild recomputes the
  // new shape from the archives (mining loss stays empty — records lack detail).
  6: async () => {
    await rebuildAggregates();
  },
  // v7: fuel is now counted per launched mission into fuel_log. Clear the log
  // (early entries mis-tagged "investigate" survey fleets as "other") plus the
  // stale coords caches; system_coords_by_id/_by_name get re-populated by
  // getSystemZones() on the next galaxy map refresh, the rest rebuild from new launches.
  7: async () => {
    await browser.storage.local.remove([
      'fuel_log', 'fuel_counted_ids', 'mission_origins',
      'system_coords_by_id', 'system_coords_by_name', 'camp_coords',
      'home_system_id', 'owned_system_ids',
    ]);
  },
  // v8: PvP battle records added; early ones were list-only (no fleets/rounds/
  // debris/defenses). Clear them so they re-ingest from the detail endpoint.
  8: async () => {
    await browser.storage.local.remove(['pvp_seen_ids', 'pvp_recent_reports']);
  },
  // v9: exp_resources_lost (combined expedition+wormhole ship-loss cost) split
  // into expedition_resources_lost/wormhole_resources_lost, per-kind — real
  // expedition events (pirate_ambush, fleet_lost) destroy ships too, not just
  // wormhole encounters. Rebuild recomputes both from the archives.
  9: async () => {
    await browser.storage.local.remove('exp_resources_lost');
    await rebuildAggregates();
  },
  // v10: expedition_totals/wormhole_totals (per-kind gain totals, for the
  // Global tab's source-share split) added alongside the combined exp_totals.
  // Rebuild backfills them for reports already marked seen.
  10: async () => {
    await rebuildAggregates(DEFAULT_UNIVERSE);
  },
  // v11: All storage keys are now universe-scoped (e.g. 's0:totals').
  // Copy existing unscoped keys (which are all s0 data) to 's0:' prefixed keys,
  // then remove the originals. Initialize nx:settings if not present.
  11: async () => {
    const U = DEFAULT_UNIVERSE;
    const all = await browser.storage.local.get(null);
    const patch = {};
    // Keys that stay global (no prefix).
    const GLOBAL = new Set(['schema_version', 'last_backup', 'records_cap', 'whatsnew_pending', SETTINGS_KEY]);
    for (const [k, v] of Object.entries(all)) {
      if (GLOBAL.has(k) || k.startsWith('nx:') || k.includes(':')) continue;
      patch[storeKey(U, k)] = v;
    }
    // Write scoped keys.
    if (Object.keys(patch).length) await browser.storage.local.set(patch);
    // Remove old unscoped keys.
    const toRemove = Object.keys(patch).map(k => k.replace(`${U}:`, ''));
    if (toRemove.length) await browser.storage.local.remove(toRemove);
    // Initialize universe settings if not present.
    const settingsRaw = await browser.storage.local.get(SETTINGS_KEY);
    if (!settingsRaw[SETTINGS_KEY]) {
      await browser.storage.local.set({
        [SETTINGS_KEY]: { universes: { [U]: { enabled: true, label: 'Standard', color: '#56d364' } } }
      });
    }
    console.log(`[NexusAccounting] v11 migration: ${Object.keys(patch).length} keys scoped to '${U}:'.`);
  },
};

async function ensureSchema() {
  const { schema_version } = await browser.storage.local.get('schema_version');
  const from = schema_version ?? 0;
  if (from >= SCHEMA_VERSION) return;

  for (let v = from + 1; v <= SCHEMA_VERSION; v++) {
    if (MIGRATIONS[v]) {
      console.log(`[NexusAccounting] Migrating storage to schema ${v}.`);
      await MIGRATIONS[v]();
    } else if (from !== 0) {
      // No migration path from this version — snapshot, then wipe and re-scrape.
      console.log(`[NexusAccounting] No migration to schema ${v}, resetting storage.`);
      try {
        await backupToDownloads('pre-schema-wipe');
      } catch (err) {
        console.warn('[NexusAccounting] Pre-wipe backup failed:', err);
      }
      const { records_cap } = await browser.storage.local.get('records_cap');
      await browser.storage.local.clear();
      if (records_cap !== undefined) await browser.storage.local.set({ records_cap });
      break;
    }
  }
  await browser.storage.local.set({ schema_version: SCHEMA_VERSION });
}

// ── Full scrape ────────────────────────────────────────────────────────────

// Iterates over all enabled universes and scrapes each one.
async function scrape() {
  const universes = await getEnabledUniverses();
  for (const u of universes) await scrapeUniverse(u);
}

async function scrapeUniverse(universe = DEFAULT_UNIVERSE) {
  const token = await getToken(universe);
  if (!token) {
    console.warn(`[NexusAccounting][${universe}] No token — log in to the game first.`);
    await browser.storage.local.set({ [storeKey(universe, 'last_error')]: 'Not logged in.' });
    return;
  }

  await ensureSchema();

  try {
    const planetId = await getHomePlanetId(token, universe);
    const [shipyardData, reportData, pirateData, spyData, campScoutData,
           miningData, expeditionData, wormholeData, xenoMessagesData, systemDebrisData, missionsData, researchData, pvpData, zones] = await Promise.all([
      apiFetch(`/api/planets/${planetId}/shipyard`, token, {}, universe).catch(() => null),
      apiFetch(REPORTS_PATH, token, {}, universe),
      apiFetch(PIRATES_PATH, token, {}, universe),
      apiFetch(SPY_PATH, token, {}, universe),
      apiFetch(CAMP_SCOUT_PATH, token, {}, universe),
      apiFetch(MINING_PATH, token, {}, universe).catch(() => ({ reports: [] })),
      apiFetch(EXPEDITION_PATH, token, {}, universe).catch(() => ({ reports: [] })),
      apiFetch(WORMHOLE_PATH, token, {}, universe).catch(() => ({ runs: [] })),
      apiFetch(`${XENO_MESSAGES_PATH}?page=1`, token, {}, universe).catch(() => ({ notifications: [] })),
      apiFetch(SYSTEM_DEBRIS_PATH, token, {}, universe).catch(() => ({ debris: [] })),
      apiFetch(MISSIONS_PATH, token, {}, universe).catch(() => ({ missions: [] })),
      apiFetch(RESEARCH_PATH, token, {}, universe).catch(() => ({ research: [] })),
      apiFetch(PVP_PATH, token, {}, universe).catch(() => ({ reports: [] })),
      getSystemZones(token, universe),
    ]);

    const [campZones, wormholeZones] = await Promise.all([
      getCampZones(token, zones, universe),
      getWormholeZones(token, zones, universe),
    ]);
    const wcKey = storeKey(universe, 'wormhole_classes');
    const zbKey = storeKey(universe, 'system_zone_by_id');
    const aux = await browser.storage.local.get([wcKey, zbKey]);
    const wormholeClasses = aux[wcKey];
    const zoneById = aux[zbKey];

    await enqueue(async () => {
      const shipsKey = storeKey(universe, 'ships');
      let ships;
      if (shipyardData) {
        ships = buildShipCatalog(shipyardData);
        await browser.storage.local.set({ [shipsKey]: ships });
      } else {
        ships = (await browser.storage.local.get(shipsKey))[shipsKey] || {};
      }
      await backfillZones(zones, campZones, wormholeZones, universe);
      const nSurveys = await processSurveyReports(reportData.reports || [], ships, zones, universe);
      const nPirates = await processPirateReports(pirateData.reports || [], ships, campZones, universe);
      const nMining = await processMiningReports(miningData.reports || [], ships, zones, universe);
      await processExpeditionReports(expeditionData.reports || [], wormholeData.runs || [], ships, zones, wormholeZones, wormholeClasses || {}, universe);
      await processXenoReports(xenoMessagesData.notifications || [], universe);
      await processSystemDebris(systemDebrisData.debris || [], zones, universe);
      await processMissions(missionsData.missions || [], zoneById || {}, ships, universe);
      await browser.storage.local.set({
        [storeKey(universe, 'research')]: researchData.research || [],
        [storeKey(universe, 'research_speed_mult')]: researchData.researchSpeedMult || 1,
        [storeKey(universe, 'active_research')]: researchData.activeResearches || (researchData.activeResearch ? [researchData.activeResearch] : []),
      });
      await processSpyReports(spyData.reports || [], universe);
      await processCampScoutReports(campScoutData.reports || [], universe);
      await processPvpReports(pvpData.reports || [], universe);
      await checkDrift(universe);
      console.log(`[NexusAccounting][${universe}] Scraped ${nSurveys} surveys, ${nPirates} pirate, ${nMining} mining reports.`);
    });
    await maybeAutoBackup();
  } catch (err) {
    console.error(`[NexusAccounting][${universe}] Scrape failed:`, err);
    if (err.message?.includes('→ 404')) await browser.storage.local.remove(storeKey(universe, 'planet_id'));
    await browser.storage.local.set({ [storeKey(universe, 'last_error')]: err.message });
  }
}

// ── Realtime intercept (observe + re-fetch) ────────────────────────────────
// MV3 has no response-body reading (Chrome dropped blocking webRequest;
// Firefox's StreamFilter is MV2-only), so we OBSERVE when the game itself
// calls a report endpoint and then re-fetch that same endpoint to pick up the
// new data. Works identically on Chrome and Firefox; costs one extra request
// per change. Still near-realtime — the dashboard updates seconds after you
// open a report in game.

// Wildcard URLs catch all universe subdomains for realtime interception.
const WATCHED_URLS = [
  'https://*.nexuslegacy.space/api/fleet/survey-reports*',
  'https://*.nexuslegacy.space/api/fleet/pirate-reports*',
  'https://*.nexuslegacy.space/api/fleet/reports*',
  'https://*.nexuslegacy.space/api/fleet/spy-reports*',
  'https://*.nexuslegacy.space/api/fleet/camp-scout-reports*',
  'https://*.nexuslegacy.space/api/fleet/mining-reports*',
  'https://*.nexuslegacy.space/api/fleet/expedition-reports*',
  'https://*.nexuslegacy.space/api/fleet/wormhole-runs*',
  'https://*.nexuslegacy.space/api/messages/system*',
  'https://*.nexuslegacy.space/api/fleet/system-debris*',
  'https://*.nexuslegacy.space/api/fleet/missions*',
  'https://*.nexuslegacy.space/api/research*',
  'https://*.nexuslegacy.space/api/planets/*/shipyard*',
];

// Best-effort debounce so a burst of game calls to the same endpoint triggers
// one re-fetch. Module scope resets if the service worker sleeps, which only
// risks an extra (deduped) re-fetch — harmless.
const refetchPending = new Set();

// webRequest is available in Chrome MV3 service workers for observation (not blocking).
// Guard in case the current browser/version does not support it.
if (browser.webRequest?.onCompleted?.addListener) {
  browser.webRequest.onCompleted.addListener(
    details => {
      if (details.tabId === -1) return;
      if (details.statusCode < 200 || details.statusCode >= 300) return;
      const url = new URL(details.url);
      const path = url.pathname;
      const universe = url.hostname.split('.')[0] || DEFAULT_UNIVERSE;
      const cacheKey = `${universe}:${path}`;
      if (refetchPending.has(cacheKey)) return;
      refetchPending.add(cacheKey);
      setTimeout(() => refetchPending.delete(cacheKey), 3000);
      refetchEndpoint(path, universe);
    },
    { urls: WATCHED_URLS }
  );
}

async function refetchEndpoint(path, universe = DEFAULT_UNIVERSE) {
  const token = await getToken(universe);
  if (!token) return;
  let json;
  try {
    json = await apiFetch(path, token, {}, universe);
  } catch {
    return;
  }
  routeIntercepted(path, json, universe);
}

function routeIntercepted(path, json, universe = DEFAULT_UNIVERSE) {
  const sk = k => storeKey(universe, k);
  enqueue(async () => {
    if (path.includes('/shipyard')) {
      await browser.storage.local.set({ [sk('ships')]: buildShipCatalog(json) });
      return;
    }
    if (path.includes('/spy-reports')) {
      await processSpyReports(json.reports || [], universe);
      return;
    }
    if (path.includes('/camp-scout-reports')) {
      await processCampScoutReports(json.reports || [], universe);
      return;
    }
    if (path.includes('/messages/system')) {
      await processXenoReports(json.notifications || [], universe);
      return;
    }
    if (path.includes('/api/fleet/reports')) {
      await processPvpReports(json.reports || [], universe);
      return;
    }
    if (path.includes('/system-debris')) {
      const raw = await browser.storage.local.get(sk('system_zones'));
      await processSystemDebris(json.debris || [], raw[sk('system_zones')] || {}, universe);
      return;
    }
    if (path.includes('/missions')) {
      const zbKey = sk('system_zone_by_id'), shKey = sk('ships');
      const aux = await browser.storage.local.get([zbKey, shKey]);
      await processMissions(json.missions || [], aux[zbKey] || {}, aux[shKey] || {}, universe);
      return;
    }
    if (path.includes('/api/research')) {
      await browser.storage.local.set({
        [sk('research')]: json.research || [],
        [sk('research_speed_mult')]: json.researchSpeedMult || 1,
        [sk('active_research')]: json.activeResearches || (json.activeResearch ? [json.activeResearch] : []),
      });
      return;
    }
    const szKey = sk('system_zones'), czKey = sk('camp_zones'), wzKey = sk('wormhole_zones'), wcKey = sk('wormhole_classes'), shKey = sk('ships');
    const aux = await browser.storage.local.get([szKey, czKey, wzKey, wcKey, shKey]);
    const ships = aux[shKey];
    if (!ships) return;
    const zones = aux[szKey] || {};
    const wz = aux[wzKey] || {};
    const wc = aux[wcKey] || {};
    let n = 0;
    if (path.includes('/survey-reports')) n = await processSurveyReports(json.reports || [], ships, zones, universe);
    else if (path.includes('/pirate-reports')) n = await processPirateReports(json.reports || [], ships, aux[czKey] || {}, universe);
    else if (path.includes('/mining-reports')) n = await processMiningReports(json.reports || [], ships, zones, universe);
    else if (path.includes('/expedition-reports')) n = await processExpeditionReports(json.reports || [], [], ships, zones, wz, wc, universe);
    else if (path.includes('/wormhole-runs')) n = await processExpeditionReports([], json.runs || [], ships, zones, wz, wc, universe);
    if (n) console.log(`[NexusAccounting][${universe}] Realtime: ${n} new reports from ${path}`);
  });
}

// Exposed for the node test harness (tests/processors.test.js).
export {
  processSurveyReports, processPirateReports, processMiningReports,
  processPvpReports,
  processExpeditionReports, processSystemDebris, rebuildAggregates,
  checkDrift, ensureSchema, appendToArchive, loadArchive,
  systemFromLocation, resolveZone, backfillZones, processMissions,
  fieldMatches, purgeOldData,
};
