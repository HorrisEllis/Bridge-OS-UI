## v3.2.0 — Killswitch fix, element zoom, listener log
**Date:** 2026-04-20

### Fixed
- KILLSWITCH no longer freezes extension — removed confirm() dialog which blocks
  Firefox extension popup event loop
- Double-tap killswitch: single tap = stop UI listeners only, double within 1.5s = 
  FULL killswitch (all listeners + bridge + pulse terminated)
- Button shows '⚠ AGAIN = FULL' after first tap, reverts after 1.5s

### Added
- Element picker zoom controls: ↑ PARENT / ↓ CHILD / ← PREV / → NEXT
- Breadcrumb depth indicator in callto popup (body › div#app › button)
- Nearby suggestions: auto-detects interactive elements within 120px, shown as chips
- Listener event log: ring buffer 500 events/listener, per-listener
- Listener log panel in LISTEN modal: last 40 events, timestamp + type + value
- Export log button: downloads guardian-listener-{ts}.json
- Clear log button
- FORCE_DISCONNECT message handler in background.js

---
## v3.1.0 — Integration Guide + Nexus v0.41.0 Sync
**Release Date:** 2026-04-20

### New
- Chapter 16: Integration Guide — how to add endpoints for Forge, Eravos, any system
- Documents all 8 files to update, full code examples, token lifecycle, instanceId format
- Forge + Eravos integration patterns with complete fetch code
- Reference table of all 30+ active bridge endpoints
- Common mistakes section

### Updated
- guardian-docs.html: 16 chapters (was 15)
- All instanceId examples use correct `guardian-{uuid}` format with hyphen separator
- Multi-instance coordination correctly described as registry-mediated, not peer-to-peer
- Mesh route description corrected

---
# GUARDIAN v3.0.0 — CHANGELOG

## Architecture Upgrade: URCK → Causal-Nexus + IR Layer

### PHASE 0 — Foundation

#### IR Layer (ir-layer.js) — NEW
The core new system. Every callto dispatch goes through here. No bypassing.

**RouteSpec engine:**
- `nexus` — POST to Nexus /ingest with full ACK
- `local` — Persistent browser.storage (not sessionStorage — golden rule)
- `mesh` — Broadcast to all discovered pulse nodes
- `device` — Route to specific node by instanceId
- `analyze` — URCK kernel only, no outbound
- `pipeline` — Sequential multi-step execution
- `conditional` — Rule-based routing with fallback
- `custom` — User-registered function hook

**Callto packet schema:**
```ts
{
  id, source, instanceId, intent,
  route: RouteSpec,
  delivery: DeliveryMode,
  payload, fingerprint,
  state: CalltoState,    // CREATED → ROUTED → DISPATCHED → IN_TRANSIT → ACKNOWLEDGED → STORED → ARCHIVED → FAILED
  createdAt, ttl,
  retryCount, routeTrace
}
```

**Retry queue:**
- Backoff: 1s → 5s → 15s → 60s
- Max 4 attempts, then FAILED (loud)
- No silent drops

**Pulse / Heartbeat system:**
- instanceId = `guardian-{uuid}` (multi-instance safe on same network)
- Emits every 1500ms to Nexus /pulse
- Nexus ACKs with current node list
- Stale after 10s, dead/removed after 30s

#### background.js — REWRITTEN
- URCK events now ingested as `guardian.*` causal events (Causal-Nexus protocol)
- All callto dispatch routes through IR.execute()
- Manual node registry: add/remove/probe via browser.storage
- New message handlers: IR_ROUTE, GET_IR_STATS, GET_DISCOVERED_NODES, ADD_MANUAL_NODE, REMOVE_MANUAL_NODE, PROBE_NODE
- Heartbeat now sends `instanceId` + `irStats` to bridge

### PHASE 1 — Routing Engine

#### Route Selector Bar (popup.html) — NEW
Persistent bar above tabs. Selects RouteSpec before dispatch:
- 📡 Nexus
- 📡+💾 Nexus + Local backup (pipeline)
- 💾 Local only
- 🔁 Broadcast mesh
- 🧠 Analyze only
- 🧠→📡 Analyze then Nexus (pipeline)
- ⚙ Conditional (rules: claude.ai→nexus, confidence<0.6→local)

Route is attached to every callto that goes through IR.execute().

### PHASE 2 — Devices Tab Rebuild

#### Devices Tab — FULL REBUILD
Old: static node list from bridge /nodes
New: live connection management system

**This Node card:**
- Displays instanceId, bridgeUrl, nexusUrl
- Pulse status with live dot animation

**Pulse Scanner:**
- Animated sonar ring during scan
- Scan log with timestamps (colored: ok/err/info)
- Probes localhost ports: 3747, 3748, 3749, 3750, 4747, 4748, 8080, 8747
- Probes all manual nodes on scan
- Updates node registry

**Connections list:**
- Combined discovered + manual nodes
- Per-node: status dot, logicalId, intent tag, ip:port, age, capabilities
- Manual nodes: bordered in purple, have REMOVE button
- Online nodes: PIPE + CALLTO actions

**Add Manual Connection:**
- Collapsible form (+ ADD button)
- Fields: Label, IP, Port, Intent (nexus/guardian/mesh/custom)
- Probes node on connect, shows real status
- Persisted in browser.storage (golden rule: persistence)

### PHASE 3 — Nexus Bridge

#### nexus-guardian-bridge.js — v3 UPGRADE
New endpoints:
- `POST /pulse` — receives IR layer pulse, upserts node registry, ACKs with nodes list
- `GET /pulse` — probe endpoint returns node info (used by scanner)
- `POST /ingest` — full Causal-Nexus callto ingestion with ACK schema
- `GET /nodes` — returns all online nodes
- `GET /ingest/recent` — query HOT tier

`/ingest` ACK schema:
```json
{
  "ok": true,
  "calltoId": "...",
  "received": true,
  "stored": true,
  "indexed": true,
  "tier": "hot",
  "serverTs": 1234567890,
  "routePath": ["guardian", "nexus"]
}
```

## Files Changed

| File | Status | What Changed |
|------|--------|-------------|
| `ir-layer.js` | **NEW** | RouteSpec engine, pulse system, retry queue, conditional routing |
| `background.js` | Rewritten | IR Layer integration, manual nodes, IR_ROUTE handler, pulse init |
| `popup.html` | Rewritten | Route selector bar, IR status card, Devices tab full rebuild |
| `popup.js` | Rewritten | Route selector wiring, Devices tab logic, scan system, manual connection |
| `nexus-guardian-bridge.js` | Upgraded | /pulse, /ingest, /nodes, node registry, Causal-Nexus ACK |
| `manifest.json` | Updated | v3.0.0, ir-layer.js added to background scripts |

## Files Unchanged
`urck.js`, `bridge-sync.js`, `content.js`, `modules/*`

## Invariants Enforced
- All state persistent (browser.storage.local) or explicitly temporary
- Nothing pretends to work — all routes fail loudly with reason
- No direct module-to-module — everything via IR/event bus
- Everything has UUID + instanceId
- ACK protocol on all Nexus ingestion
- Retry queue with backoff (no silent drops)
- Pulse heartbeat with node expiry (stale → dead → removed)
