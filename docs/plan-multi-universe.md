# Plan: Multi-Universe Support (s0 + nf, erweiterbar)

## TL;DR
Universen sind vollständig unabhängig — getrenntes Storage, getrennte Fleet-Templates, Tech Tree, Live-Search, Export/Import und Notifications. Kein Universum ist erzwungen (jemand kann nur nf spielen). Zweite Tab-Leiste im Dashboard zur Umschaltung. Erweiterbar auf beliebige neue Universen ohne Manifest-Änderungen.

## Phase 1 — Storage-Scoping & Universe-Erkennung

1. `common.js`: `universeKey(hostname)` Helper extrahiert Subdomain aus `window.location.hostname`
2. `storeKey(universe, key)` Helper: gibt `'s0:totals'` zurück — wird überall statt blankem Key verwendet
3. Einmalige Migration in `background.js` `onInstalled`: alle bestehenden ungescopten Keys nach `s0:` kopieren, alte löschen
4. Alle Storage-Zugriffe in background.js, dashboard.js, tabs/*.js aktualisieren
5. localStorage-Keys in galaxy-fields.js, sidebar-inject.js, common.js mit Universe-Präfix versehen
6. Universe-Settings als globaler ungescopter Key `nx:settings`:
   ```json
   {
     "universes": {
       "s0": { "enabled": true, "label": "Standard", "color": "#56d364" },
       "nf": { "enabled": false, "label": "NF", "color": "#79c0ff" }
     },
     "activeUniverse": null
   }
   ```
   Kein Standard-Universum erzwungen — `activeUniverse` wird auf das erste aktivierte gesetzt.

## Phase 2 — Manifest & Content Scripts *(parallel mit Phase 1)*

7. `manifest.json`: Alle 10 Match-Patterns von `https://s0.nexuslegacy.space/*` auf `https://*.nexuslegacy.space/*`
8. `web_accessible_resources`: Match ebenfalls auf `*.nexuslegacy.space` erweitern
9. `sidebar-inject.js`: Guard-Check (`nav.sidebar-nav` vorhanden?) bevor Injektion startet
10. `galaxy-fetch-hook.js`: `universe: window.location.hostname.split('.')[0]` in postMessage mitsenden

## Phase 3 — background.js Multi-Universe-Polling *(depends on Phase 1)*

11. `GAME_URL` ersetzen durch `gameUrl(universe)` → `` `https://${universe}.nexuslegacy.space` ``
12. Alarm-Handler: iteriert über alle `enabled` Universen aus `nx:settings`, ruft `scrapeUniverse(universe)` für jedes auf
13. `scrapeUniverse(universe)`: bestehender Scrape-Flow als Funktion mit Universe-Parameter, nutzt `storeKey(universe, ...)`
14. Tab-Queries: `'*://s0.nexuslegacy.space/*'` → `'*://*.nexuslegacy.space/*'`

## Phase 4 — Dashboard Universe Tab Bar *(depends on Phase 1+3)*

15. `dashboard.html`: `<div id="universe-bar">` direkt über der bestehenden Tab-Leiste, ein Button pro aktiviertem Universum mit Farb-Badge
16. `dashboard.js`: `activeUniverse` State; Universe-Wechsel ruft `loadAll(universe)` dann `renderAll()` auf
17. `loadAll(universe)`: alle `browser.storage.local.get(...)` mit `storeKey(universe, key)`
18. Status Bar: Scrape-Zeit + Fehler pro Universum nebeneinander (z.B. `s0: vor 12 min | nf: vor 3 min`)
19. `dashboard.css`: `.universe-tab` Styling mit farbiger linker Border / Badge, aktiver Tab hervorgehoben

## Phase 5 — Vollständige Datentrennung: Fleet Templates + Tech Tree *(depends on Phase 1)*

20. Fleet Templates (`store.fleets`): Key wird `storeKey(universe, 'fleets')` — Templates vollständig getrennt pro Universum, keine globale Sharing-Logik
21. Tech Tree (`store.research`, `active_research`, `tt_queue_targets`, `research_speed_mult`): alle 4 Keys universe-scoped — Forschungsstand und Queue komplett unabhängig

## Phase 6 — Universe Badge & Notifications *(depends on Phase 3)*

22. Alle `browser.notifications.create()` in background.js: Titel-Präfix `[s0]` / `[nf]` basierend auf Universe des Events
23. Live-Search (`live_search` Key): universe-scoped → `s0:live_search`, `nf:live_search` — separate Filterprofile pro Universum
24. Dashboard Status Bar: farbiger Universe-Punkt neben Scrape-Zeit

## Phase 7 — Per-Universe Export/Import *(depends on Phase 5)*

25. Export-Button: Dropdown "Alle Universen / Nur s0 / Nur nf" — JSON enthält nur Keys des gewählten Universums, Dateiname `nexus-export-s0-{datum}.json`
26. Import: erkennt anhand Key-Präfixe welchem Universum Daten gehören; zeigt Warnung wenn Universe nicht aktiviert
27. "Reset Universe Data"-Button: löscht alle `{universe}:*` Keys, mit `confirmDialog()` Bestätigung

## Phase 8 — Settings Tab *(depends on Phase 6+7)*

28. Neuer "Settings"-Tab (16. Tab) im Dashboard:
    - Checkboxen: Universen aktivieren/deaktivieren (keines erzwungen)
    - Label + Color-Input pro Universum
    - "Add Universe"-Freitext-Feld (Subdomain) für neue Universen ohne Extension-Update
    - "Reset Universe Data"-Button pro Universum
    - Export/Import-Buttons pro Universum

## Relevante Dateien

| Datei | Phasen |
|---|---|
| `nexus-addon/manifest.json` | Phase 2 |
| `nexus-addon/background.js` | Phase 1, 3, 6 |
| `nexus-addon/common.js` | Phase 1 |
| `nexus-addon/dashboard.html` | Phase 4, 8 |
| `nexus-addon/dashboard.js` | Phase 4 |
| `nexus-addon/dashboard.css` | Phase 4 |
| `nexus-addon/sidebar-inject.js` | Phase 1, 2 |
| `nexus-addon/galaxy-fetch-hook.js` | Phase 2 |
| `nexus-addon/galaxy-fields.js` | Phase 1 |
| `nexus-addon/tabs/fleets.js` | Phase 5 |
| `nexus-addon/tabs/techtree.js` | Phase 5 |
| `nexus-addon/tabs/*.js` | Phase 1 |

## Verifikation

1. Extension laden mit Bestandsdaten → alle s0-Daten erscheinen unverändert (Migration korrekt)
2. Settings: nur nf aktivieren, s0 deaktivieren → Dashboard zeigt nur nf-Tab, kein Fehler
3. Asteroid-Notification erscheint mit `[nf]` Präfix wenn von nf-Universum
4. Fleet Templates und Tech Tree getrennt: Änderungen in s0 erscheinen nicht in nf
5. Export "Nur nf" → JSON enthält ausschließlich `nf:*` Keys
6. Import von s0-Export in nf-aktivierter Extension → Warnung erscheint
7. "Add Universe" mit neuem Subdomain → funktioniert ohne Manifest-Update

## Entscheidungen

- Wildcard `*.nexuslegacy.space` im Manifest (nicht dynamisch per scripting API)
- Flat Key-Schema `s0:totals` statt nested Objects — minimaler Umbau
- Einmalige Migration bei `onInstalled` — kein Datenverlust für Bestandsnutzer
- Kein Standard-Universum erzwungen — `activeUniverse: null` bis User eines aktiviert
- Cross-Universe-Aggregat-View ausgeklammert (MVP)
