### SOVEREIGN NODE v1.0.0 — UNIFIED SYSTEM
#### BUILD: 1.0.0-NEXUS
**Date:** 04/29/2026

---

### [INTEGRATION — Bridge-v2 + BrainOS unified]

Merges Bridge-v2's identity/security/behavioral stack with BrainOS's
operational/network/visualization layer into a single sovereign node.

**Architecture:**
```
Guardian (Firefox)          CFR (browser, file://)
    ↓ WS                        ↓ POST /pulse, GET /nodes
bridge-plugin            bridge-node HTTP :3747
    ↓                           ↓
bridge-data → bridge-sngate ← bridge-IME ← bridge-causal
    ↓                                           ↑
bridge-mesh ─ trust-mesh                   causal-nexus
    ↓                                       (1M ring buf)
bridge-heartbeat ← bridge-magnet ← nexus:// resolution
    ↓
bridge-identity (Ed25519, UUID=SHA256(pubKey))
```

**New modules in this build:**
- `bridge-appid` — AppID registry, one-time trust codes, nexus:// URI generation, session tokens
- `bridge-magnet` — nexus:// 7-level resolution cascade (from BrainOS)
- `bridge-ddns` — DDNS client + DNS server (from BrainOS)
- `bridge-bayesian` — Beta(α,β) belief engine with temporal decay (from BrainOS)
- `bridge-ollama` — Local LLM driver, Ollama-backed (from BrainOS)

**AppID + Trust Code flow:**
```
POST /appid/create { appId: 'guardian' }
→ { code: 'nxt-7k3p-xm9q', uri: 'nexus://8db800b3?code=nxt-7k3p-xm9q&appId=guardian&ttl=300' }

POST /appid/redeem { code: 'nxt-7k3p-xm9q', appId: 'guardian' }
→ { token: 'stk-...', capabilities: ['callto','listener','bus','dom'], expiresAt: '...' }

POST /appid/session { token: 'stk-...' }
→ { ok: true, appId: 'guardian', capabilities: [...] }
```

**CFR integration:**
```
POST /pulse { instanceId: 'cfr-main', logicalId: 'cfr.visualizer', nodeCount: 30000, fps: 52 }
GET  /nodes → peer list with CFR attribute mapping
```

**Unified boot — 10 phases:**
Phase 0: contracts → Phase 1: identity → Phase 2: core+appid →
Phase 3: IME → Phase 4: sngate → Phase 5: data+bus →
Phase 6: heartbeat → Phase 7: plugin → Phase 7b: eros →
Phase 7c: mesh+trust+magnet → Phase 8: causal →
Phase 9: bayesian+ollama+routing+gateway+canvas → Phase 10: HTTP

**Single entry point:** `node index.js`

**Open flags inherited:** FLAG-001 through FLAG-005 (see MANIFEST.json)

---
